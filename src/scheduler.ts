// Cron tick (every minute): probe a bounded slice of due monitors directly (oldest-checked-first),
// store results and evaluate alerts; also hosts heartbeat evaluation, rollups and cleanup. Checks run
// in cron (not via Queues) because the Free Queues tier caps at 10k ops/day — fewer than a handful of
// 1-min monitors would need. Per-tick CPU is bounded by MAX_CHECKS_PER_RUN, not by monitor count.
import { CONNECTIVITY_CLASS, evaluateAlerts, storeHeartbeatMiss, storeResult } from './alerts';
import { MAX_CHECKS_PER_RUN, MAX_CONCURRENT_CHECKS } from './limits';
import { log } from './log';
import { dnsCheck, httpCheck, sslProbe, tcpCheck } from './probes';
import { schedulerStaleness } from './staleness';
import type { ActiveIncident, ActiveIncidentRow, AlertRuleDbRow, MonitorRow, NotificationMessage, ProbeResult, RuntimeEnv, VpcBinding } from './types';

// Per-check hard timeout (probe timeouts are 10s; this is the outer safety net).
const PER_UNIT_MS = 20_000;

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// PROBE_HEADERS is a generated, deploy-time Worker var: a JSON map of monitor id → custom HTTP probe
// headers with ${VAR} placeholders preserved. Parsed once per tick; a missing/malformed value yields
// an empty map (no monitor gets custom headers) rather than failing the whole run.
function parseProbeHeaders(raw: string | undefined): Map<string, Record<string, string>> {
	const map = new Map<string, Record<string, string>>();
	if (!raw) return map;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		for (const [id, headers] of Object.entries(parsed)) {
			if (headers && typeof headers === 'object') map.set(id, headers as Record<string, string>);
		}
	} catch {
		log('warn', 'probe_headers.parse_failed', {});
	}
	return map;
}

// Resolves ${VAR} placeholders in custom probe headers against env (Worker secrets). Throws on the
// first header referencing an unset/empty secret so the caller can fail the check — unlike notify.ts
// resolveVars (which silently substitutes ''), we must never send a literal ${VAR} to the target.
export function resolveProbeHeaders(env: Env, raw: Record<string, string>): Record<string, string> {
	const lookup = env as unknown as Record<string, string | undefined>;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		resolved[key] = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
			const v = lookup[name];
			if (!v) throw new Error(`header "${key}" references unset secret ${name}`);
			return v;
		});
	}
	return resolved;
}

// Runs tasks with at most `limit` in flight: starts tasks eagerly and, once the window is
// full, awaits the next completion (whichever it is) before starting another.
async function runWithLimit(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
	const active = new Set<Promise<void>>();
	for (const task of tasks) {
		const p: Promise<void> = task().then(
			() => { active.delete(p); },
			() => { active.delete(p); },
		);
		active.add(p);
		if (active.size >= limit) await Promise.race(active);
	}
	await Promise.allSettled(active);
}

// Resolves a monitor's mode: internal VPC binding from env by name (Issue #18). Returns the binding,
// or an error string when it is missing/unusable — the caller records a down result without probing
// (so a misconfiguration never throws and never leaks onto the public network). External monitors
// pass through unchanged.
function resolveVpcBinding(env: Env, monitor: { mode: string; vpc_binding: string | null }): { binding?: VpcBinding; error?: string } {
	if (monitor.mode !== 'internal') return {};
	const name = monitor.vpc_binding;
	if (!name) return { error: 'internal monitor has no vpc_binding configured' };
	const candidate = (env as unknown as Record<string, unknown>)[name] as VpcBinding | undefined;
	if (!candidate || typeof candidate.fetch !== 'function' || typeof candidate.connect !== 'function') {
		return { error: `VPC binding "${name}" is not available on the Worker — check deploy.vpc and redeploy` };
	}
	return { binding: candidate };
}

// Adapts a VPC binding's string-address connect() to the {hostname,port} signature tcpCheck expects.
function vpcConnector(binding: VpcBinding): (address: { hostname: string; port: number }) => Socket {
	return ({ hostname, port }) => binding.connect(`${hostname}:${port}`);
}

async function runExternalCheck(
	monitor: MonitorRow & { mode: string; last_success_at: string | null },
	env: Env,
	now: string,
	rules: AlertRuleDbRow[],
	activeByClass: Map<string, ActiveIncident>,
	probeHeaders?: Record<string, string>,
): Promise<void> {
	const executionId = crypto.randomUUID();
	let sslHostname: string | null = null;
	if (monitor.ssl_check === 1 && monitor.scrape_url) {
		if (monitor.scrape_url.startsWith('https://')) {
			sslHostname = new URL(monitor.scrape_url).hostname;
		} else if (monitor.type === 'tcp') {
			sslHostname = monitor.scrape_url.split(':')[0] ?? null;
		}
	}
	const doSslProbe = sslHostname !== null;

	// Resolve custom HTTP headers up front: a missing secret fails the check WITHOUT probing, so the
	// literal ${VAR} placeholder never reaches the target (and no SSL probe is wasted either).
	let resolvedHeaders: Record<string, string> | undefined;
	let headerError: string | undefined;
	if (monitor.type === 'http' && probeHeaders) {
		try {
			resolvedHeaders = resolveProbeHeaders(env, probeHeaders);
		} catch (err) {
			headerError = err instanceof Error ? err.message : String(err);
		}
	}

	// mode: internal monitors probe through a Workers VPC binding instead of public networking. A
	// missing/unusable binding fails the check up front (like a missing header secret) — never probed.
	const { binding: vpcBinding, error: bindingError } = resolveVpcBinding(env, monitor);
	const fetcher = vpcBinding ? vpcBinding.fetch.bind(vpcBinding) : undefined;
	const connector = vpcBinding ? vpcConnector(vpcBinding) : undefined;

	const preError = headerError ?? bindingError;
	let result: ProbeResult;
	let sslInfo: { daysLeft: number; notAfter: string; issuer: string } | null = null;
	if (preError) {
		result = { status: 'down', latency_ms: 0, error: preError };
	} else {
		[result, sslInfo] = await Promise.all([
			monitor.type === 'tcp' ? tcpCheck(monitor.scrape_url!, connector) :
			monitor.type === 'dns' ? dnsCheck(monitor.scrape_url!) :
			httpCheck(monitor.scrape_url!, monitor.ssl_check === 1, resolvedHeaders, fetcher),
			doSslProbe ? sslProbe(sslHostname!) : Promise.resolve(null),
		]);
	}
	if (sslInfo) {
		result.ssl_days_left = sslInfo.daysLeft;
		result.ssl_not_after = sslInfo.notAfter;
		result.ssl_issuer = sslInfo.issuer;
	}
	const { newFailures, newSuccesses } = await storeResult(env, monitor, result, executionId, now);
	await evaluateAlerts(env, monitor, result, newFailures, newSuccesses, now, rules, activeByClass);

	if (result.status === 'down') {
		log('warn', 'check.failed', { monitorId: monitor.id, type: monitor.type, error: result.error, latencyMs: result.latency_ms });
	} else {
		log('debug', 'check.ok', { monitorId: monitor.id, latencyMs: result.latency_ms, tcpConnectMs: result.tcp_connect_ms });
	}
}

export async function handleScheduled(env: Env): Promise<void> {
	const now = new Date().toISOString();
	const t0 = Date.now();
	const probeHeadersById = parseProbeHeaders((env as RuntimeEnv).PROBE_HEADERS);

	// Single query for all monitors + preload all alert rules + open incidents + active maintenance
	// windows — avoids N+2 DB round-trips per cron run
	const [{ results: allMonitors }, { results: allRules }, { results: openIncidents }, { results: activeMaintenance }] = await Promise.all([
		env.DB.prepare(
			`SELECT m.id, m.name, m.type, m.mode, m.scrape_url, m.interval_seconds, m.created_at,
			        COALESCE(m.ssl_check, 1) AS ssl_check, m.vpc_binding,
			        ms.status AS current_status, ms.last_check_at, ms.last_success_at,
			        COALESCE(ms.consecutive_failures, 0) AS consecutive_failures,
			        COALESCE(ms.consecutive_successes, 0) AS consecutive_successes,
			        ms.active_incident_id,
			        ms.ssl_not_after, ms.ssl_issuer
			 FROM monitors m
			 LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
			 WHERE m.enabled = 1 AND m.paused = 0`,
		).all<MonitorRow & { mode: string; last_success_at: string | null; created_at: string }>(),
		env.DB.prepare(
			`SELECT id, monitor_id, metric_name, condition, threshold, severity,
			        failure_count, recovery_count, cooldown_seconds, enabled
			 FROM alert_rules WHERE enabled = 1 ORDER BY monitor_id, failure_count ASC`,
		).all<AlertRuleDbRow>(),
		env.DB.prepare(
			`SELECT i.monitor_id, COALESCE(ar.metric_name, '${CONNECTIVITY_CLASS}') AS class,
			        i.id AS incident_id, i.severity
			 FROM incidents i
			 LEFT JOIN alert_rules ar ON ar.id = i.alert_rule_id
			 WHERE i.status = 'open'`,
		).all<ActiveIncidentRow>(),
		// Currently-active maintenance windows + their affected monitors (NULL monitor_id = global).
		env.DB.prepare(
			`SELECT mwm.monitor_id
			 FROM maintenance_windows mw
			 LEFT JOIN maintenance_window_monitors mwm ON mwm.window_id = mw.id
			 WHERE mw.enabled = 1 AND mw.starts_at <= ? AND mw.ends_at > ?`,
		).bind(now, now).all<{ monitor_id: string | null }>(),
	]);

	// A row with a NULL monitor_id is a global window → every monitor is under maintenance this tick.
	const maintenanceMonitorIds = new Set<string>();
	let globalMaintenance = false;
	for (const row of activeMaintenance) {
		if (row.monitor_id === null) globalMaintenance = true;
		else maintenanceMonitorIds.add(row.monitor_id);
	}
	const underMaintenance = (monitorId: string) => globalMaintenance || maintenanceMonitorIds.has(monitorId);

	const rulesByMonitor = new Map<string, AlertRuleDbRow[]>();
	for (const r of allRules) {
		const list = rulesByMonitor.get(r.monitor_id) ?? [];
		list.push(r);
		rulesByMonitor.set(r.monitor_id, list);
	}

	// monitor_id → (metric class → open incident). Source of truth for incident gating this tick.
	const activeByMonitor = new Map<string, Map<string, ActiveIncident>>();
	for (const inc of openIncidents) {
		let byClass = activeByMonitor.get(inc.monitor_id);
		if (!byClass) {
			byClass = new Map();
			activeByMonitor.set(inc.monitor_id, byClass);
		}
		byClass.set(inc.class, { id: inc.incident_id, severity: inc.severity });
	}

	// Pull-probed monitors of any mode: external (public networking) and internal (Workers VPC binding).
	// Heartbeat (push) monitors are handled separately below.
	const dueChecks = allMonitors.filter(
		(m) =>
			['http', 'tcp', 'dns'].includes(m.type) &&
			// Skip monitors under an active maintenance window: no probe → no incident, uptime unaffected.
			!underMaintenance(m.id) &&
			(!m.last_check_at ||
				new Date(m.last_check_at).getTime() + m.interval_seconds * 1000 <= Date.now()),
	);

	// Oldest-checked first so that, when more than MAX_CHECKS_PER_RUN are due, no monitor starves.
	// last_check_at is ISO 8601 (lexicographically ordered); never-checked (null → '') sort first.
	dueChecks.sort((a, b) => (a.last_check_at ?? '').localeCompare(b.last_check_at ?? ''));

	// Probe a bounded slice directly this tick (network wait costs ~no Worker CPU; the cap bounds the
	// JS work — JSON/D1/alerts — that does). The rest roll over to later ticks via oldest-first order.
	await runWithLimit(
		dueChecks.slice(0, MAX_CHECKS_PER_RUN).map((monitor) => () =>
			Promise.race([
				runExternalCheck(monitor, env, now, rulesByMonitor.get(monitor.id) ?? [], activeByMonitor.get(monitor.id) ?? new Map(), probeHeadersById.get(monitor.id)),
				wait(PER_UNIT_MS).then(() => Promise.reject(new Error(`timed out after ${PER_UNIT_MS / 1000}s`))),
			]).catch((err: unknown) =>
				log('error', 'check.error', { monitorId: monitor.id, error: err instanceof Error ? err.message : String(err) }),
			),
		),
		MAX_CONCURRENT_CHECKS,
	);

	// Heartbeat (push) monitors: not probed. A beat updates last_check_at via the /beat endpoint; here
	// we detect missed beats. The deadline is measured from the last beat, or from created_at when a
	// monitor has never beaten (a grace period so a freshly-imported job isn't instantly down). We
	// record one synthetic 'down' per newly-missed interval — deduped on the stored failure count so
	// uptime and the D1 write budget stay honest — then let evaluateAlerts open an incident once the
	// misses reach failure_count. These run inline (no subrequest) and don't count toward the probe cap.
	const heartbeats = allMonitors.filter((m) => m.type === 'heartbeat' && !underMaintenance(m.id));
	let heartbeatMisses = 0;
	for (const m of heartbeats) {
		const base = m.last_check_at ?? m.created_at;
		const missed = Math.floor((Date.now() - new Date(base).getTime()) / (m.interval_seconds * 1000));
		if (missed < 1) continue;
		// Dedup: skip if we've already recorded this miss count (status already down with >= missed failures).
		if (m.current_status === 'down' && m.consecutive_failures >= missed) continue;
		try {
			await storeHeartbeatMiss(env, m, missed, crypto.randomUUID(), now);
			await evaluateAlerts(
				env,
				m,
				{ status: 'down', latency_ms: 0, error: 'Heartbeat missed' },
				missed,
				0,
				now,
				rulesByMonitor.get(m.id) ?? [],
				activeByMonitor.get(m.id) ?? new Map(),
			);
			heartbeatMisses++;
			log('warn', 'heartbeat.missed', { monitorId: m.id, missed, intervalSeconds: m.interval_seconds });
		} catch (err) {
			log('error', 'check.error', { monitorId: m.id, error: err instanceof Error ? err.message : String(err) });
		}
	}

	// Self-check: surface a wedged scheduler (stalled) or capacity overload (monitors falling behind the
	// per-tick cap) loudly in logs/observability rather than degrading silently. The status page also banners it.
	const staleness = schedulerStaleness(allMonitors, Date.now());
	if (staleness.stalled) {
		log('error', 'scheduler.stale', { ageMs: staleness.ageMs, thresholdMs: staleness.thresholdMs, freshest: staleness.freshest });
	} else if (staleness.behindCount > 0) {
		log('warn', 'scheduler.behind', { behindCount: staleness.behindCount });
	}

	log('info', 'scheduler.tick', {
		durationMs: Date.now() - t0,
		due: dueChecks.length,
		checked: Math.min(dueChecks.length, MAX_CHECKS_PER_RUN),
		heartbeats: heartbeats.length,
		heartbeatMisses,
		maintenanceMonitors: maintenanceMonitorIds.size,
		globalMaintenance,
	});

	// Escalation: re-notify for open incidents that haven't been notified within escalation_seconds
	const { results: escalations } = await env.DB.prepare(
		`SELECT i.id, i.monitor_id, m.name AS monitor_name, i.started_at
		 FROM incidents i
		 JOIN monitors m ON m.id = i.monitor_id
		 JOIN alert_rules ar ON ar.id = i.alert_rule_id
		 WHERE i.status = 'open'
		   AND ar.escalation_seconds IS NOT NULL
		   AND (strftime('%s', ?) - strftime('%s', COALESCE(i.last_notified_at, i.started_at))) >= ar.escalation_seconds`,
	).bind(now).all<{ id: string; monitor_id: string; monitor_name: string; started_at: string }>();

	for (const inc of escalations) {
		// Don't re-notify for incidents on monitors that are under active maintenance.
		if (underMaintenance(inc.monitor_id)) continue;
		await env.DB.prepare(`UPDATE incidents SET last_notified_at = ? WHERE id = ?`).bind(now, inc.id).run();
		const minutesOpen = Math.floor((new Date(now).getTime() - new Date(inc.started_at).getTime()) / 60_000);
		log('info', 'incident.escalation', { incidentId: inc.id, monitorId: inc.monitor_id, minutesOpen });
		await (env.NOTIFICATION_QUEUE as Queue<NotificationMessage>).send({
			incidentId: inc.id,
			monitorId: inc.monitor_id,
			monitorName: inc.monitor_name,
			eventType: 'escalation',
			count: minutesOpen,
		});
	}

	// Hourly: recompute uptime_daily for today and yesterday from uptime_hourly ground truth
	if (new Date().getUTCMinutes() === 0) {
		await env.DB.prepare(
			`INSERT INTO uptime_daily (monitor_id, day, total_checks, up_checks, avg_latency_ms, latency_count)
			 SELECT
			   monitor_id,
			   substr(hour, 1, 10) AS day,
			   SUM(total_checks),
			   SUM(up_checks),
			   CASE WHEN SUM(latency_count) = 0 THEN NULL
			        ELSE SUM(avg_latency_ms * latency_count) / SUM(latency_count)
			   END,
			   SUM(latency_count)
			 FROM uptime_hourly
			 WHERE substr(hour, 1, 10) >= date('now', '-1 day')
			 GROUP BY monitor_id, substr(hour, 1, 10)
			 ON CONFLICT(monitor_id, day) DO UPDATE SET
			   total_checks   = excluded.total_checks,
			   up_checks      = excluded.up_checks,
			   avg_latency_ms = excluded.avg_latency_ms,
			   latency_count  = excluded.latency_count`,
		).run();
	}

	// Daily cleanup at ~04:30 UTC. notification_deliveries are removed via ON DELETE CASCADE
	// when their incident is purged, so they need no explicit delete here.
	const dNow = new Date();
	if (dNow.getUTCHours() === 4 && dNow.getUTCMinutes() === 30) {
		await env.DB.batch([
			// debug-only execution log, not read by the UI
			env.DB.prepare(`DELETE FROM monitor_executions WHERE started_at < datetime('now', '-48 hours')`),
			// resolved incidents kept 120 days: the status page colours bars from incidents up to 90 days back
			env.DB.prepare(`DELETE FROM incidents WHERE status = 'resolved' AND resolved_at < datetime('now', '-120 days')`),
			env.DB.prepare(`DELETE FROM metric_series WHERE recorded_at < datetime('now', '-7 days')`),
			env.DB.prepare(`DELETE FROM uptime_hourly WHERE hour < strftime('%Y-%m-%dT%H', datetime('now', '-48 hours'))`),
		]);
	}
}
