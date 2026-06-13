// HTTP routing: status pages (/public, /private), JSON API (/api/status, /api/history) and
// auth redirects. Visibility is fail-closed — private data requires a verified Access session,
// enforced here in SQL WHERE clauses independently of the Cloudflare Access gate on /private.
// Unauthenticated responses are edge-cached to absorb traffic spikes without touching D1.
import { getAuth, handleLogout, resolveAuthConfig } from './auth';
import { log } from './log';
import { buildBadgeSvg } from './badge';
import { buildAtomFeed } from './feed';
import { buildStatusPage } from './status-page';
import type { AlertRuleDbRow, IncidentRow, LatencyRow, MaintenanceWindowRow, MonitorDbRow, RuntimeEnv, Session, UptimeDayRow } from './types';
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
		        m.scrape_url, m.interval_seconds, m.enabled, m.paused,
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

// Maintenance windows with their affected monitor ids (empty = global). Public scope shows only
// global windows or windows touching at least one public monitor; `endedAfterIso` filters out
// windows that have already finished (pass `now` for the status page, an older cutoff for the feed).
async function fetchMaintenanceWindows(env: Env, showAll: boolean, endedAfterIso: string): Promise<MaintenanceWindowRow[]> {
	const visClause = showAll
		? ''
		: `AND ( NOT EXISTS (SELECT 1 FROM maintenance_window_monitors x WHERE x.window_id = mw.id)
		        OR EXISTS (SELECT 1 FROM maintenance_window_monitors x JOIN monitors m2 ON m2.id = x.monitor_id
		                   WHERE x.window_id = mw.id AND m2.visibility = 'public') )`;
	const { results: rows } = await env.DB.prepare(
		`SELECT mw.id, mw.title, mw.body, mw.starts_at, mw.ends_at
		 FROM maintenance_windows mw
		 WHERE mw.enabled = 1 AND mw.ends_at > ? ${visClause}
		 ORDER BY mw.starts_at`,
	).bind(endedAfterIso).all<Omit<MaintenanceWindowRow, 'monitor_ids'>>();
	if (rows.length === 0) return [];

	const { results: links } = await env.DB.prepare(`SELECT window_id, monitor_id FROM maintenance_window_monitors`).all<{
		window_id: string;
		monitor_id: string;
	}>();
	const byWindow = new Map<string, string[]>();
	for (const l of links) {
		const list = byWindow.get(l.window_id) ?? [];
		list.push(l.monitor_id);
		byWindow.set(l.window_id, list);
	}
	return rows.map((r) => ({ ...r, monitor_ids: byWindow.get(r.id) ?? [] }));
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
			paused: m.paused === 1,
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
		maintenanceWindows,
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
		fetchMaintenanceWindows(env, showAll, new Date(nowMs).toISOString()),
		showAll ? fetchUsage(runtimeEnv) : Promise.resolve(null),
	]);

	const html = buildStatusPage({ nowMs, monitors, uptimeDays, latencyPoints, activeIncidents, allIncidents, maintenanceWindows, d1Usage, session, authEnabled });

	// Unauthenticated (public) renders are cacheable at the edge; authenticated views are always fresh.
	const cacheControl = session ? 'no-store' : `public, max-age=${PUBLIC_MAXAGE}`;
	return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cacheControl } });
}

// Public Atom feed of incidents + maintenance windows (public monitors only).
async function handleFeed(env: Env, origin: string): Promise<Response> {
	const nowMs = Date.now();
	const [{ results: incidents }, maintenanceWindows] = await Promise.all([
		env.DB.prepare(
			`SELECT i.id, i.monitor_id, i.severity, i.status, i.started_at, i.resolved_at, i.reason, m.name AS monitor_name
			 FROM incidents i JOIN monitors m ON m.id = i.monitor_id
			 WHERE m.visibility = 'public'
			 ORDER BY COALESCE(i.resolved_at, i.started_at) DESC
			 LIMIT 50`,
		).all<IncidentRow>(),
		// Include recently-finished windows (last 30 days) so the feed carries some history.
		fetchMaintenanceWindows(env, false, new Date(nowMs - 30 * 86_400_000).toISOString()),
	]);
	const xml = buildAtomFeed({ origin, nowMs, incidents, maintenanceWindows });
	return new Response(xml, {
		headers: { 'Content-Type': 'application/atom+xml; charset=utf-8', 'Cache-Control': `public, max-age=${PUBLIC_MAXAGE}` },
	});
}

// Embeddable SVG status badge for a public monitor. Private/unknown monitors return 404 so the
// badge endpoint never reveals the existence of a private monitor (fail-closed).
async function handleBadge(env: Env, pathname: string, searchParams: URLSearchParams): Promise<Response> {
	const id = decodeURIComponent(pathname.slice('/badge/'.length, -'.svg'.length));
	const row = await env.DB.prepare(
		`SELECT m.name, m.paused, ms.status
		 FROM monitors m LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
		 WHERE m.id = ? AND m.enabled = 1 AND m.visibility = 'public'`,
	).bind(id).first<{ name: string; paused: number; status: string | null }>();
	if (!row) return new Response(null, { status: 404 });
	const label = searchParams.get('label') ?? row.name;
	const svg = buildBadgeSvg(label, row.status, row.paused === 1);
	return new Response(svg, {
		headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': `public, max-age=${PUBLIC_MAXAGE}` },
	});
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

	if (request.method === 'GET' && pathname === '/feed.xml') {
		return withPublicEdgeCache(request, ctx, () => handleFeed(env, origin));
	}

	if (request.method === 'GET' && pathname.startsWith('/badge/') && pathname.endsWith('.svg')) {
		const searchParams = new URL(request.url).searchParams;
		return withPublicEdgeCache(request, ctx, () => handleBadge(env, pathname, searchParams));
	}

	let session: Session | null;
	let authEnabled: boolean;
	try {
		({ session, authEnabled } = await getAuth(request, env));
	} catch (err) {
		log('error', 'auth.error', { error: err instanceof Error ? err.message : String(err) });
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
