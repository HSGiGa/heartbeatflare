// HTTP routing: status pages (/public, /private), JSON API (/api/status, /api/history) and
// auth redirects. Visibility is fail-closed — private data requires a verified Access session,
// enforced here in SQL WHERE clauses independently of the Cloudflare Access gate on /private.
// Unauthenticated responses are edge-cached to absorb traffic spikes without touching D1.
import { getAuth, handleLogout, resolveAuthConfig } from './auth';
import { handleBeat } from './heartbeat';
import { log } from './log';
import { buildBadgeSvg } from './badge';
import { buildAtomFeed } from './feed';
import { buildStatusPage } from './status-page';
import type { AlertRuleDbRow, IncidentRow, LatencyRow, MaintenanceWindowRow, MonitorDbRow, RuntimeEnv, Session, UptimeDayRow } from './types';
import { fetchUsage } from './usage';
import { buildUsagePage } from './usage-page';

// Edge-cache TTL for unauthenticated responses (status page + public API).
const PUBLIC_MAXAGE = 60;
const NO_STORE = 'no-store';

function redirectNoStore(location: string): Response {
	return new Response(null, {
		status: 302,
		headers: {
			Location: location,
			'Cache-Control': NO_STORE,
		},
	});
}

function escHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeMarkdownAlt(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

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

async function handleStatusApi(env: Env, showAll: boolean): Promise<Response> {
	const [monitors, { results: rules }] = await Promise.all([
		fetchMonitorRows(env, showAll),
		env.DB.prepare(
			`SELECT id, monitor_id, metric_name, condition, threshold, severity,
			        failure_count, recovery_count, cooldown_seconds, enabled
			 FROM alert_rules
			 ORDER BY monitor_id`,
		).all<AlertRuleDbRow>(),
	]);

	const rulesByMonitor = new Map<string, AlertRuleDbRow[]>();
	for (const rule of rules) {
		const list = rulesByMonitor.get(rule.monitor_id) ?? [];
		list.push(rule);
		rulesByMonitor.set(rule.monitor_id, list);
	}

	return Response.json({
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
	const visWhere = showAll ? '' : `AND m.visibility = 'public'`;
	const monthParam = searchParams.get('month');
	const validMonth = /^\d{4}-\d{2}$/.test(monthParam ?? '') ? monthParam : null;

	if (validMonth) {
		const [{ results: incidents }, { results: monthRows }] = await Promise.all([
			env.DB.prepare(
				`SELECT i.id, i.monitor_id, i.severity, i.status, i.started_at, i.resolved_at, i.reason,
				        m.name AS monitor_name, m.type AS monitor_type
				 FROM incidents i JOIN monitors m ON m.id = i.monitor_id
				 WHERE m.enabled = 1 ${visWhere}
				   AND strftime('%Y-%m', i.started_at) = ?
				 ORDER BY i.started_at DESC`,
			).bind(validMonth).all<IncidentRow>(),
			env.DB.prepare(
				`SELECT DISTINCT strftime('%Y-%m', i.started_at) AS ym
				 FROM incidents i JOIN monitors m ON m.id = i.monitor_id
				 WHERE m.enabled = 1 ${visWhere}
				 ORDER BY ym DESC`,
			).all<{ ym: string }>(),
		]);

		const months = monthRows.map((r) => r.ym);

		return Response.json({ incidents, month: validMonth, months }, { headers: { 'Cache-Control': showAll ? 'no-store' : `public, max-age=${PUBLIC_MAXAGE}` } });
	}

	const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
	const limit = 10;
	const offset = (page - 1) * limit;

	const [{ results: incidents }, countRow] = await Promise.all([
		env.DB.prepare(
			`SELECT i.id, i.monitor_id, i.severity, i.status, i.started_at, i.resolved_at, i.reason,
			        m.name AS monitor_name, m.type AS monitor_type
			 FROM incidents i JOIN monitors m ON m.id = i.monitor_id
			 WHERE m.enabled = 1 ${visWhere}
			 ORDER BY i.started_at DESC LIMIT ? OFFSET ?`,
		).bind(limit, offset).all<IncidentRow>(),
		env.DB.prepare(
			showAll
				? `SELECT COUNT(*) AS total FROM incidents i JOIN monitors m ON m.id = i.monitor_id WHERE m.enabled = 1`
				: `SELECT COUNT(*) AS total FROM incidents i JOIN monitors m ON m.id = i.monitor_id WHERE m.enabled = 1 AND m.visibility = 'public'`,
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
	host: string,
	cacheControl?: string,
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
			 WHERE i.status = 'open' AND m.enabled = 1 ${visWhere}
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
	]);

	const html = buildStatusPage({ nowMs, monitors, uptimeDays, latencyPoints, activeIncidents, allIncidents, maintenanceWindows, d1Usage: null, session, authEnabled, scope: showAll ? 'all' : 'public', workerName: runtimeEnv.WORKER_NAME ?? '', version: runtimeEnv.APP_VERSION ?? '', siteTitle: runtimeEnv.SITE_TITLE ?? '', host });

	// Unauthenticated (public) renders are cacheable at the edge; authenticated views are always fresh.
	const resolvedCacheControl = cacheControl ?? (session ? NO_STORE : `public, max-age=${PUBLIC_MAXAGE}`);
	return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': resolvedCacheControl } });
}

async function handleUsagePage(runtimeEnv: RuntimeEnv, session: Session): Promise<Response> {
	const snapshot = await fetchUsage(runtimeEnv);
	return new Response(buildUsagePage({ nowMs: Date.now(), snapshot, session, siteTitle: runtimeEnv.SITE_TITLE ?? '' }), {
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': NO_STORE },
	});
}

async function handleBadgesPage(env: Env, origin: string, siteTitle: string): Promise<Response> {
	const monitors = await fetchMonitorRows(env, false);

	// Overall site badge: one badge for the whole site, label taken from the configured site title.
	const overallName = siteTitle.trim() || 'HeartbeatFlare';
	const overallPath = `/badge.svg`;
	const overallUrl = `${origin}${overallPath}`;
	const overallMarkdown = `![${escapeMarkdownAlt(overallName)} status](${overallUrl})`;
	const overallHtmlSnippet = `<img src="${escHtml(overallUrl)}" alt="${escHtml(overallName)} status">`;
	const overallRow = `<article class="badge-row">
  <div class="badge-head">
    <div>
      <h2>${escHtml(overallName)}</h2>
      <div class="monitor-id">overall site status · all public monitors</div>
    </div>
    <img class="badge-preview" src="${escHtml(overallPath)}" alt="${escHtml(overallName)} status badge" loading="lazy">
  </div>
  <label>SVG URL</label>
  <pre><code>${escHtml(overallUrl)}</code></pre>
  <label>Markdown</label>
  <pre><code>${escHtml(overallMarkdown)}</code></pre>
  <label>HTML</label>
  <pre><code>${escHtml(overallHtmlSnippet)}</code></pre>
  <label>Custom label example</label>
  <pre><code>${escHtml(`${overallUrl}?label=My%20Service`)}</code></pre>
</article>`;

	const rows = monitors
		.map((m) => {
			const badgePath = `/badge/${encodeURIComponent(m.id)}.svg`;
			const badgeUrl = `${origin}${badgePath}`;
			const labelUrl = `${badgeUrl}?label=${encodeURIComponent(m.name)}`;
			const markdown = `![${escapeMarkdownAlt(m.name)} status](${badgeUrl})`;
			const htmlSnippet = `<img src="${escHtml(badgeUrl)}" alt="${escHtml(m.name)} status">`;
			return `<article class="badge-row">
  <div class="badge-head">
    <div>
      <h2>${escHtml(m.name)}</h2>
      <div class="monitor-id">${escHtml(m.id)}${m.paused === 1 ? ' · paused' : ''}</div>
    </div>
    <img class="badge-preview" src="${escHtml(badgePath)}" alt="${escHtml(m.name)} status badge" loading="lazy">
  </div>
  <label>SVG URL</label>
  <pre><code>${escHtml(badgeUrl)}</code></pre>
  <label>Markdown</label>
  <pre><code>${escHtml(markdown)}</code></pre>
  <label>HTML</label>
  <pre><code>${escHtml(htmlSnippet)}</code></pre>
  <label>Custom label example</label>
  <pre><code>${escHtml(labelUrl)}</code></pre>
</article>`;
		})
		.join('\n');
	const monitorsBody =
		monitors.length === 0
			? `<section class="empty"><h2>No per-monitor badges yet</h2><p>Add an enabled public monitor to config.yaml and deploy to generate per-monitor badge snippets.</p></section>`
			: `<section class="badge-list">${rows}</section>`;
	const body = `<section class="badge-list">${overallRow}</section>${monitorsBody}`;
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Status badges</title>
  <style>
    :root{color-scheme:light;--text:#18181b;--muted:#71717a;--line:#e4e4e7;--bg:#fafafa;--panel:#fff}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}
    main{max-width:980px;margin:0 auto;padding:32px 18px 48px}
    header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:24px}
    h1{font-size:28px;line-height:1.15;margin:0 0 8px}
    h2{font-size:17px;line-height:1.25;margin:0}
    p{margin:0;color:var(--muted)}
    a{color:#2563eb;text-decoration:none}
    a:hover{text-decoration:underline}
    .badge-list{display:grid;gap:14px}
    .badge-row,.empty{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px}
    .badge-head{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:14px}
    .monitor-id{font-size:12px;color:var(--muted);margin-top:3px}
    .badge-preview{flex:0 0 auto;max-width:100%;height:20px}
    label{display:block;font-size:12px;font-weight:700;color:#3f3f46;margin:12px 0 5px;text-transform:uppercase}
    pre{margin:0;overflow:auto;border:1px solid var(--line);border-radius:6px;background:#f4f4f5;padding:10px 12px}
    code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace;font-size:12px;white-space:pre}
    .empty{text-align:center;padding:34px 20px}
    @media (max-width:640px){header,.badge-head{display:block}.badge-preview{margin-top:12px}main{padding-top:22px}}
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Status badges</h1>
        <p>Embeddable SVG badges: an overall site badge plus one per public monitor.</p>
      </div>
      <a href="/public">Status page</a>
    </header>
    ${body}
  </main>
</body>
</html>`;
	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': `public, max-age=${PUBLIC_MAXAGE}` },
	});
}

// Public Atom feed of incidents + maintenance windows (public monitors only).
async function handleFeed(env: Env, origin: string): Promise<Response> {
	const nowMs = Date.now();
	const [{ results: incidents }, maintenanceWindows] = await Promise.all([
		env.DB.prepare(
			`SELECT i.id, i.monitor_id, i.severity, i.status, i.started_at, i.resolved_at, i.reason, m.name AS monitor_name
			 FROM incidents i JOIN monitors m ON m.id = i.monitor_id
			 WHERE m.enabled = 1 AND m.visibility = 'public'
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

// Overall site badge: a single badge summarising every public monitor. Precedence is
// down > maintenance (active global window) > degraded > up; the label defaults to the site title.
async function handleOverallBadge(env: Env, runtimeEnv: RuntimeEnv, searchParams: URLSearchParams): Promise<Response> {
	const nowIso = new Date().toISOString();
	const [monitors, maintenanceWindows] = await Promise.all([
		fetchMonitorRows(env, false),
		fetchMaintenanceWindows(env, false, nowIso),
	]);
	const hasDown = monitors.some((m) => m.status === 'down');
	const hasDegraded = monitors.some((m) => m.status === 'degraded');
	// A global window (no affected monitors) that is active right now puts the whole site in maintenance.
	const globalMaintenance = maintenanceWindows.some((w) => w.monitor_ids.length === 0 && w.starts_at <= nowIso && nowIso < w.ends_at);
	// No public monitors at all → unknown; otherwise worst-of.
	const status = monitors.length === 0 ? null : hasDown ? 'down' : globalMaintenance ? 'maintenance' : hasDegraded ? 'degraded' : 'up';
	const label = searchParams.get('label') ?? runtimeEnv.SITE_TITLE?.trim() ?? '';
	const svg = buildBadgeSvg(label || 'HeartbeatFlare', status, false);
	return new Response(svg, {
		headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': `public, max-age=${PUBLIC_MAXAGE}` },
	});
}

export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const origin = new URL(request.url).origin;
	const { pathname } = new URL(request.url);
	const runtimeEnv = env as RuntimeEnv;

	// Push heartbeat: handled before auth/cache. Never cached, no Cloudflare Access. The path itself
	// is generic, so a wrong method returns 405 (not 404) — only the monitor id/token leak nothing.
	if (pathname.startsWith('/beat/')) {
		if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
		return handleBeat(request, env);
	}

	if (pathname === '/auth/login') {
		return redirectNoStore(origin + '/private');
	}

	if (pathname === '/auth/logout') {
		const authConfig = await resolveAuthConfig(env);
		return authConfig ? handleLogout(request, authConfig) : redirectNoStore(origin + '/public');
	}

	if (request.method === 'GET' && pathname === '/') {
		try {
			const { session } = await getAuth(request, env);
			return redirectNoStore(origin + (session ? '/private' : '/public'));
		} catch (err) {
			log('error', 'auth.error', { error: err instanceof Error ? err.message : String(err) });
			return new Response('Authentication service unavailable', {
				status: 503,
				headers: { 'Retry-After': '30', 'Content-Type': 'text/plain' },
			});
		}
	}

	if (request.method === 'GET' && pathname === '/public') {
		return withPublicEdgeCache(request, ctx, () => handleStatusPage(env, runtimeEnv, false, null, true, new URL(request.url).host));
	}

	if (request.method === 'GET' && pathname === '/feed.xml') {
		return withPublicEdgeCache(request, ctx, () => handleFeed(env, origin));
	}

	if (request.method === 'GET' && pathname === '/badges') {
		return withPublicEdgeCache(request, ctx, () => handleBadgesPage(env, origin, runtimeEnv.SITE_TITLE ?? ''));
	}

	if (request.method === 'GET' && pathname === '/badge.svg') {
		const searchParams = new URL(request.url).searchParams;
		return withPublicEdgeCache(request, ctx, () => handleOverallBadge(env, runtimeEnv, searchParams));
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
			? handleStatusApi(env, true)
			: withPublicEdgeCache(request, ctx, () => handleStatusApi(env, false));
	}

	if (request.method === 'GET' && pathname === '/api/history') {
		const searchParams = new URL(request.url).searchParams;
		// Scope is explicit (set by the page that issued the request), not ambient session state:
		// /public asks for scope=public, /private asks for scope=all. The server still enforces the
		// session fail-closed — scope=all only yields private data with a valid session, otherwise it
		// degrades to public. A missing scope defaults to public so cached responses stay consistent.
		const wantsAll = searchParams.get('scope') === 'all';
		const effectiveShowAll = wantsAll && showAll;
		return effectiveShowAll
			? handleHistoryApi(env, searchParams, true)
			: withPublicEdgeCache(request, ctx, () => handleHistoryApi(env, searchParams, false));
	}

	if (request.method === 'GET' && pathname === '/private') {
		return handleStatusPage(env, runtimeEnv, showAll, session, authEnabled, new URL(request.url).host, NO_STORE);
	}

	// Account-level usage is never exposed without a locally verified Access session.
	if (request.method === 'GET' && pathname === '/usage') {
		return session ? handleUsagePage(runtimeEnv, session) : new Response('Authentication required', { status: 403, headers: { 'Cache-Control': NO_STORE } });
	}

	return new Response(null, { status: 404 });
}
