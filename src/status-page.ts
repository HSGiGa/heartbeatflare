import type { MonitorDbRow, UptimeDayRow, LatencyRow, IncidentRow, Session, UsageSnapshot } from './types';
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
	d1Usage,
	session,
	authEnabled,
}: {
	nowMs: number;
	monitors: MonitorDbRow[];
	uptimeDays: UptimeDayRow[];
	latencyPoints: LatencyRow[];
	activeIncidents: IncidentRow[];
	allIncidents: IncidentRow[];
	d1Usage: UsageSnapshot | null;
	session: Session | null;
	authEnabled: boolean;
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
			const dayIncs = incidentsByMonitorDay.get(key) ?? [];
			let color: string;
			if (avg === undefined) {
				color = '#d4d4d8';
			} else if (dayIncs.some((inc) => inc.severity === 'critical')) {
				color = '#f87171';
			} else if (dayIncs.length > 0) {
				color = '#fbbf24';
			} else if (avg < 0.95) {
				color = '#f87171';
			} else if (avg < 0.99) {
				color = '#fbbf24';
			} else {
				color = '#4ade80';
			}
			const safeKey = escHtml(key);
			const safeTip = escHtml(day + ': ' + tip);
			bars += `<span class="bar" data-age="${i}" data-key="${safeKey}" data-tip="${safeTip}" aria-label="${safeTip}" style="background:${color}"></span>`;
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

	function statusDot(status: string | null): string {
		const s = status ?? 'unknown';
		const c = s === 'up' ? '#22c55e' : s === 'degraded' ? '#f59e0b' : s === 'down' ? '#ef4444' : '#a1a1aa';
		const pulse = s === 'down' ? ' class="dot-pulse"' : '';
		return `<span${pulse} style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${c};flex-shrink:0;margin-top:4px"></span>`;
	}

	function statusLabel(status: string | null): string {
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
		const sA = statusOrder[a.status ?? ''] ?? 3;
		const sB = statusOrder[b.status ?? ''] ?? 3;
		if (sA !== sB) return sA - sB;
		return a.name.localeCompare(b.name);
	});

	const monitorsHtml = sortedMonitors.map((m, i) => {
		const pts = latencyByMonitor.get(m.id) ?? [];
		const inc = activeByMonitor.get(m.id);
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
					${statusDot(m.status)}
					<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
						<span class="monitor-name">${escHtml(m.name)}</span>
						${typeBadge(m.type)}
						${visibilityBadge(m.visibility)}
						${sslBadge(m.ssl_not_after, m.ssl_issuer)}
					</div>
				</div>
				<div style="display:flex;align-items:center;gap:14px">
					${statusLabel(m.status)}
					<span class="meta-text">checked ${timeAgo(m.last_check_at)}</span>
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

	const activeIncidentsHtml = activeIncidents.length > 0 ? `
	<section class="section">
		<h2 class="section-title">Active Incidents</h2>
		${activeIncidents.map((inc) => {
			const monName = monitors.find((m) => m.id === inc.monitor_id)?.name ?? inc.monitor_id;
			const isWarn = inc.severity === 'warning';
			return `<div style="background:${isWarn ? '#fffbeb' : '#fef2f2'};border:1px solid ${isWarn ? '#fde68a' : '#fecaca'};border-radius:8px;padding:14px 16px;margin-bottom:8px">
				<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
					<span style="font-size:14px;font-weight:600">${isWarn ? '🟡' : '🔴'} ${escHtml(monName)} — ${escHtml(inc.severity)}</span>
					<span class="meta-text">started ${timeAgo(inc.started_at)}</span>
				</div>
				${inc.reason ? `<div class="incident-reason">${escHtml(inc.reason)}</div>` : ''}
			</div>`;
		}).join('\n')}
	</section>` : '';


	function progressBar(label: string, value: string, limit: string, pct: number): string {
		const fill = Math.min(pct, 100);
		const color = pct > 80 ? '#ef4444' : pct > 50 ? '#f59e0b' : '#4ade80';
		return `<div class="usage-card">
			<div class="usage-label">${label}</div>
			<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
				<span style="font-weight:600">${value}</span>
				<span class="meta-text">/ ${limit}</span>
			</div>
			<div style="height:5px;background:#f4f4f5;border-radius:3px;overflow:hidden">
				<div style="height:100%;width:${fill.toFixed(1)}%;background:${color};border-radius:3px"></div>
			</div>
		</div>`;
	}

	function infoCard(label: string, value: string, valueColor: string, sub?: string): string {
		return `<div class="usage-card">
			<div class="usage-label">${label}</div>
			<div style="font-size:20px;font-weight:700;color:${valueColor};line-height:1.2">${value}</div>
			${sub ? `<div style="font-size:12px;color:#a1a1aa;margin-top:3px">${sub}</div>` : ''}
		</div>`;
	}

	const usageHtml = d1Usage ? (() => {
		const { d1, d1Percent, workers, plan } = d1Usage;
		const p = plan ?? { label: 'Free', rowsRead: 5_000_000, rowsWritten: 100_000, storageBytes: 5_000_000_000 };
		const workersReqPct = workers ? (workers.requests / workersFreeLimit.requestsPerDay) * 100 : 0;
		const d1ReadLimit = p.rowsRead >= 1_000_000_000 ? `${(p.rowsRead / 1_000_000_000).toFixed(0)}B` : `${(p.rowsRead / 1_000_000).toFixed(0)}M`;
		const d1WriteLimit = p.rowsWritten >= 1_000_000 ? `${(p.rowsWritten / 1_000_000).toFixed(0)}M` : `${(p.rowsWritten / 1_000).toFixed(0)}K`;
		return `
	<section class="section">
		<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
			<h2 class="section-title" style="margin:0">Infrastructure Usage</h2>
			<span class="meta-text">resets in ${usageResetsIn(nowMs)}</span>
		</div>
		<div class="usage-sublabel">D1 Database · ${p.label} · ${d1ReadLimit} reads / ${d1WriteLimit} writes / ${formatBytes(p.storageBytes)} / day</div>
		<div class="usage-grid">
			${progressBar('Rows Read', formatNumber(d1.rowsRead), `${d1ReadLimit} / day`, d1Percent.rowsRead)}
			${progressBar('Rows Written', formatNumber(d1.rowsWritten), `${d1WriteLimit} / day`, d1Percent.rowsWritten)}
			${progressBar('Storage', formatBytes(d1.databaseSizeBytes), formatBytes(p.storageBytes), d1Percent.storage)}
		</div>
		<div class="usage-sublabel" style="margin-top:16px">Workers · ${p.label} · 100K requests / day</div>
		<div class="usage-grid">
			${workers
				? progressBar('Requests', formatNumber(workers.requests), '100K / day', workersReqPct)
				: infoCard('Requests', '—', '#a1a1aa', 'no API data')}
			${infoCard('Errors', workers ? String(workers.errors) : '—', workers && workers.errors > 0 ? '#dc2626' : '#16a34a', workers ? (workers.errors > 0 ? 'today' : 'clean') : '')}
			${infoCard('Subrequests', workers ? formatNumber(workers.subrequests) : '—', '#18181b', workers ? 'fetch calls today' : '')}
			${infoCard('Queue', 'heartbeatflare-notifications', '#18181b', '1M ops / month free')}
			${infoCard('Cron', '* * * * *', '#18181b', '~1,440 calls / day')}
		</div>
	</section>`;
	})() : '';

	const nowDisplay = new Date(nowMs).toUTCString().replace(' GMT', ' UTC');

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HeartbeatFlare Status</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fafafa;color:#18181b;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.container{max-width:780px;margin:0 auto;padding:0 20px}
header{background:${bannerBg};border-bottom:1px solid ${bannerBorder};padding:28px 0 24px;margin-bottom:32px}
.header-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.logo{font-size:17px;font-weight:700;color:#18181b;display:flex;align-items:center;gap:7px}
.overall-badge{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;color:${bannerColor}}
.overall-dot{width:11px;height:11px;border-radius:50%;background:${bannerColor};flex-shrink:0}
.meta-text{font-size:12px;color:#a1a1aa}
.section{margin-bottom:28px}
.section-title{font-size:11px;font-weight:700;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:10px}
.monitor-row{background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:16px 18px;margin-bottom:8px}
.monitor-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:11px;gap:12px}
.monitor-name{font-size:15px;font-weight:600}
.incident-inline{font-size:12px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 10px;margin-bottom:10px}
.incident-reason{font-size:12px;color:#71717a;margin-top:5px;font-family:"SF Mono",ui-monospace,monospace;word-break:break-all}
.bars-row{display:flex;gap:2px;margin-bottom:3px;overflow:hidden}
.bar{flex:1;min-width:4px;max-width:20px;height:26px;border-radius:2px;cursor:default;transition:opacity .12s}
.bar:hover{opacity:.7}
#bar-tt{position:fixed;z-index:100;pointer-events:none;background:#18181b;color:#f4f4f5;border-radius:8px;padding:10px 14px;font-size:12px;max-width:280px;box-shadow:0 4px 16px rgba(0,0,0,.35);line-height:1.5;white-space:normal}
#bar-tt .tt-row+.tt-row{border-top:1px solid #3f3f46;margin-top:6px;padding-top:6px}
#bar-tt .tt-sev{font-size:10px;font-weight:700;text-transform:uppercase;padding:1px 5px;border-radius:3px;margin-right:4px}
#bar-tt .tt-sev.crit{background:#991b1b;color:#fee2e2}
#bar-tt .tt-sev.warn{background:#78350f;color:#fef9c3}
.bars-labels{display:flex;justify-content:space-between;font-size:11px;color:#a1a1aa;margin-bottom:6px}
.range-picker{display:flex;gap:3px}
.range-btn{font-size:11px;font-weight:600;padding:3px 9px;border-radius:5px;border:1px solid #e4e4e7;background:#fff;color:#71717a;cursor:pointer;transition:all .12s;line-height:1.6}
.range-btn:hover{border-color:#a1a1aa;color:#18181b}
.range-btn.active{background:#18181b;color:#fff;border-color:#18181b}
.range-btn:disabled{opacity:.4;cursor:not-allowed}
.stats-row{display:flex;align-items:center;gap:14px;font-size:12px;color:#71717a;flex-wrap:wrap}
.stats-row b{color:#18181b;font-weight:600}
.sparkline-wrap{display:flex;align-items:center}
.usage-sublabel{font-size:11px;color:#a1a1aa;margin-bottom:8px}
.usage-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
.usage-card{background:#fff;border:1px solid #e4e4e7;border-radius:8px;padding:14px 16px}
.usage-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#a1a1aa;margin-bottom:8px}
footer{border-top:1px solid #e4e4e7;padding:20px 0;margin-top:8px}
.footer-inner{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.dot-pulse{animation:pulse 2s ease-in-out infinite}
.events{display:flex;flex-direction:column}
.event{display:grid;grid-template-columns:128px 1fr;gap:20px;padding:18px 0}
.event+.event{border-top:1px solid #f4f4f5}
.event-date{padding-top:2px}
.event-date .date{font-size:15px;font-weight:700;color:#18181b}
.event-date .relative{display:inline-block;margin-top:6px;font-size:11px;color:#71717a;background:#f4f4f5;border-radius:5px;padding:2px 7px}
.event-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.event-title .name{font-size:16px;font-weight:600;color:#18181b}
.event-card{background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:16px 18px 0}
.update{position:relative;display:grid;grid-template-columns:18px 1fr;gap:11px;padding-bottom:22px}
.update:not(:last-child)::before{content:"";position:absolute;left:5px;top:15px;bottom:-2px;width:1px;background:#d4d4d8}
.update .marker{width:10px;height:10px;margin-top:5px;border-radius:2px;background:#a1a1aa;flex-shrink:0}
.update-title{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.update-title .label{font-size:14px;font-weight:700}
.update-title .time{font-size:12px;color:#a1a1aa;font-family:"SF Mono",ui-monospace,monospace}
.update-body{margin-top:5px;font-size:13px;color:#52525b;font-family:"SF Mono",ui-monospace,monospace;line-height:1.55;word-break:break-word}
.update.resolved .marker{background:#22c55e}
.update.resolved::before{background:#86efac}
.update.resolved .label{color:#15803d}
.update.down .marker{background:#ef4444}
.update.down .label{color:#b91c1c}
.update.degraded .marker{background:#f59e0b}
.update.degraded .label{color:#b45309}
@media(max-width:640px){.event{grid-template-columns:1fr;gap:10px}.event-date .relative{margin-top:0;margin-left:8px}}
</style>
</head>
<body>
<header>
<div class="container">
<div class="header-inner">
<div class="logo">💓 HeartbeatFlare</div>
<div class="overall-badge"><span class="overall-dot"></span>${overallText}</div>
<span class="meta-text">Updated ${nowDisplay}</span>
${session
	? `<div style="display:flex;align-items:center;gap:10px"><span class="meta-text" title="${escHtml(session.email)}">${escHtml(session.name)}</span><a href="/auth/logout" style="font-size:12px;font-weight:600;padding:5px 12px;border-radius:5px;border:1px solid #e4e4e7;background:#fff;color:#18181b;text-decoration:none">Sign out</a></div>`
	: `<a href="/auth/login" style="font-size:12px;font-weight:600;padding:5px 12px;border-radius:5px;border:1px solid #18181b;background:#18181b;color:#fff;text-decoration:none">Sign in</a>`}
</div>
</div>
</header>
<main class="container">
${activeIncidentsHtml}
<section class="section">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
<div class="range-picker">
<button class="range-btn tab-btn active" data-tab="monitors">Monitors (${monitors.length})</button>
<button class="range-btn tab-btn" data-tab="history">History</button>
</div>
<div class="range-picker" id="range-picker">
<button class="range-btn" data-days="7">7d</button>
<button class="range-btn" data-days="30">30d</button>
<button class="range-btn active" data-days="90">90d</button>
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
<span class="meta-text">heartbeatflare.modem-ltd.workers.dev</span>
<span class="meta-text">Powered by <a href="https://workers.cloudflare.com" target="_blank" rel="noopener" style="color:#71717a;text-decoration:underline">Cloudflare Workers</a></span>
</div>
</div>
</footer>
<div id="bar-tt" hidden></div>
<script>
(function(){
  var INC=${incMapJson};
  var picker=document.getElementById('range-picker');
  var tabMonitors=document.getElementById('tab-monitors');
  var tabHistory=document.getElementById('tab-history');
  var histList=document.getElementById('history-list');
  var histPager=document.getElementById('history-pagination');
  var histPage=1,histPages=1,histLoaded=false;

  function setRange(d){
    picker.querySelectorAll('.range-btn').forEach(function(b){b.classList.toggle('active',+b.dataset.days===d);});
    document.querySelectorAll('.bar').forEach(function(b){b.style.display=+b.dataset.age<d?'':'none';});
    document.querySelectorAll('.bars-range-label').forEach(function(el){el.textContent=d+' days ago';});
  }
  picker.querySelectorAll('.range-btn').forEach(function(btn){
    btn.addEventListener('click',function(){setRange(+btn.dataset.days);});
  });

  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function fmtDur(s,e){if(!e)return'ongoing';var m=Math.floor((new Date(e)-new Date(s))/60000);if(m<60)return m+'m';var h=Math.floor(m/60);if(h<24)return h+'h '+(m%60)+'m';return Math.floor(h/24)+'d '+(h%24)+'h';}
  function fmtDay(s){return new Date(s).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});}
  function fmtTime(s){var d=new Date(s);return d.toLocaleDateString('en-US',{month:'long',day:'numeric',timeZone:'UTC'})+' at '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true,timeZone:'UTC'});}
  function relAgo(s){var m=Math.floor((Date.now()-new Date(s).getTime())/60000);if(m<1)return'just now';if(m<60)return m+'m ago';var h=Math.floor(m/60);if(h<24)return h+'h ago';var d=Math.floor(h/24);if(d<30)return d+'d ago';var mo=Math.floor(d/30);if(mo<12)return mo+' month'+(mo>1?'s':'')+' ago';var y=Math.floor(d/365);return y+' year'+(y>1?'s':'')+' ago';}
  function renderUpdate(cls,label,time,body){return '<div class="update '+cls+'"><div class="marker"></div><div><div class="update-title"><span class="label">'+label+'</span><span class="time">'+time+'</span></div>'+(body?'<div class="update-body">'+body+'</div>':'')+'</div></div>';}

  function renderRows(rows){
    if(!rows.length)return'<div class="meta-text" style="padding:24px 0;text-align:center">No incidents recorded.</div>';
    var h='<div class="events">';
    rows.forEach(function(inc){
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
        '<aside class="event-date"><div class="date">'+fmtDay(inc.started_at)+'</div><div class="relative">'+relAgo(inc.started_at)+'</div></aside>'+
        '<div class="event-content"><div class="event-title"><span class="name">'+esc(inc.monitor_name||inc.monitor_id)+'</span>'+badge+'</div>'+
        '<div class="event-card">'+ups+'</div></div>'+
      '</article>';
    });
    return h+'</div>';
  }

  function renderPager(){
    if(histPages<=1){histPager.innerHTML='';return;}
    histPager.innerHTML=
      '<button class="range-btn" id="hist-prev"'+(histPage<=1?' disabled':'')+'>&#8592; Prev</button>'+
      '<span class="meta-text">Page '+histPage+' of '+histPages+'</span>'+
      '<button class="range-btn" id="hist-next"'+(histPage>=histPages?' disabled':'')+'>Next &#8594;</button>';
    var p=document.getElementById('hist-prev'),n=document.getElementById('hist-next');
    if(p)p.addEventListener('click',function(){if(histPage>1)loadHistory(histPage-1);});
    if(n)n.addEventListener('click',function(){if(histPage<histPages)loadHistory(histPage+1);});
  }

  function loadHistory(page){
    histList.innerHTML='<div class="meta-text" style="padding:24px 0;text-align:center">Loading…</div>';
    histPager.innerHTML='';
    fetch('/api/history?page='+page)
      .then(function(r){return r.json();})
      .then(function(data){histPage=data.page;histPages=data.pages;histLoaded=true;histList.innerHTML=renderRows(data.incidents);renderPager();})
      .catch(function(){histList.innerHTML='<div class="meta-text" style="padding:24px 0;text-align:center">Failed to load.</div>';});
  }

  document.querySelectorAll('.tab-btn').forEach(function(btn){
    btn.addEventListener('click',function(){
      var isHist=btn.dataset.tab==='history';
      document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.toggle('active',b===btn);});
      tabMonitors.hidden=isHist;
      tabHistory.hidden=!isHist;
      picker.style.display=isHist?'none':'';
      if(isHist&&!histLoaded)loadHistory(1);
    });
  });

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
          html+='<div class="tt-row">'+icon+' '+fmtDur(inc.started_at,inc.resolved_at)+(inc.reason?' — '+esc(inc.reason):'')+
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
