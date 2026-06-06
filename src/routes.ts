import { evaluateAlerts, storeResult } from './alerts';
import { buildStatusPage } from './status-page';
import type { AlertRuleDbRow, IncidentRow, LatencyRow, MonitorDbRow, MonitorRow, RuntimeEnv, UptimeDayRow } from './types';
import { fetchUsage, usageResetsIn } from './usage';

async function fetchMonitorRows(env: Env): Promise<MonitorDbRow[]> {
	const { results } = await env.DB.prepare(
		`SELECT m.id, m.name, m.type, m.mode, m.visibility,
		        m.scrape_url, m.interval_seconds, m.enabled,
		        m.created_at, m.updated_at,
		        ms.status, ms.last_check_at, ms.last_success_at,
		        ms.consecutive_failures, ms.consecutive_successes,
		        ms.active_incident_id
		 FROM monitors m
		 LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
		 WHERE m.enabled = 1
		 ORDER BY m.name`,
	).all<MonitorDbRow>();
	return results;
}

async function handleHeartbeat(requestPath: string, env: Env): Promise<Response> {
	const monitorId = requestPath.slice(6);
	const monitor = await env.DB.prepare(
		`SELECT m.id, m.name, m.type, m.scrape_url, m.interval_seconds,
		        COALESCE(m.ssl_check, 1) AS ssl_check,
		        ms.status AS current_status, ms.last_check_at,
		        COALESCE(ms.consecutive_failures, 0) AS consecutive_failures,
		        COALESCE(ms.consecutive_successes, 0) AS consecutive_successes,
		        ms.active_incident_id
		 FROM monitors m
		 LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
		 WHERE m.id = ? AND m.type = 'heartbeat' AND m.enabled = 1`,
	).bind(monitorId).first<MonitorRow>();
	if (!monitor) return new Response(null, { status: 404 });

	const now = new Date().toISOString();
	const result = { status: 'up' as const, latency_ms: 0 };
	const { newFailures, newSuccesses } = await storeResult(env, monitor, result, crypto.randomUUID(), now);
	await evaluateAlerts(env, monitor, result, newFailures, newSuccesses, now);
	return new Response(null, { status: 200 });
}

async function handleStatusApi(env: Env, runtimeEnv: RuntimeEnv): Promise<Response> {
	const [monitors, { results: rules }, snapshot] = await Promise.all([
		fetchMonitorRows(env),
		env.DB.prepare(
			`SELECT id, monitor_id, condition, threshold, severity,
			        failure_count, recovery_count, cooldown_seconds, enabled
			 FROM alert_rules
			 ORDER BY monitor_id`,
		).all<AlertRuleDbRow>(),
		fetchUsage(runtimeEnv),
	]);

	const rulesByMonitor = new Map<string, AlertRuleDbRow[]>();
	for (const rule of rules) {
		const list = rulesByMonitor.get(rule.monitor_id) ?? [];
		list.push(rule);
		rulesByMonitor.set(rule.monitor_id, list);
	}

	return Response.json({
		d1: snapshot.d1,
		d1Percent: snapshot.d1Percent,
		workers: snapshot.workers,
		usageResetsIn: usageResetsIn(Date.now()),
		monitors: monitors.map((m) => ({
			id: m.id,
			name: m.name,
			type: m.type,
			mode: m.mode,
			visibility: m.visibility,
			target: m.scrape_url,
			interval_seconds: m.interval_seconds,
			enabled: m.enabled === 1,
			created_at: m.created_at,
			updated_at: m.updated_at,
			state: {
				status: m.status ?? 'unknown',
				last_check_at: m.last_check_at,
				last_success_at: m.last_success_at,
				consecutive_failures: m.consecutive_failures ?? 0,
				consecutive_successes: m.consecutive_successes ?? 0,
				active_incident_id: m.active_incident_id,
			},
			alert_rules: (rulesByMonitor.get(m.id) ?? []).map((r) => ({
				id: r.id,
				condition: r.condition,
				threshold: r.threshold,
				severity: r.severity,
				failure_count: r.failure_count,
				recovery_count: r.recovery_count,
				cooldown_seconds: r.cooldown_seconds,
				enabled: r.enabled === 1,
			})),
		})),
	}, { headers: { 'Cache-Control': 'no-store' } });
}

async function handleStatusPage(env: Env, runtimeEnv: RuntimeEnv): Promise<Response> {
	const nowMs = Date.now();
	const [
		monitors,
		{ results: uptimeDays },
		{ results: latencyPoints },
		{ results: activeIncidents },
		{ results: recentIncidents },
		d1Usage,
	] = await Promise.all([
		fetchMonitorRows(env),
		env.DB.prepare(
			`SELECT monitor_id, date(recorded_at) AS day, AVG(availability) AS avg_up
			 FROM metric_series
			 WHERE recorded_at >= date('now', '-90 days')
			 GROUP BY monitor_id, day
			 ORDER BY monitor_id, day`,
		).all<UptimeDayRow>(),
		env.DB.prepare(
			`SELECT monitor_id, latency_ms
			 FROM metric_series
			 WHERE recorded_at >= datetime('now', '-24 hours') AND latency_ms IS NOT NULL
			 ORDER BY monitor_id, recorded_at`,
		).all<LatencyRow>(),
		env.DB.prepare(
			`SELECT id, monitor_id, severity, started_at, reason
			 FROM incidents WHERE status = 'open'
			 ORDER BY started_at DESC`,
		).all<IncidentRow>(),
		env.DB.prepare(
			`SELECT i.id, i.monitor_id, i.severity, i.started_at, i.resolved_at, i.reason, m.name AS monitor_name
			 FROM incidents i JOIN monitors m ON m.id = i.monitor_id
			 WHERE i.status = 'resolved'
			 ORDER BY i.resolved_at DESC LIMIT 5`,
		).all<IncidentRow>(),
		fetchUsage(runtimeEnv),
	]);

	return new Response(
		buildStatusPage({ nowMs, monitors, uptimeDays, latencyPoints, activeIncidents, recentIncidents, d1Usage }),
		{ headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
	);
}

export async function handleFetch(request: Request, env: Env): Promise<Response> {
	const { pathname } = new URL(request.url);
	const runtimeEnv = env as RuntimeEnv;

	if (request.method === 'POST' && pathname.startsWith('/beat/')) {
		return handleHeartbeat(pathname, env);
	}

	if (request.method === 'GET' && pathname === '/api/status') {
		return handleStatusApi(env, runtimeEnv);
	}

	if (request.method === 'GET' && pathname === '/') {
		return handleStatusPage(env, runtimeEnv);
	}

	return new Response(null, { status: 404 });
}
