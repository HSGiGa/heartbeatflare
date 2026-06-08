import { evaluateAlerts, storeResult } from './alerts';
import { getAuth, handleLogout, resolveAuthConfig } from './auth';
import { buildStatusPage } from './status-page';
import type { AlertRuleDbRow, IncidentRow, LatencyRow, MonitorDbRow, MonitorRow, RuntimeEnv, Session, UptimeDayRow } from './types';
import { fetchUsage, usageResetsIn } from './usage';

let cachedPage = '';
let cachedPageUntil = 0;

async function fetchMonitorRows(env: Env, showAll: boolean): Promise<MonitorDbRow[]> {
	const visFilter = showAll ? '' : `AND m.visibility = 'public'`;
	const { results } = await env.DB.prepare(
		`SELECT m.id, m.name, m.type, m.mode, m.visibility,
		        m.scrape_url, m.interval_seconds, m.enabled,
		        m.created_at, m.updated_at,
		        ms.status, ms.last_check_at, ms.last_success_at,
		        ms.consecutive_failures, ms.consecutive_successes,
		        ms.active_incident_id, ms.ssl_not_after, ms.ssl_issuer
		 FROM monitors m
		 LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
		 WHERE m.enabled = 1 ${visFilter}
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

async function handleStatusApi(env: Env, runtimeEnv: RuntimeEnv, showAll: boolean): Promise<Response> {
	const [monitors, { results: rules }, snapshot] = await Promise.all([
		fetchMonitorRows(env, showAll),
		env.DB.prepare(
			`SELECT id, monitor_id, metric_name, condition, threshold, severity,
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
			target: showAll ? m.scrape_url : null,
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
				ssl_not_after: m.ssl_not_after ?? null,
				ssl_issuer: m.ssl_issuer ?? null,
			},
			alert_rules: showAll
				? (rulesByMonitor.get(m.id) ?? []).map((r) => ({
						id: r.id,
						condition: r.condition,
						threshold: r.threshold,
						severity: r.severity,
						failure_count: r.failure_count,
						recovery_count: r.recovery_count,
						cooldown_seconds: r.cooldown_seconds,
						enabled: r.enabled === 1,
					}))
				: [],
		})),
	}, { headers: { 'Cache-Control': 'no-store' } });
}

async function handleHistoryApi(env: Env, searchParams: URLSearchParams, showAll: boolean): Promise<Response> {
	const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
	const limit = 10;
	const offset = (page - 1) * limit;
	const visWhere = showAll ? '' : `AND m.visibility = 'public'`;

	const [{ results: incidents }, countRow] = await Promise.all([
		env.DB.prepare(
			`SELECT i.id, i.monitor_id, i.severity, i.status, i.started_at, i.resolved_at, i.reason, m.name AS monitor_name
			 FROM incidents i JOIN monitors m ON m.id = i.monitor_id
			 WHERE 1=1 ${visWhere}
			 ORDER BY i.started_at DESC LIMIT ? OFFSET ?`,
		).bind(limit, offset).all<IncidentRow>(),
		env.DB.prepare(
			showAll
				? `SELECT COUNT(*) AS total FROM incidents`
				: `SELECT COUNT(*) AS total FROM incidents i JOIN monitors m ON m.id = i.monitor_id WHERE m.visibility = 'public'`,
		).first<{ total: number }>(),
	]);

	const total = countRow?.total ?? 0;
	const pages = Math.max(1, Math.ceil(total / limit));

	return Response.json({ incidents, total, page, pages }, { headers: { 'Cache-Control': 'no-store' } });
}

async function handleStatusPage(
	env: Env,
	runtimeEnv: RuntimeEnv,
	showAll: boolean,
	session: Session | null,
	authEnabled: boolean,
): Promise<Response> {
	if (!authEnabled && Date.now() < cachedPageUntil) {
		return new Response(cachedPage, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
	}

	const nowMs = Date.now();
	const visWhere = showAll ? '' : `AND m.visibility = 'public'`;
	const [
		monitors,
		{ results: uptimeDays },
		{ results: latencyPoints },
		{ results: activeIncidents },
		d1Usage,
	] = await Promise.all([
		fetchMonitorRows(env, showAll),
		env.DB.prepare(
			`SELECT monitor_id, day, CAST(up_checks AS REAL) / total_checks AS avg_up
			 FROM uptime_daily
			 WHERE day >= date('now', '-90 days')
			 ORDER BY monitor_id, day`,
		).all<UptimeDayRow>(),
		env.DB.prepare(
			`SELECT monitor_id, avg_latency_ms AS latency_ms
			 FROM uptime_hourly
			 WHERE hour >= strftime('%Y-%m-%dT%H', datetime('now', '-24 hours'))
			   AND avg_latency_ms IS NOT NULL
			 ORDER BY monitor_id, hour`,
		).all<LatencyRow>(),
		env.DB.prepare(
			`SELECT i.id, i.monitor_id, i.severity, i.started_at, i.reason
			 FROM incidents i JOIN monitors m ON m.id = i.monitor_id
			 WHERE i.status = 'open' ${visWhere}
			 ORDER BY i.started_at DESC`,
		).all<IncidentRow>(),
		fetchUsage(runtimeEnv),
	]);

	const html = buildStatusPage({ nowMs, monitors, uptimeDays, latencyPoints, activeIncidents, d1Usage, session, authEnabled });

	if (!authEnabled) {
		cachedPage = html;
		cachedPageUntil = Date.now() + 60_000;
	}

	return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function handleFetch(request: Request, env: Env): Promise<Response> {
	const { pathname } = new URL(request.url);
	const runtimeEnv = env as RuntimeEnv;

	if (request.method === 'POST' && pathname.startsWith('/beat/')) {
		return handleHeartbeat(pathname, env);
	}

	if (pathname === '/auth/login') {
		return new Response(null, { status: 302, headers: { Location: '/' } });
	}

	if (pathname === '/auth/logout') {
		const authConfig = await resolveAuthConfig(env);
		return authConfig ? handleLogout(request, authConfig) : new Response(null, { status: 302, headers: { Location: '/' } });
	}

	const { session, authEnabled } = await getAuth(request, env);
	const showAll = !authEnabled || session !== null;

	if (request.method === 'GET' && pathname === '/api/status') {
		return handleStatusApi(env, runtimeEnv, showAll);
	}

	if (request.method === 'GET' && pathname === '/api/history') {
		return handleHistoryApi(env, new URL(request.url).searchParams, showAll);
	}

	if (request.method === 'GET' && pathname === '/') {
		return handleStatusPage(env, runtimeEnv, showAll, session, authEnabled);
	}

	return new Response(null, { status: 404 });
}
