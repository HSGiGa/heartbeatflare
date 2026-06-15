// Cron tick (every minute): select due monitors, probe them with bounded concurrency,
// store results and evaluate alerts. Also hosts the hourly uptime rollup and daily cleanup,
// since the Free Plan allows few cron triggers per account.
import { CONNECTIVITY_CLASS, evaluateAlerts, storeHeartbeatMiss, storeResult } from './alerts';
import { log } from './log';
import { dnsCheck, httpCheck, sslProbe, tcpCheck } from './probes';
import type { ActiveIncident, ActiveIncidentRow, AlertRuleDbRow, MonitorRow, NotificationMessage } from './types';

// Per-check hard timeout (probe timeouts are 10s; this is the outer safety net).
const PER_UNIT_MS = 20_000;
const MAX_CONCURRENT_CHECKS = 5;
// Free Plan allows 50 subrequests per invocation; each check costs 1–2 (probe + optional SSL API).
// Monitors beyond the cap roll over to the next tick via oldest-checked-first ordering.
const MAX_CHECKS_PER_RUN = 15;

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

async function runExternalCheck(
	monitor: MonitorRow & { mode: string; last_success_at: string | null },
	env: Env,
	now: string,
	rules: AlertRuleDbRow[],
	activeByClass: Map<string, ActiveIncident>,
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
	const [result, sslInfo] = await Promise.all([
		monitor.type === 'tcp' ? tcpCheck(monitor.scrape_url!) :
		monitor.type === 'dns' ? dnsCheck(monitor.scrape_url!) :
		httpCheck(monitor.scrape_url!, monitor.ssl_check === 1),
		doSslProbe ? sslProbe(sslHostname!) : Promise.resolve(null),
	]);
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

	// Single query for all monitors + preload all alert rules + open incidents + active maintenance
	// windows — avoids N+2 DB round-trips per cron run
	const [{ results: allMonitors }, { results: allRules }, { results: openIncidents }, { results: activeMaintenance }] = await Promise.all([
		env.DB.prepare(
			`SELECT m.id, m.name, m.type, m.mode, m.scrape_url, m.interval_seconds, m.created_at,
			        COALESCE(m.ssl_check, 1) AS ssl_check,
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

	const dueExternal = allMonitors.filter(
		(m) =>
			['http', 'tcp', 'dns'].includes(m.type) &&
			m.mode === 'external' &&
			// Skip monitors under an active maintenance window: no probe → no incident, uptime unaffected.
			!underMaintenance(m.id) &&
			(!m.last_check_at ||
				new Date(m.last_check_at).getTime() + m.interval_seconds * 1000 <= Date.now()),
	);

	// Oldest-checked first so that, when more than MAX_CHECKS_PER_RUN are due, no monitor starves.
	// last_check_at is ISO 8601 (lexicographically ordered); never-checked (null → '') sort first.
	dueExternal.sort((a, b) => (a.last_check_at ?? '').localeCompare(b.last_check_at ?? ''));

	await runWithLimit(
		dueExternal.slice(0, MAX_CHECKS_PER_RUN).map((monitor) => () =>
			Promise.race([
				runExternalCheck(monitor, env, now, rulesByMonitor.get(monitor.id) ?? [], activeByMonitor.get(monitor.id) ?? new Map()),
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

	log('info', 'scheduler.tick', {
		durationMs: Date.now() - t0,
		due: dueExternal.length,
		checked: Math.min(dueExternal.length, MAX_CHECKS_PER_RUN),
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
