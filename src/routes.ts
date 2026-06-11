import { getAuth, handleLogout, resolveAuthConfig } from './auth';
import { buildStatusPage } from './status-page';
import type { AlertRuleDbRow, IncidentRow, LatencyRow, MonitorDbRow, RuntimeEnv, Session, UptimeDayRow } from './types';
import { fetchUsage, usageResetsIn } from './usage';

// Edge-cache TTL for unauthenticated responses (status page + public API).
const PUBLIC_MAXAGE = 60;

// Cache API key namespaced to public responses, so an authenticated request to the same URL
// (which we never cache) can never match a cached public response.
function publicCacheKey(request: Request): Request {
	const url = new URL(request.url);
	url.searchParams.set('__pub', '1');
	return new Request(url.toString(), { method: 'GET' });
}

// Serve a public GET from the edge cache if present, otherwise run `produce`, cache it, and return it.
async function withPublicEdgeCache(request: Request, ctx: ExecutionContext, produce: () => Promise<Response>): Promise<Response> {
	const cache = caches.default;
	const key = publicCacheKey(request);
	const hit = await cache.match(key);
	if (hit) return hit;
	const res = await produce();
	if (res.ok) ctx.waitUntil(cache.put(key, res.clone()));
	return res;
}

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

async function handleStatusApi(env: Env, runtimeEnv: RuntimeEnv, showAll: boolean): Promise<Response> {
	const [monitors, { results: rules }, snapshot] = await Promise.all([
		fetchMonitorRows(env, showAll),
		env.DB.prepare(
			`SELECT id, monitor_id, metric_name, condition, threshold, severity,
			        failure_count, recovery_count, cooldown_seconds, enabled
			 FROM alert_rules
			 ORDER BY monitor_id`,
		).all<AlertRuleDbRow>(),
		showAll ? fetchUsage(runtimeEnv) : Promise.resolve(null),
	]);

	const rulesByMonitor = new Map<string, AlertRuleDbRow[]>();
	for (const rule of rules) {
		const list = rulesByMonitor.get(rule.monitor_id) ?? [];
		list.push(rule);
		rulesByMonitor.set(rule.monitor_id, list);
	}

	return Response.json({
		...(showAll && snapshot
			? { d1: snapshot.d1, d1Percent: snapshot.d1Percent, workers: snapshot.workers, usageResetsIn: usageResetsIn(Date.now()) }
			: {}),
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
	}, { headers: { 'Cache-Control': showAll ? 'no-store' : `public, max-age=${PUBLIC_MAXAGE}` } });
}

async function handleHistoryApi(env: Env, searchParams: URLSearchParams, showAll: boolean): Promise<Response> {
	const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
	const limit = 10;
	const offset = (page - 1) * limit;
	const visWhere = showAll ? '' : `AND m.visibility = 'public'`;

	const [{ results: incidents }, countRow] = await Promise.all([
		env.DB.prepare(
			`SELECT i.id, i.monitor_id, i.severity, i.status, i.started_at, i.resolved_at, i.reason,
			        m.name AS monitor_name, m.type AS monitor_type
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

	return Response.json({ incidents, total, page, pages }, { headers: { 'Cache-Control': showAll ? 'no-store' : `public, max-age=${PUBLIC_MAXAGE}` } });
}

async function handleStatusPage(
	env: Env,
	runtimeEnv: RuntimeEnv,
	showAll: boolean,
	session: Session | null,
	authEnabled: boolean,
): Promise<Response> {
	const nowMs = Date.now();
	const visWhere = showAll ? '' : `AND m.visibility = 'public'`;
	const [
		monitors,
		{ results: uptimeDays },
		{ results: latencyPoints },
		{ results: activeIncidents },
		{ results: allIncidents },
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
		env.DB.prepare(
			`SELECT i.id, i.monitor_id, i.severity, i.status, i.started_at, i.resolved_at, i.reason
			 FROM incidents i JOIN monitors m ON m.id = i.monitor_id
			 WHERE DATE(i.started_at) >= DATE(?1, '-89 days') AND m.enabled = 1 ${visWhere}
			 ORDER BY i.started_at
			 LIMIT 2000`,
		).bind(new Date(nowMs).toISOString().slice(0, 10)).all<IncidentRow>(),
		showAll ? fetchUsage(runtimeEnv) : Promise.resolve(null),
	]);

	const html = buildStatusPage({ nowMs, monitors, uptimeDays, latencyPoints, activeIncidents, allIncidents, d1Usage, session, authEnabled });

	// Unauthenticated (public) renders are cacheable at the edge; authenticated views are always fresh.
	const cacheControl = session ? 'no-store' : `public, max-age=${PUBLIC_MAXAGE}`;
	return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cacheControl } });
}

export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const origin = new URL(request.url).origin;
	const { pathname } = new URL(request.url);
	const runtimeEnv = env as RuntimeEnv;

	if (pathname === '/auth/login') {
		return Response.redirect(origin + '/private', 302);
	}

	if (pathname === '/auth/logout') {
		const authConfig = await resolveAuthConfig(env);
		return authConfig ? handleLogout(request, authConfig) : Response.redirect(origin + '/public', 302);
	}

	if (request.method === 'GET' && pathname === '/') {
		return Response.redirect(origin + '/public', 302);
	}

	if (request.method === 'GET' && pathname === '/public') {
		return withPublicEdgeCache(request, ctx, () => handleStatusPage(env, runtimeEnv, false, null, true));
	}

	let session: Session | null;
	let authEnabled: boolean;
	try {
		({ session, authEnabled } = await getAuth(request, env));
	} catch (err) {
		console.error('[auth] Auth resolution failed:', err);
		return new Response('Authentication service unavailable', {
			status: 503,
			headers: { 'Retry-After': '30', 'Content-Type': 'text/plain' },
		});
	}
	// Fail-closed: private data is shown only with a valid session. A missing/disabled auth_config
	// means "public only", never "everything open".
	const showAll = session !== null;

	if (request.method === 'GET' && pathname === '/api/status') {
		return showAll
			? handleStatusApi(env, runtimeEnv, true)
			: withPublicEdgeCache(request, ctx, () => handleStatusApi(env, runtimeEnv, false));
	}

	if (request.method === 'GET' && pathname === '/api/history') {
		const searchParams = new URL(request.url).searchParams;
		return showAll
			? handleHistoryApi(env, searchParams, true)
			: withPublicEdgeCache(request, ctx, () => handleHistoryApi(env, searchParams, false));
	}

	if (request.method === 'GET' && pathname === '/private') {
		return handleStatusPage(env, runtimeEnv, showAll, session, authEnabled);
	}

	return new Response(null, { status: 404 });
}
