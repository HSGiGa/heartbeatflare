// Server-rendered status page: monitor cards with 90-day uptime bars, latency sparklines,
// active incidents and (when authenticated) the usage block. Plain HTML built inline — no
// build step, no assets binding. Reads only the uptime_daily/uptime_hourly aggregates and
// incidents, never raw metric_series.
import type { MonitorDbRow, UptimeDayRow, LatencyRow, IncidentRow, MaintenanceWindowRow, Session, UsageSnapshot } from './types';
import { usageResetsIn, workersFreeLimit } from './usage';

function escHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(dateStr: string | null): string {
	if (!dateStr) return 'never';
	const diff = Date.now() - new Date(dateStr).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function formatDuration(startStr: string, endStr: string | null): string {
	if (!endStr) return 'ongoing';
	const mins = Math.floor((new Date(endStr).getTime() - new Date(startStr).getTime()) / 60_000);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ${mins % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatNumber(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
	if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
	return String(n);
}

function formatBytes(bytes: number): string {
	if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(2) + ' GB';
	if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB';
	if (bytes >= 1_024) return (bytes / 1_024).toFixed(1) + ' KB';
	return bytes + ' B';
}

const brandIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254" aria-hidden="true" focusable="false"><defs><radialGradient id="hbf-cloud" cx="728" cy="392" r="640" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff7a7a"/><stop offset=".42" stop-color="#ef2f2f"/><stop offset="1" stop-color="#9f1239"/></radialGradient><linearGradient id="hbf-shade" x1="560" y1="640" x2="560" y2="904" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7f1d1d" stop-opacity="0"/><stop offset="1" stop-color="#7f1d1d" stop-opacity=".32"/></linearGradient><clipPath id="hbf-clip"><path d="M316 904c-88 0-158-70-158-158s70-164 158-164c-5-73 49-135 114-135 17 0 33 3 46 8 34-87 121-148 220-148 127 0 232 101 237 228 12-2 24-3 37-3 86 0 154 69 154 154 0 119-88 218-196 218H316Z"/></clipPath><linearGradient id="hbf-bolt" x1="1028" y1="532" x2="740" y2="790" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fecaca"/><stop offset=".5" stop-color="#ef4444"/><stop offset="1" stop-color="#991b1b"/></linearGradient></defs><path fill="url(#hbf-cloud)" d="M316 904c-88 0-158-70-158-158s70-164 158-164c-5-73 49-135 114-135 17 0 33 3 46 8 34-87 121-148 220-148 127 0 232 101 237 228 12-2 24-3 37-3 86 0 154 69 154 154 0 119-88 218-196 218H316Z"/><rect x="158" y="620" width="966" height="284" fill="url(#hbf-shade)" clip-path="url(#hbf-clip)"/><path fill="url(#hbf-bolt)" d="M935 535 733 716l119-29-14 98 190-187-123 78 30-141Z"/><g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round"><path d="M166 759h198c10 0 19-4 25-12l24-32 55 75 80-277 73 349 64-190 47 87h187" stroke-width="31"/><circle cx="962" cy="759" r="32" stroke-width="31"/></g></svg>`;

// GitHub mark (Octicon), inlined so the footer link needs no external asset.
const githubIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true" focusable="false" style="vertical-align:-2px"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;

function renderSparkline(points: number[]): string {
	if (points.length < 2) return '';
	const w = 80, h = 24, pad = 2;
	const max = Math.max(...points);
	const min = Math.min(...points);
	const range = max - min || 1;
	const step = (w - pad * 2) / (points.length - 1);
	const pts = points
		.map((v, i) => {
			const x = pad + i * step;
			const y = pad + (1 - (v - min) / range) * (h - pad * 2);
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(' ');
	return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="vertical-align:middle;overflow:visible"><polyline points="${pts}" fill="none" stroke="#4ade80" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

export function buildStatusPage({
	nowMs,
	monitors,
	uptimeDays,
	latencyPoints,
	activeIncidents,
	allIncidents,
	maintenanceWindows,
	d1Usage,
	session,
	authEnabled,
	scope,
	workerName,
	version,
	siteTitle,
	host,
}: {
	nowMs: number;
	monitors: MonitorDbRow[];
	uptimeDays: UptimeDayRow[];
	latencyPoints: LatencyRow[];
	activeIncidents: IncidentRow[];
	allIncidents: IncidentRow[];
	maintenanceWindows: MaintenanceWindowRow[];
	d1Usage: UsageSnapshot | null;
	session: Session | null;
	authEnabled: boolean;
	scope: 'public' | 'all';
	workerName: string;
	version: string;
	siteTitle: string;
	host: string;
}): string {
	const uptimeByMonitor = new Map<string, Map<string, number>>();
	for (const row of uptimeDays) {
		if (!uptimeByMonitor.has(row.monitor_id)) uptimeByMonitor.set(row.monitor_id, new Map());
		uptimeByMonitor.get(row.monitor_id)!.set(row.day, row.avg_up);
	}

	const latencyByMonitor = new Map<string, number[]>();
	for (const row of latencyPoints) {
		if (!latencyByMonitor.has(row.monitor_id)) latencyByMonitor.set(row.monitor_id, []);
		latencyByMonitor.get(row.monitor_id)!.push(row.latency_ms);
	}

	const activeByMonitor = new Map<string, IncidentRow>();
	for (const inc of activeIncidents) activeByMonitor.set(inc.monitor_id, inc);

	// Partition maintenance windows into active (now within range) and upcoming; a window with no
	// affected monitors is global (covers every monitor).
	const maintActiveMonitorIds = new Set<string>();
	let maintGlobalActive = false;
	const activeWindows: MaintenanceWindowRow[] = [];
	const upcomingWindows: MaintenanceWindowRow[] = [];
	for (const w of maintenanceWindows) {
		const start = new Date(w.starts_at).getTime();
		const end = new Date(w.ends_at).getTime();
		if (start <= nowMs && nowMs < end) {
			activeWindows.push(w);
			if (w.monitor_ids.length === 0) maintGlobalActive = true;
			else for (const id of w.monitor_ids) maintActiveMonitorIds.add(id);
		} else if (start > nowMs) {
			upcomingWindows.push(w);
		}
	}
	const monitorUnderMaintenance = (id: string) => maintGlobalActive || maintActiveMonitorIds.has(id);

	// Expand each incident onto every UTC day it spans ("monitorId:YYYY-MM-DD" keys), so the
	// 90-day bars can colour a day by the incidents that touched it, not just uptime ratio.
	const todayStr = new Date(nowMs).toISOString().slice(0, 10);
	const incidentsByMonitorDay = new Map<string, IncidentRow[]>();
	for (const inc of allIncidents) {
		const startDay = new Date(inc.started_at);
		startDay.setUTCHours(0, 0, 0, 0);
		const endDay = inc.resolved_at ? new Date(inc.resolved_at) : new Date(nowMs);
		// An incident resolved at exactly midnight had zero duration on that day — exclude it
		if (inc.resolved_at && endDay.getUTCHours() === 0 && endDay.getUTCMinutes() === 0 && endDay.getUTCSeconds() === 0 && endDay.getUTCMilliseconds() === 0) {
			endDay.setUTCDate(endDay.getUTCDate() - 1);
		}
		endDay.setUTCHours(23, 59, 59, 999);
		const cursor = new Date(startDay);
		while (cursor <= endDay) {
			const dayStr = cursor.toISOString().slice(0, 10);
			if (dayStr > todayStr) break;
			const key = `${inc.monitor_id}:${dayStr}`;
			const list = incidentsByMonitorDay.get(key) ?? [];
			list.push(inc);
			incidentsByMonitorDay.set(key, list);
			cursor.setUTCDate(cursor.getUTCDate() + 1);
		}
	}

	const incMapObj: Record<string, Array<{ severity: string; started_at: string; resolved_at: string | null; reason: string | null }>> = {};
	for (const [key, list] of incidentsByMonitorDay.entries()) {
		incMapObj[key] = list.map((inc) => ({ severity: inc.severity, started_at: inc.started_at, resolved_at: inc.resolved_at ?? null, reason: inc.reason ?? null }));
	}
	// Embedded into an inline <script> for tooltips — escape sequences that could break out of
	// the script context (</script> via "<", and the JS line separators U+2028/U+2029).
	const incMapJson = JSON.stringify(incMapObj)
		.replace(/</g, '\\u003c')
		.replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
		.replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');

	const hasDown = monitors.some((m) => m.status === 'down');
	const hasDegraded = monitors.some((m) => m.status === 'degraded');
	const overallText = hasDown ? 'Partial Outage' : hasDegraded ? 'Degraded Performance' : 'All Systems Operational';
	const bannerBg = hasDown ? '#fef2f2' : hasDegraded ? '#fffbeb' : '#f0fdf4';
	const bannerBorder = hasDown ? '#fecaca' : hasDegraded ? '#fde68a' : '#bbf7d0';
	const bannerColor = hasDown ? '#b91c1c' : hasDegraded ? '#b45309' : '#15803d';

	const today = new Date(nowMs);

	function renderBars(monitorId: string): string {
		const days = uptimeByMonitor.get(monitorId);
		let bars = '';
		for (let i = 89; i >= 0; i--) {
			const d = new Date(today);
			d.setUTCDate(d.getUTCDate() - i);
			const day = d.toISOString().slice(0, 10);
			const avg = days?.get(day);
			const tip = avg !== undefined ? `${(avg * 100).toFixed(1)}% uptime` : 'No data';
			const key = `${monitorId}:${day}`;
			// OpenStatus-style daily proportion: each bar is a vertical stack sized by the day's
			// uptime ratio — green base for the healthy portion, with a degraded (amber) or down
			// (red) segment for the rest. Incidents stay in the tooltip only and never repaint the
			// bar, so a short warning on an otherwise healthy day no longer marks the whole day.
			let segs: string;
			if (avg === undefined) {
				segs = `<span class="bar-seg" style="height:100%;background:#d4d4d8"></span>`;
			} else if (avg >= 1) {
				segs = `<span class="bar-seg" style="height:100%;background:#4ade80"></span>`;
			} else {
				// Floor the down segment so even a tiny outage (e.g. 99.9%) stays visible on the
				// 32px bar. Amber for degraded days, red once the day drops below 75% uptime.
				const downPct = Math.max((1 - avg) * 100, 12);
				const downColor = avg >= 0.75 ? '#fbbf24' : '#f87171';
				segs =
					`<span class="bar-seg" style="height:${downPct.toFixed(2)}%;background:${downColor}"></span>` +
					`<span class="bar-seg" style="height:${(100 - downPct).toFixed(2)}%;background:#4ade80"></span>`;
			}
			const safeKey = escHtml(key);
			const safeTip = escHtml(day + ': ' + tip);
			bars += `<span class="bar" data-age="${i}" data-key="${safeKey}" data-tip="${safeTip}" aria-label="${safeTip}">${segs}</span>`;
		}
		return bars;
	}

	function uptimeStat(monitorId: string, days: number): string {
		const data = uptimeByMonitor.get(monitorId);
		if (!data) return '—';
		const cutoff = new Date(today);
		cutoff.setUTCDate(cutoff.getUTCDate() - days);
		const cutoffStr = cutoff.toISOString().slice(0, 10);
		const vals = [...data.entries()].filter(([d]) => d >= cutoffStr).map(([, v]) => v);
		if (!vals.length) return '—';
		return ((vals.reduce((a, b) => a + b, 0) / vals.length) * 100).toFixed(2) + '%';
	}

	function avgLatency(monitorId: string): string {
		const pts = latencyByMonitor.get(monitorId);
		if (!pts?.length) return '—';
		return Math.round(pts.reduce((a, b) => a + b, 0) / pts.length) + ' ms';
	}

	function statusDot(status: string | null, paused: boolean): string {
		if (paused) return `<span class="dot-line"><span class="status-dot unknown"></span></span>`;
		const s = status ?? 'unknown';
		const cls = s === 'up' ? 'up' : s === 'degraded' ? 'degraded' : s === 'down' ? 'down' : 'unknown';
		const pulse = s === 'down' ? ' dot-pulse' : '';
		return `<span class="dot-line"><span class="status-dot ${cls}${pulse}"></span></span>`;
	}

	function statusLabel(status: string | null, paused: boolean): string {
		if (paused) return `<span style="font-size:13px;font-weight:600;color:#71717a">Paused</span>`;
		const s = status ?? 'unknown';
		const [text, color] =
			s === 'up' ? ['Operational', '#16a34a'] :
			s === 'degraded' ? ['Degraded', '#d97706'] :
			s === 'down' ? ['Outage', '#dc2626'] :
			['Unknown', '#71717a'];
		return `<span style="font-size:13px;font-weight:600;color:${color}">${text}</span>`;
	}

	function typeBadge(type: string): string {
		return `<span style="font-size:11px;font-weight:600;padding:2px 6px;border-radius:4px;background:#f4f4f5;color:#71717a;text-transform:uppercase;letter-spacing:0.04em">${escHtml(type)}</span>`;
	}

	function visibilityBadge(visibility: string): string {
		if (visibility !== 'private') return '';
		return `<span style="font-size:11px;font-weight:600;padding:2px 6px;border-radius:4px;background:#fef3c7;color:#92400e;text-transform:uppercase;letter-spacing:0.04em">Private</span>`;
	}

	// Marks monitors probed over a Cloudflare Workers VPC binding (mode: internal) rather than the
	// public internet.
	function internalBadge(mode: string): string {
		if (mode !== 'internal') return '';
		return `<span title="Probed privately via a Cloudflare Workers VPC binding" style="font-size:11px;font-weight:600;padding:2px 6px;border-radius:4px;background:#e0e7ff;color:#3730a3;text-transform:uppercase;letter-spacing:0.04em;cursor:default">Internal</span>`;
	}

	function sslBadge(notAfter: string | null, issuer: string | null): string {
		if (!notAfter) return '';
		const days = Math.floor((new Date(notAfter).getTime() - Date.now()) / 86_400_000);
		const color = days < 7 ? '#dc2626' : days < 30 ? '#d97706' : '#16a34a';
		const label = days < 0 ? 'cert expired' : `cert ${days}d`;
		const title = issuer ? `Issuer: ${issuer} · Expires: ${new Date(notAfter).toLocaleDateString()}` : `Expires: ${new Date(notAfter).toLocaleDateString()}`;
		return `<span title="${escHtml(title)}" style="font-size:11px;padding:2px 6px;border-radius:4px;background:${color}1a;color:${color};font-weight:600;cursor:default">🔒 ${label}</span>`;
	}

	const statusOrder: Record<string, number> = { down: 0, degraded: 1, up: 2 };

	const sortedMonitors = [...monitors].sort((a, b) => {
		const vA = a.visibility === 'public' ? 0 : 1;
		const vB = b.visibility === 'public' ? 0 : 1;
		if (vA !== vB) return vA - vB;
		const sA = a.paused === 1 ? 4 : (statusOrder[a.status ?? ''] ?? 3);
		const sB = b.paused === 1 ? 4 : (statusOrder[b.status ?? ''] ?? 3);
		if (sA !== sB) return sA - sB;
		return a.name.localeCompare(b.name);
	});

	const maintDot = `<span class="dot-line"><span class="status-dot maint"></span></span>`;
	const maintLabel = `<span style="font-size:13px;font-weight:600;color:#1e40af">🔧 Maintenance</span>`;

	const monitorsHtml = sortedMonitors.map((m, i) => {
		const pts = latencyByMonitor.get(m.id) ?? [];
		const inc = activeByMonitor.get(m.id);
		const inMaint = monitorUnderMaintenance(m.id);
		const sparkline = pts.length >= 3 ? renderSparkline(pts.slice(-40)) : '';
		const divider = (m.visibility === 'private' && (i === 0 || sortedMonitors[i - 1].visibility === 'public'))
			? `<div style="margin:24px 0 16px;display:flex;align-items:center;gap:12px">
				<span style="font-size:12px;font-weight:600;color:#92400e;text-transform:uppercase;letter-spacing:0.06em">Private</span>
				<div style="flex:1;height:1px;background:#fde68a"></div>
			</div>`
			: '';
		return divider + `
		<div class="monitor-row">
			<div class="monitor-header">
				<div style="display:flex;align-items:flex-start;gap:9px">
					${inMaint ? maintDot : statusDot(m.status, m.paused === 1)}
					<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
						<span class="monitor-name">${escHtml(m.name)}</span>
						${typeBadge(m.type)}
						${visibilityBadge(m.visibility)}
						${internalBadge(m.mode)}
						${sslBadge(m.ssl_not_after, m.ssl_issuer)}
					</div>
				</div>
				<div style="display:flex;align-items:center;gap:14px">
					${inMaint ? maintLabel : statusLabel(m.status, m.paused === 1)}
					<span class="meta-text">${m.paused === 1 ? `last checked ${timeAgo(m.last_check_at)}` : `checked ${timeAgo(m.last_check_at)}`}</span>
				</div>
			</div>
			${inc ? `<div class="incident-inline">⚠ Incident ongoing · started ${timeAgo(inc.started_at)}${inc.reason ? ` · ${escHtml(inc.reason)}` : ''}</div>` : ''}
			<div class="bars-row">${renderBars(m.id)}</div>
			<div class="bars-labels"><span class="bars-range-label">90 days ago</span><span>today</span></div>
			<div class="stats-row">
				<span>24h <b>${uptimeStat(m.id, 1)}</b></span>
				<span>7d <b>${uptimeStat(m.id, 7)}</b></span>
				<span>30d <b>${uptimeStat(m.id, 30)}</b></span>
				<span>avg latency <b>${avgLatency(m.id)}</b></span>
				${sparkline ? `<span class="sparkline-wrap">${sparkline}</span>` : ''}
			</div>
		</div>`;
	}).join('\n');

	const activeIncidentsByMonitor = new Map<string, IncidentRow[]>();
	for (const inc of activeIncidents) {
		const list = activeIncidentsByMonitor.get(inc.monitor_id) ?? [];
		list.push(inc);
		activeIncidentsByMonitor.set(inc.monitor_id, list);
	}

	const activeIncidentsCardHtml = activeIncidents.length > 0 ? `
<section class="incident-card" aria-label="Active incidents">
	<div class="incident-card-header">
		<h2 class="incident-title">Active Incidents</h2>
		<span class="incident-subtitle">${activeIncidents.length} ongoing ${activeIncidents.length === 1 ? 'incident' : 'incidents'}</span>
	</div>
	<div class="incident-groups">
	${[...activeIncidentsByMonitor.entries()].map(([monitorId, incidents]) => {
		const monName = monitors.find((m) => m.id === monitorId)?.name ?? monitorId;
		return `<div class="incident-group">
			<div class="incident-group-name">${escHtml(monName)}</div>
			${incidents.map((inc) => {
				const sevClass = inc.severity === 'warning' ? 'sev-warning' : 'sev-critical';
				return `<div class="incident-line ${sevClass}">
					<span class="sev-badge">${escHtml(inc.severity)}</span>
					<span class="incident-line-reason">${inc.reason ? escHtml(inc.reason) : 'Incident ongoing'}</span>
					<span class="incident-line-time">started ${timeAgo(inc.started_at)}</span>
				</div>`;
			}).join('\n')}
		</div>`;
	}).join('\n')}
	</div>
</section>` : '';

	const fmtWhen = (s: string) => new Date(s).toUTCString().replace(' GMT', ' UTC');
	const monitorName = (id: string) => monitors.find((m) => m.id === id)?.name ?? id;
	const bannerWindows = [
		...activeWindows.map((w) => ({ w, active: true })),
		...upcomingWindows.map((w) => ({ w, active: false })),
	];
	const maintenanceInHeaderHtml = bannerWindows.length > 0 ? `
<div style="padding-top:16px;border-top:1px solid ${bannerBorder};margin-top:16px">
	${bannerWindows.map(({ w, active }) => {
		const scope = w.monitor_ids.length === 0 ? 'All services' : w.monitor_ids.map((id) => escHtml(monitorName(id))).join(', ');
		const when = active
			? `in progress · until ${escHtml(fmtWhen(w.ends_at))}`
			: `scheduled · ${escHtml(fmtWhen(w.starts_at))} → ${escHtml(fmtWhen(w.ends_at))}`;
		return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:6px 0">
			<span style="font-size:14px;font-weight:600;color:#1e40af">🔧 ${escHtml(w.title)}${w.body ? ` <span style="font-weight:400;color:#52525b">— ${escHtml(w.body)}</span>` : ''}</span>
			<span class="meta-text">${when} · ${scope}</span>
		</div>`;
	}).join('\n')}
</div>` : '';


	function infoCard(label: string, value: string, valueColor: string, sub?: string): string {
		// Escape all dynamic strings: some callers pass CF-supplied data (email addresses, VPC names).
		return `<div class="usage-card">
			<div class="usage-label">${escHtml(label)}</div>
			<div style="font-size:20px;font-weight:700;color:${valueColor};line-height:1.2">${escHtml(value)}</div>
			${sub ? `<div style="font-size:12px;color:var(--c-text-faint);margin-top:3px">${escHtml(sub)}</div>` : ''}
		</div>`;
	}

	const fmtPct = (n: number): string => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2)) + '%';
	const budgetColor = (pct: number): string => (pct > 80 ? 'var(--c-down)' : pct > 50 ? 'var(--c-degraded)' : 'var(--c-up)');

	// Inline area+line sparkline from a numeric series (values are trusted numbers from the CF API).
	function sparkline(values: number[], stroke: string): string {
		if (values.length < 2) return '';
		const w = 100, h = 22, max = Math.max(1, ...values);
		const step = w / (values.length - 1);
		const line = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`).join(' ');
		return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">`
			+ `<polygon points="0,${h} ${line} ${w},${h}" fill="${stroke}" opacity="0.10"/>`
			+ `<polyline points="${line}" fill="none" stroke="${stroke}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
	}

	// A budget metric: label + %, current value / limit, fill bar, and an optional 24h sparkline.
	function budgetCard(label: string, value: string, limit: string, pct: number, spark?: number[]): string {
		const color = budgetColor(pct);
		return `<div class="usage-card">
			<div class="usage-cardhead"><span class="usage-label">${escHtml(label)}</span><span class="usage-pct" style="color:${color}">${fmtPct(pct)}</span></div>
			<div class="usage-figure"><span class="usage-value">${escHtml(value)}</span><span class="meta-text">/ ${escHtml(limit)}</span></div>
			<div class="usage-track"><div class="usage-fill" style="width:${Math.min(pct, 100).toFixed(1)}%;background:${color}"></div></div>
			${spark && spark.length > 1 ? `<div class="usage-spark">${sparkline(spark, color)}</div>` : ''}
		</div>`;
	}

	const dot = (color: string): string => `<span class="dot" style="background:${color}"></span>`;
	const chip = (text: string, color: string): string => `<span class="chip">${dot(color)}${escHtml(text)}</span>`;

	const usageHtml = d1Usage ? (() => {
		const { d1, d1Percent, workers, queues, email, vpc, trends, fetchedAt, plan } = d1Usage;
		const p = plan ?? { label: 'Free', rowsRead: 5_000_000, rowsWritten: 100_000, storageBytes: 5_000_000_000 };
		const workersReqPct = workers ? (workers.requests / workersFreeLimit.requestsPerDay) * 100 : 0;
		const d1ReadLimit = p.rowsRead >= 1_000_000_000 ? `${(p.rowsRead / 1_000_000_000).toFixed(0)}B` : `${(p.rowsRead / 1_000_000).toFixed(0)}M`;
		const d1WriteLimit = p.rowsWritten >= 1_000_000 ? `${(p.rowsWritten / 1_000_000).toFixed(0)}M` : `${(p.rowsWritten / 1_000).toFixed(0)}K`;
		// Write-rate derived from elapsed time today, assuming the cron fires once per minute (so one
		// tick ≈ one minute). Avoids depending on a per-tick count from GraphQL.
		const minutesElapsedToday = Math.floor((nowMs - Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate())) / 60_000);
		const avgRowsPerMin = minutesElapsedToday > 0 ? d1.rowsWritten / minutesElapsedToday : null;
		const estimatedRowsPerHour = avgRowsPerMin !== null ? Math.round(avgRowsPerMin * 60) : null;

		const ageMs = fetchedAt ? nowMs - Date.parse(fetchedAt) : null;
		const updatedAgo = ageMs == null ? '' : ageMs < 60_000 ? `updated ${Math.max(0, Math.floor(ageMs / 1000))}s ago · ` : `updated ${Math.floor(ageMs / 60_000)}m ago · `;

		const sumItem = (k: string, v: string, color?: string): string =>
			`<div class="sum-item"><span class="sum-k">${escHtml(k)}</span><span class="sum-v"${color ? ` style="color:${color}"` : ''}>${escHtml(v)}</span></div>`;
		const summary = `<div class="usage-summary">
			${sumItem('D1 writes', fmtPct(d1Percent.rowsWritten), budgetColor(d1Percent.rowsWritten))}
			${sumItem('D1 reads', fmtPct(d1Percent.rowsRead), budgetColor(d1Percent.rowsRead))}
			${sumItem('Worker reqs', workers ? fmtPct(workersReqPct) : '—', workers ? budgetColor(workersReqPct) : undefined)}
			${sumItem('Errors', workers ? String(workers.errors) : '—', workers ? (workers.errors > 0 ? 'var(--c-down)' : 'var(--c-up)') : undefined)}
			${sumItem('Queue', queues ? `${formatNumber(queues.messagesProduced)} ↑ / ${formatNumber(queues.messagesConsumed)} ↓` : '—')}
			${sumItem('Resets in', usageResetsIn(nowMs))}
		</div>`;

		return `
	<section class="section">
		<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
			<h2 class="section-title" style="margin:0">Infrastructure Usage</h2>
			<span class="meta-text">${updatedAgo}${p.label} plan</span>
		</div>
		${summary}
		<div class="usage-sublabel">D1 Database · ${d1ReadLimit} reads / ${d1WriteLimit} writes / ${formatBytes(p.storageBytes)} / day</div>
		<div class="usage-grid">
			${budgetCard('Rows Read', formatNumber(d1.rowsRead), `${d1ReadLimit} / day`, d1Percent.rowsRead, trends?.d1RowsRead)}
			${budgetCard('Rows Written', formatNumber(d1.rowsWritten), `${d1WriteLimit} / day`, d1Percent.rowsWritten, trends?.d1RowsWritten)}
			${budgetCard('Storage', formatBytes(d1.databaseSizeBytes), formatBytes(p.storageBytes), d1Percent.storage)}
			${avgRowsPerMin !== null
				? infoCard('Avg Rows/Min', avgRowsPerMin.toFixed(1), 'var(--c-text)', 'written per minute')
				: infoCard('Avg Rows/Min', '—', 'var(--c-text-faint)', 'awaiting data')}
			${estimatedRowsPerHour !== null
				? infoCard('Est Rows/Hour', formatNumber(estimatedRowsPerHour), 'var(--c-text)', 'at current rate')
				: infoCard('Est Rows/Hour', '—', 'var(--c-text-faint)', '')}
		</div>
		<div class="usage-sublabel" style="margin-top:16px">Workers · 100K requests / day</div>
		<div class="usage-grid">
			${workers
				? budgetCard('Requests', formatNumber(workers.requests), '100K / day', workersReqPct, trends?.workerRequests)
				: infoCard('Requests', '—', 'var(--c-text-faint)', 'no API data')}
			${infoCard('Errors', workers ? String(workers.errors) : '—', workers && workers.errors > 0 ? 'var(--c-down)' : 'var(--c-up)', workers ? (workers.errors > 0 ? 'today' : 'clean') : '')}
			${infoCard('Subrequests', workers ? formatNumber(workers.subrequests) : '—', 'var(--c-text)', workers ? 'fetch calls today' : '')}
			${queues
				? infoCard('Messages In', formatNumber(queues.messagesProduced), 'var(--c-text)', 'produced today')
				: infoCard('Messages In', '—', 'var(--c-text-faint)', 'no API data')}
			${queues
				? infoCard('Messages Out', formatNumber(queues.messagesConsumed), 'var(--c-text)', 'consumed today')
				: infoCard('Messages Out', '—', 'var(--c-text-faint)', 'no API data')}
		</div>
	${email ? `
	<div class="usage-sublabel" style="margin-top:16px">Email Routing · destination addresses</div>
	<div class="usage-row">
		<span class="usage-rowlabel">${dot('var(--c-up)')}${email.verified.length} verified</span>
		<div class="usage-chips">${email.verified.length > 0 ? email.verified.map((a) => chip(a, 'var(--c-up)')).join('') : '<span class="meta-text">none</span>'}</div>
	</div>
	${email.pending.length > 0 ? `<div class="usage-row">
		<span class="usage-rowlabel">${dot('var(--sev-warning)')}${email.pending.length} pending</span>
		<div class="usage-chips">${email.pending.map((a) => chip(a, 'var(--sev-warning)')).join('')}</div>
	</div>
	<div class="usage-note">Unverified addresses are silently dropped at send time.</div>` : ''}` : ''}
	${vpc && vpc.length > 0 ? `
	<div class="usage-sublabel" style="margin-top:16px">Internal Networks · Workers VPC</div>
	<div class="usage-grid">
		${vpc.map((s) => {
			const color = s.status === 'healthy' || s.status === 'active' ? 'var(--c-up)'
				: s.status === 'degraded' ? 'var(--c-degraded)'
				: s.status === 'down' ? 'var(--c-down)'
				: 'var(--c-unknown)'; // inactive / null / unknown
			return `<div class="usage-card">
				<div class="usage-label">${escHtml(s.name ?? s.binding)}</div>
				<div class="pill" style="font-size:15px;font-weight:700;color:var(--c-text);margin-top:2px">${dot(color)}${escHtml(s.status ?? 'unknown')}</div>
				<div style="font-size:12px;color:var(--c-text-faint);margin-top:4px">tunnel · ${escHtml(s.binding)}</div>
			</div>`;
		}).join('')}
	</div>` : ''}
	</section>`;
	})() : '';

	const faviconHref = `data:image/svg+xml,${encodeURIComponent(brandIconSvg)}`;
	const versionLabel = version ? `heartbeatflare v${version}` : 'heartbeatflare';
	const pageTitle = siteTitle.trim() || 'HeartbeatFlare';

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="${escHtml(faviconHref)}">
<title>${escHtml(pageTitle)} Status</title>
<style>
:root{--c-up:#22c55e;--c-down:#ef4444;--c-degraded:#f59e0b;--c-unknown:#a1a1aa;--c-maint:#3b82f6;--sev-critical:#ef4444;--sev-warning:#f59e0b;--sev-critical-bg:#fef2f2;--sev-warning-bg:#fffbeb;--c-card:#fff;--c-bg:#fafafa;--c-border:#e4e4e7;--c-border-soft:#f4f4f5;--c-text:#18181b;--c-text-muted:#71717a;--c-text-faint:#a1a1aa}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--c-bg);color:var(--c-text);line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.container{max-width:780px;margin:0 auto;padding:0 20px}
header{background:${bannerBg};border-bottom:1px solid ${bannerBorder};padding:28px 0 24px;margin-bottom:32px}
.header-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.logo{font-size:17px;font-weight:700;color:var(--c-text);display:flex;align-items:center;gap:9px}
.brand-icon{width:30px;height:30px;border-radius:7px;display:block;flex-shrink:0}
.brand-icon svg{width:100%;height:100%;display:block}
.overall-badge{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;color:${bannerColor}}
.overall-dot{width:11px;height:11px;border-radius:50%;background:${bannerColor};flex-shrink:0}
.meta-text{font-size:12px;color:var(--c-text-faint)}
.section{margin-bottom:28px}
.section-title{font-size:11px;font-weight:700;color:var(--c-text-faint);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:10px}
.status-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.status-dot.up{background:var(--c-up)}
.status-dot.down{background:var(--c-down)}
.status-dot.degraded{background:var(--c-degraded)}
.status-dot.unknown{background:var(--c-unknown)}
.status-dot.maint{background:var(--c-maint)}
.dot-line{display:inline-flex;align-items:center;align-self:flex-start;height:22px;flex-shrink:0}
.incident-card{background:var(--c-card);border:1px solid var(--c-border);border-radius:10px;padding:16px 18px;margin:-12px 0 24px}
.incident-card-header{display:flex;align-items:baseline;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.incident-title{font-size:14px;font-weight:700;color:var(--c-text);margin:0}
.incident-subtitle{font-size:12px;color:var(--c-text-faint)}
.incident-groups{display:flex;flex-direction:column;gap:14px}
.incident-group-name{font-size:13px;font-weight:700;color:var(--c-text);margin-bottom:6px}
.incident-line{display:flex;align-items:center;gap:10px;padding:8px 12px;border-left:3px solid var(--c-unknown);background:var(--c-border-soft);border-radius:0 6px 6px 0}
.incident-line+.incident-line{margin-top:6px}
.incident-line.sev-critical{border-left-color:var(--sev-critical);background:var(--sev-critical-bg)}
.incident-line.sev-warning{border-left-color:var(--sev-warning);background:var(--sev-warning-bg)}
.sev-badge{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;border-radius:4px;color:#fff;flex-shrink:0}
.incident-line.sev-critical .sev-badge{background:var(--sev-critical)}
.incident-line.sev-warning .sev-badge{background:var(--sev-warning);color:#3f2d00}
.incident-line-reason{flex:1;min-width:0;font-size:13px;color:var(--c-text);word-break:break-word}
.incident-line-time{flex-shrink:0;white-space:nowrap;font-size:12px;color:var(--c-text-faint)}
.monitor-row{background:var(--c-card);border:1px solid var(--c-border);border-radius:10px;padding:16px 18px;margin-bottom:8px}
.monitor-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:11px;gap:12px}
.monitor-name{font-size:15px;font-weight:600}
.incident-inline{font-size:12px;color:#b45309;background:var(--sev-warning-bg);border:1px solid #fde68a;border-radius:6px;padding:6px 10px;margin-bottom:10px}
.bars-row{display:flex;gap:2px;margin-bottom:3px;overflow:hidden}
.bar{flex:1;min-width:4px;max-width:20px;height:32px;border-radius:2px;cursor:default;transition:opacity .12s;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden}
.bar-seg{width:100%;flex-shrink:0}
.bar:hover{opacity:.7}
#bar-tt{position:fixed;z-index:100;pointer-events:none;background:#18181b;color:#f4f4f5;border-radius:8px;padding:10px 14px;font-size:12px;max-width:280px;box-shadow:0 4px 16px rgba(0,0,0,.35);line-height:1.5;white-space:normal}
#bar-tt .tt-row+.tt-row{border-top:1px solid #3f3f46;margin-top:6px;padding-top:6px}
#bar-tt .tt-sev{font-size:10px;font-weight:700;text-transform:uppercase;padding:1px 5px;border-radius:3px;margin-right:4px}
#bar-tt .tt-sev.crit{background:#991b1b;color:#fee2e2}
#bar-tt .tt-sev.warn{background:#78350f;color:#fef9c3}
.bars-labels{display:flex;justify-content:space-between;font-size:11px;color:var(--c-text-faint);margin-bottom:6px}
.range-picker{display:flex;gap:3px}
.range-btn{font-size:11px;font-weight:600;padding:3px 9px;border-radius:5px;border:1px solid var(--c-border);background:var(--c-card);color:var(--c-text-muted);cursor:pointer;transition:all .12s;line-height:1.6}
.range-btn:hover{border-color:var(--c-text-faint);color:var(--c-text)}
.range-btn.active{background:var(--c-text);color:#fff;border-color:var(--c-text)}
.range-btn:disabled{opacity:.4;cursor:not-allowed}
.stats-row{display:flex;align-items:center;gap:14px;font-size:12px;color:var(--c-text-muted);flex-wrap:wrap}
.stats-row b{color:var(--c-text);font-weight:600}
.sparkline-wrap{display:flex;align-items:center}
.usage-sublabel{font-size:11px;color:var(--c-text-faint);margin-bottom:8px}
.usage-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
.usage-card{background:var(--c-card);border:1px solid var(--c-border);border-radius:8px;padding:14px 16px}
.usage-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--c-text-faint);margin-bottom:8px}
.usage-summary{display:flex;flex-wrap:wrap;gap:10px 22px;padding:12px 16px;background:var(--c-card);border:1px solid var(--c-border);border-radius:8px;margin-bottom:14px}
.sum-item{display:flex;flex-direction:column;gap:2px}
.sum-k{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--c-text-faint)}
.sum-v{font-size:15px;font-weight:700;color:var(--c-text)}
.usage-cardhead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
.usage-cardhead .usage-label{margin-bottom:0}
.usage-pct{font-size:12px;font-weight:700}
.usage-figure{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;margin-bottom:6px}
.usage-value{font-weight:700;color:var(--c-text)}
.usage-track{height:5px;background:var(--c-border-soft);border-radius:3px;overflow:hidden}
.usage-fill{height:100%;border-radius:3px}
.usage-spark{margin-top:8px;line-height:0}
.spark{width:100%;height:22px;display:block}
.usage-row{display:flex;align-items:flex-start;gap:12px;margin-bottom:8px;flex-wrap:wrap}
.usage-rowlabel{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:var(--c-text-muted);white-space:nowrap;padding-top:3px}
.usage-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--c-text-muted);background:var(--c-border-soft);border-radius:999px;padding:3px 10px}
.pill{display:inline-flex;align-items:center;gap:6px}
.dot{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block}
.usage-note{font-size:11px;color:var(--sev-warning);margin-top:2px;margin-bottom:4px}
footer{border-top:1px solid var(--c-border);padding:20px 0;margin-top:8px}
.footer-inner{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.dot-pulse{animation:pulse 2s ease-in-out infinite}
.month-nav{display:flex;align-items:center;justify-content:center;gap:8px;padding:0 0 16px}
.month-nav .month-label{font-weight:600;font-size:14px;min-width:110px;text-align:center;color:var(--c-text)}
.events{display:flex;flex-direction:column}
.day-group+.day-group{margin-top:12px}
.day-header{display:flex;align-items:center;gap:8px;padding:14px 0 10px;border-bottom:1px solid var(--c-border-soft)}
.day-header .date{font-size:15px;font-weight:700;color:var(--c-text)}
.day-header .relative{display:inline-block;font-size:11px;color:var(--c-text-muted);background:var(--c-border-soft);border-radius:5px;padding:2px 7px}
.event{padding:14px 0}
.event+.event{border-top:1px solid var(--c-border-soft)}
.event-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.event-title .name{font-size:16px;font-weight:600;color:var(--c-text)}
.event-card{background:var(--c-card);border:1px solid var(--c-border);border-radius:10px;padding:16px 18px 0}
.update{position:relative;display:grid;grid-template-columns:18px 1fr;gap:11px;padding-bottom:22px}
.update:not(:last-child)::before{content:"";position:absolute;left:5px;top:15px;bottom:-2px;width:1px;background:#d4d4d8}
.update .marker{width:10px;height:10px;margin-top:5px;border-radius:50%;background:var(--c-unknown);flex-shrink:0}
.update-title{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.update-title .label{font-size:14px;font-weight:700}
.update-title .time{font-size:12px;color:#a1a1aa;font-family:"SF Mono",ui-monospace,monospace}
.update-body{margin-top:5px;font-size:13px;color:#52525b;font-family:"SF Mono",ui-monospace,monospace;line-height:1.55;word-break:break-word}
.update.resolved .marker{background:var(--c-up)}
.update.resolved::before{background:#86efac}
.update.resolved .label{color:#15803d}
.update.down .marker{background:var(--c-down)}
.update.down .label{color:#b91c1c}
.update.degraded .marker{background:var(--c-degraded)}
.update.degraded .label{color:#b45309}
@media(max-width:640px){.month-nav{flex-wrap:wrap}.day-header{padding:10px 0 8px}}
@media(max-width:640px){.incident-card{margin-top:-16px}.incident-line{flex-wrap:wrap}.incident-line-time{width:100%}}
</style>
</head>
<body>
<header>
<div class="container">
<div class="header-inner">
<div class="logo"><span class="brand-icon">${brandIconSvg}</span>${escHtml(pageTitle)}</div>
<div class="overall-badge"><span class="overall-dot"></span>${overallText}</div>
${session
	? `<div style="display:flex;align-items:center;gap:10px"><span class="meta-text" title="${escHtml(session.email)}">${escHtml(session.name)}</span><a href="/auth/logout" style="font-size:12px;font-weight:600;padding:5px 12px;border-radius:5px;border:1px solid #e4e4e7;background:#fff;color:#18181b;text-decoration:none">Sign out</a></div>`
	: `<a href="/auth/login" style="font-size:12px;font-weight:600;padding:5px 12px;border-radius:5px;border:1px solid #18181b;background:#18181b;color:#fff;text-decoration:none">Sign in</a>`}
</div>
${maintenanceInHeaderHtml}
</div>
</header>
<main class="container">
${activeIncidentsCardHtml}
<section class="section">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
<div class="range-picker">
<button class="range-btn tab-btn active" data-tab="monitors">Monitors (${monitors.length})</button>
<button class="range-btn tab-btn" data-tab="history">History</button>
</div>
</div>
<div id="tab-monitors">
${monitorsHtml}
</div>
<div id="tab-history" hidden>
<div id="history-list"></div>
<div id="history-pagination" style="display:flex;align-items:center;justify-content:center;gap:12px;padding:12px 0"></div>
</div>
</section>
${usageHtml}
</main>
<footer>
<div class="container">
<div class="footer-inner">
<span class="meta-text">${host}</span>
<span class="meta-text"><a href="https://github.com/HSGiGa/heartbeatflare" target="_blank" rel="noopener" style="color:#71717a;text-decoration:none;display:inline-flex;align-items:center;gap:5px">${githubIconSvg}${escHtml(versionLabel)}</a></span>
<span class="meta-text">Powered by <a href="https://workers.cloudflare.com" target="_blank" rel="noopener" style="color:#71717a;text-decoration:underline">Cloudflare Workers</a> · Built with <a href="https://claude.com/claude-code" target="_blank" rel="noopener" style="color:#71717a;text-decoration:underline">Claude</a> and <a href="https://openai.com/codex" target="_blank" rel="noopener" style="color:#71717a;text-decoration:underline">Codex</a></span>
</div>
</div>
</footer>
<div id="bar-tt" hidden></div>
<script>
(function(){
  var INC=${incMapJson};
  var SCOPE=${JSON.stringify(scope)};
  var tabMonitors=document.getElementById('tab-monitors');
  var tabHistory=document.getElementById('tab-history');
  var histList=document.getElementById('history-list');
  var histPager=document.getElementById('history-pagination');
  var histMonth=toMonthStr(new Date()),histMonths=[],histLoaded=false;

  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function fmtDur(s,e){if(!e)return'ongoing';var m=Math.floor((new Date(e)-new Date(s))/60000);if(m<60)return m+'m';var h=Math.floor(m/60);if(h<24)return h+'h '+(m%60)+'m';return Math.floor(h/24)+'d '+(h%24)+'h';}
  function fmtDay(s){return new Date(s).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});}
  function fmtTime(s){var d=new Date(s);return d.toLocaleDateString('en-US',{month:'long',day:'numeric',timeZone:'UTC'})+' at '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true,timeZone:'UTC'});}
  function fmtClock(s){return new Date(s).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true,timeZone:'UTC'});}
  function relAgo(s){var m=Math.floor((Date.now()-new Date(s).getTime())/60000);if(m<1)return'just now';if(m<60)return m+'m ago';var h=Math.floor(m/60);if(h<24)return h+'h ago';var d=Math.floor(h/24);if(d<30)return d+'d ago';var mo=Math.floor(d/30);if(mo<12)return mo+' month'+(mo>1?'s':'')+' ago';var y=Math.floor(d/365);return y+' year'+(y>1?'s':'')+' ago';}
  function toMonthStr(d){var m=d.getUTCMonth()+1;return d.getUTCFullYear()+'-'+(m<10?'0'+m:m);}
  function monthLabel(ym){return new Date(ym+'-01T00:00:00Z').toLocaleDateString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});}
  function navMonth(dir){var i=histMonths.indexOf(histMonth);if(i<0)return null;var j=i+dir;return j>=0&&j<histMonths.length?histMonths[j]:null;}
  function relDay(day){var diff=Math.floor((Date.now()-new Date(day+'T00:00:00Z').getTime())/86400000);if(diff===0)return'today';if(diff===1)return'yesterday';return diff+'d ago';}
  function renderUpdate(cls,label,time,body){return '<div class="update '+cls+'"><div class="marker"></div><div><div class="update-title"><span class="label">'+label+'</span><span class="time">'+time+'</span></div>'+(body?'<div class="update-body">'+body+'</div>':'')+'</div></div>';}

  function renderRows(rows){
    if(!rows.length)return'<div class="meta-text" style="padding:24px 0;text-align:center">No incidents recorded.</div>';
    var byDay={},days=[];
    rows.forEach(function(inc){
      var day=inc.started_at.slice(0,10);
      if(!byDay[day]){byDay[day]=[];days.push(day);}
      byDay[day].push(inc);
    });
    var h='<div class="events">';
    days.forEach(function(day){
      h+='<div class="day-group"><div class="day-header"><span class="date">'+fmtDay(day+'T00:00:00Z')+'</span><span class="relative">'+relDay(day)+'</span></div>';
      byDay[day].forEach(function(inc){
        var crit=inc.severity==='critical';
        var openCls=crit?'down':'degraded';
        var openLabel=crit?'Down':'Degraded';
        var ups='';
        if(inc.resolved_at){
          var dur=fmtDur(inc.started_at,inc.resolved_at);
          ups+=renderUpdate('resolved','Resolved',fmtTime(inc.resolved_at)+' (in '+dur+')','Recovered after '+dur+'.');
        }
        var openTime=fmtTime(inc.started_at)+(inc.resolved_at?' ('+fmtDur(inc.started_at,inc.resolved_at)+' earlier)':' (ongoing)');
        ups+=renderUpdate(openCls,openLabel,openTime,inc.reason?esc(inc.reason):'');
        var badge=inc.monitor_type?'<span style="font-size:11px;font-weight:600;padding:2px 6px;border-radius:4px;background:#f4f4f5;color:#71717a;text-transform:uppercase;letter-spacing:0.04em">'+esc(inc.monitor_type)+'</span>':'';
        h+='<article class="event">'+
          '<div class="event-content"><div class="event-title"><span class="name">'+esc(inc.monitor_name||inc.monitor_id)+'</span>'+badge+'</div>'+
          '<div class="event-card">'+ups+'</div></div>'+
        '</article>';
      });
      h+='</div>';
    });
    return h+'</div>';
  }

  function renderMonthNav(){
    var prev=navMonth(1),next=navMonth(-1);
    return '<div class="month-nav">'+
      '<button class="range-btn" id="hist-prev-month"'+(prev?'':' disabled')+'>&#8592; '+(prev?monthLabel(prev):'Earlier')+'</button>'+
      '<span class="month-label">'+monthLabel(histMonth)+'</span>'+
      '<button class="range-btn" id="hist-next-month"'+(next?'':' disabled')+'>'+(next?monthLabel(next):'Later')+' &#8594;</button>'+
    '</div>';
  }

  function loadHistory(month){
    histMonth=month;
    histList.innerHTML='<div class="meta-text" style="padding:24px 0;text-align:center">Loading…</div>';
    histPager.innerHTML='';
    fetch('/api/history?scope='+SCOPE+'&month='+month)
      .then(function(r){return r.json();})
      .then(function(data){
        histLoaded=true;
        var list=(data.months||[]).slice();
        [month,toMonthStr(new Date())].forEach(function(m){if(list.indexOf(m)<0)list.push(m);});
        histMonths=list.sort().reverse();
        histList.innerHTML=renderMonthNav()+renderRows(data.incidents);
        var p=document.getElementById('hist-prev-month'),n=document.getElementById('hist-next-month');
        if(p)p.addEventListener('click',function(){var t=navMonth(1);if(t)loadHistory(t);});
        if(n)n.addEventListener('click',function(){var t=navMonth(-1);if(t)loadHistory(t);});
      })
      .catch(function(){histList.innerHTML='<div class="meta-text" style="padding:24px 0;text-align:center">Failed to load.</div>';});
  }

  function activateTab(tab){
    var isHist=tab==='history';
    document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.toggle('active',b.dataset.tab===tab);});
    tabMonitors.hidden=isHist;
    tabHistory.hidden=!isHist;
    if(isHist&&!histLoaded)loadHistory(toMonthStr(new Date()));
  }
  function tabFromHash(){return location.hash.slice(1)==='history'?'history':'monitors';}
  document.querySelectorAll('.tab-btn').forEach(function(btn){
    btn.addEventListener('click',function(){
      var tab=btn.dataset.tab;
      if(location.hash.slice(1)===tab)activateTab(tab);
      else location.hash=tab;
    });
  });
  window.addEventListener('hashchange',function(){activateTab(tabFromHash());});
  activateTab(tabFromHash());

  var barTt=document.getElementById('bar-tt');
  function positionTt(e){
    var w=barTt.offsetWidth,h=barTt.offsetHeight;
    barTt.style.left=Math.min(e.clientX-w/2,window.innerWidth-w-8)+'px';
    barTt.style.top=(e.clientY>h+20?e.clientY-h-12:e.clientY+20)+'px';
  }
  document.querySelectorAll('.bar').forEach(function(b){
    b.style.cursor='default';
    b.addEventListener('mouseenter',function(e){
      var html='<div style="font-weight:600;margin-bottom:4px">'+esc(b.dataset.tip||'')+'</div>';
      var incs=INC[b.dataset.key||''];
      if(incs&&incs.length){
        incs.forEach(function(inc){
          var icon=inc.severity==='critical'?'🔴':'🟡';
          var range=fmtClock(inc.started_at)+' – '+(inc.resolved_at?fmtClock(inc.resolved_at)+' UTC':'ongoing');
          html+='<div class="tt-row">'+icon+' '+range+' · '+fmtDur(inc.started_at,inc.resolved_at)+(inc.reason?' — '+esc(inc.reason):'')+
          '</div>';
        });
      }
      barTt.innerHTML=html;barTt.hidden=false;positionTt(e);
    });
    b.addEventListener('mousemove',positionTt);
    b.addEventListener('mouseleave',function(){barTt.hidden=true;});
  });
})();
</script>
</body>
</html>`;
}
