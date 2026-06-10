import { evaluateAlerts, storeResult } from './alerts';
import { dnsCheck, httpCheck, sslProbe, tcpCheck } from './probes';
import type { AlertRuleDbRow, MonitorRow } from './types';

const PER_UNIT_MS = 20_000;
const MAX_CONCURRENT_CHECKS = 5;
const MAX_CHECKS_PER_RUN = 15;

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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
	rules: AlertRuleDbRow[] | undefined,
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
	await evaluateAlerts(env, monitor, result, newFailures, newSuccesses, now, rules);
}

export async function handleScheduled(env: Env): Promise<void> {
	const now = new Date().toISOString();
	const t0 = Date.now();

	// Single query for all monitors + preload all alert rules — avoids N+2 DB round-trips per cron run
	const [{ results: allMonitors }, { results: allRules }] = await Promise.all([
		env.DB.prepare(
			`SELECT m.id, m.name, m.type, m.mode, m.scrape_url, m.interval_seconds,
			        COALESCE(m.ssl_check, 1) AS ssl_check,
			        ms.status AS current_status, ms.last_check_at, ms.last_success_at,
			        COALESCE(ms.consecutive_failures, 0) AS consecutive_failures,
			        COALESCE(ms.consecutive_successes, 0) AS consecutive_successes,
			        ms.active_incident_id,
			        ms.ssl_not_after, ms.ssl_issuer
			 FROM monitors m
			 LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
			 WHERE m.enabled = 1`,
		).all<MonitorRow & { mode: string; last_success_at: string | null }>(),
		env.DB.prepare(
			`SELECT id, monitor_id, metric_name, condition, threshold, severity,
			        failure_count, recovery_count, cooldown_seconds, enabled
			 FROM alert_rules WHERE enabled = 1 ORDER BY monitor_id, failure_count ASC`,
		).all<AlertRuleDbRow>(),
	]);

	const rulesByMonitor = new Map<string, AlertRuleDbRow[]>();
	for (const r of allRules) {
		const list = rulesByMonitor.get(r.monitor_id) ?? [];
		list.push(r);
		rulesByMonitor.set(r.monitor_id, list);
	}

	const dueExternal = allMonitors.filter(
		(m) =>
			['http', 'tcp', 'dns'].includes(m.type) &&
			m.mode === 'external' &&
			(!m.last_check_at ||
				new Date(m.last_check_at).getTime() + m.interval_seconds * 1000 <= Date.now()),
	);

	const staleHeartbeats = allMonitors.filter(
		(m) =>
			m.type === 'heartbeat' &&
			(!m.last_success_at ||
				new Date(m.last_success_at).getTime() + m.interval_seconds * 1000 <= Date.now()),
	);

	await runWithLimit(
		dueExternal.slice(0, MAX_CHECKS_PER_RUN).map((monitor) => () =>
			Promise.race([
				runExternalCheck(monitor, env, now, rulesByMonitor.get(monitor.id)),
				wait(PER_UNIT_MS).then(() => Promise.reject(new Error(`timed out after ${PER_UNIT_MS / 1000}s`))),
			]).catch((err: unknown) =>
				console.error(`[scheduler] ${monitor.id}: ${err instanceof Error ? err.message : String(err)}`),
			),
		),
		MAX_CONCURRENT_CHECKS,
	);

	await runWithLimit(
		staleHeartbeats.slice(0, MAX_CHECKS_PER_RUN).map((monitor) => () =>
			Promise.race([
				(async () => {
					const result = { status: 'down' as const, latency_ms: 0, error: 'Heartbeat missed' };
					const { newFailures, newSuccesses } = await storeResult(env, monitor, result, crypto.randomUUID(), now);
					await evaluateAlerts(env, monitor, result, newFailures, newSuccesses, now, rulesByMonitor.get(monitor.id));
				})(),
				wait(PER_UNIT_MS).then(() => Promise.reject(new Error(`timed out after ${PER_UNIT_MS / 1000}s`))),
			]).catch((err: unknown) =>
				console.error(`[scheduler] ${monitor.id}: ${err instanceof Error ? err.message : String(err)}`),
			),
		),
		MAX_CONCURRENT_CHECKS,
	);

	console.log(`[scheduler] done in ${Date.now() - t0}ms — ${dueExternal.length} checks, ${staleHeartbeats.length} stale heartbeats`);

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

	// Weekly cleanup: keep metric_series 7 days, uptime_hourly 48 hours
	const minuteOfWeek = Math.floor(Date.now() / 60_000) % (7 * 24 * 60);
	if (minuteOfWeek === 0) {
		await env.DB.batch([
			env.DB.prepare(`DELETE FROM metric_series WHERE recorded_at < datetime('now', '-7 days')`),
			env.DB.prepare(`DELETE FROM uptime_hourly WHERE hour < strftime('%Y-%m-%dT%H', datetime('now', '-48 hours'))`),
		]);
	}
}
