import { connect } from 'cloudflare:sockets';

type MonitorDbRow = {
	id: string;
	name: string;
	type: string;
	mode: string;
	visibility: string;
	scrape_url: string | null;
	interval_seconds: number;
	enabled: number;
	created_at: string;
	updated_at: string;
	status: string | null;
	last_check_at: string | null;
	last_success_at: string | null;
	consecutive_failures: number | null;
	consecutive_successes: number | null;
	active_incident_id: string | null;
};

type AlertRuleDbRow = {
	id: string;
	monitor_id: string;
	condition: string;
	threshold: number;
	severity: string;
	failure_count: number;
	recovery_count: number;
	cooldown_seconds: number;
	enabled: number;
};

type MonitorRow = {
	id: string;
	name: string;
	type: 'http' | 'tcp' | 'dns' | 'heartbeat';
	scrape_url: string | null;
	interval_seconds: number;
	ssl_check: number;
	current_status: string | null;
	last_check_at: string | null;
	consecutive_failures: number;
	consecutive_successes: number;
	active_incident_id: string | null;
};

type ProbeResult = {
	status: 'up' | 'down';
	latency_ms: number;
	tcp_connect_ms?: number;
	ssl_error?: boolean;
	error?: string;
};

type NotificationMessage = {
	incidentId: string;
	monitorId: string;
	monitorName: string;
	eventType: 'down' | 'recovered';
	count: number;
	error?: string;
};

type NotificationChannelDbRow = {
	id: string;
	name: string;
	type: string;
	configuration: string;
};

type UptimeDayRow = { monitor_id: string; day: string; avg_up: number };
type LatencyRow = { monitor_id: string; latency_ms: number };
type IncidentRow = {
	id: string;
	monitor_id: string;
	severity: string;
	started_at: string;
	resolved_at: string | null;
	reason: string | null;
	monitor_name?: string;
};

type RuntimeEnv = Env & {
	CLOUDFLARE_ACCOUNT_ID?: string;
	D1_DATABASE_ID?: string;
	CLOUDFLARE_GRAPHQL_API_TOKEN?: string;
};

type D1Usage = {
	readQueries: number;
	writeQueries: number;
	rowsRead: number;
	rowsWritten: number;
	databaseSizeBytes: number;
};

type D1UsagePercent = {
	rowsRead: number;
	rowsWritten: number;
	storage: number;
};

type WorkersUsage = {
	requests: number;
	errors: number;
	subrequests: number;
};

type UsageSnapshot = {
	d1: D1Usage;
	d1Percent: D1UsagePercent;
	workers: WorkersUsage | null;
	fetchedAt: string | null;
};

type UsageGraphQLResponse = {
	data?: {
		viewer?: {
			accounts?: Array<{
				d1AnalyticsAdaptiveGroups?: Array<{
					sum?: Partial<Omit<D1Usage, 'databaseSizeBytes'> & { queryBatchResponseBytes: number }>;
				}>;
				d1StorageAdaptiveGroups?: Array<{
					max?: Partial<Pick<D1Usage, 'databaseSizeBytes'>>;
				}>;
				workersInvocationsAdaptive?: Array<{
					sum?: Partial<WorkersUsage>;
				}>;
			}>;
		};
	};
	errors?: unknown[];
};

const freePlanLimits = {
	rowsRead: 5_000_000,
	rowsWritten: 100_000,
	storageBytes: 5_000_000_000,
};

const workersFreeLimit = {
	requestsPerDay: 100_000,
};

const fallbackUsage: D1Usage = {
	readQueries: 59,
	writeQueries: 81,
	rowsRead: 317,
	rowsWritten: 257,
	databaseSizeBytes: 159744,
};

let cachedUsage: UsageSnapshot = {
	d1: fallbackUsage,
	d1Percent: calculateUsagePercent(fallbackUsage),
	workers: null,
	fetchedAt: null,
};

let cachedUsageUntil = 0;

function calculateUsagePercent(usage: D1Usage): D1UsagePercent {
	return {
		rowsRead: Number(((usage.rowsRead / freePlanLimits.rowsRead) * 100).toFixed(5)),
		rowsWritten: Number(((usage.rowsWritten / freePlanLimits.rowsWritten) * 100).toFixed(5)),
		storage: Number(((usage.databaseSizeBytes / freePlanLimits.storageBytes) * 100).toFixed(5)),
	};
}

function utcDateString(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function usageResetsIn(nowMs: number): string {
	const now = new Date(nowMs);
	const resetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
	const diffMs = resetAt - nowMs;
	const hours = Math.floor(diffMs / 3_600_000);
	const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
	return `${hours}h ${minutes}m`;
}

async function fetchUsage(env: RuntimeEnv): Promise<UsageSnapshot> {
	const nowMs = Date.now();
	if (nowMs < cachedUsageUntil) return cachedUsage;

	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	const databaseId = env.D1_DATABASE_ID;
	const apiToken = env.CLOUDFLARE_GRAPHQL_API_TOKEN;
	if (!accountId || !databaseId || !apiToken) {
		return cachedUsage;
	}

	const today = utcDateString(new Date(nowMs));
	const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			query:
				'query Usage($accountTag: string!, $date: Date, $databaseId: string, $scriptName: string) { viewer { accounts(filter: { accountTag: $accountTag }) { d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date, databaseId: $databaseId }) { sum { readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes } } d1StorageAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date, databaseId: $databaseId }) { max { databaseSizeBytes } } workersInvocationsAdaptive(limit: 10000, filter: { date_geq: $date, date_leq: $date, scriptName: $scriptName }) { sum { requests errors subrequests } } } } }',
			variables: {
				accountTag: accountId,
				date: today,
				databaseId,
				scriptName: 'heartbeatflare',
			},
		}),
	});

	if (!response.ok) {
		cachedUsageUntil = nowMs + 30_000;
		return cachedUsage;
	}

	const body = (await response.json()) as UsageGraphQLResponse;
	if (body.errors?.length) {
		cachedUsageUntil = nowMs + 30_000;
		return cachedUsage;
	}

	const account = body.data?.viewer?.accounts?.[0];
	const analytics = account?.d1AnalyticsAdaptiveGroups?.[0]?.sum ?? {};
	const storage = account?.d1StorageAdaptiveGroups?.[0]?.max ?? {};
	const workersSum = account?.workersInvocationsAdaptive?.[0]?.sum;

	const d1: D1Usage = {
		readQueries: analytics.readQueries ?? 0,
		writeQueries: analytics.writeQueries ?? 0,
		rowsRead: analytics.rowsRead ?? 0,
		rowsWritten: analytics.rowsWritten ?? 0,
		databaseSizeBytes: storage.databaseSizeBytes ?? cachedUsage.d1.databaseSizeBytes,
	};

	cachedUsage = {
		d1,
		d1Percent: calculateUsagePercent(d1),
		workers: workersSum ? { requests: workersSum.requests ?? 0, errors: workersSum.errors ?? 0, subrequests: workersSum.subrequests ?? 0 } : null,
		fetchedAt: new Date(nowMs).toISOString(),
	};
	cachedUsageUntil = nowMs + 60_000;
	return cachedUsage;
}

async function httpCheck(url: string, sslCheck: boolean): Promise<ProbeResult> {
	const start = Date.now();
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
		const latency_ms = Date.now() - start;
		if (res.ok) return { status: 'up', latency_ms };
		return { status: 'down', latency_ms, error: `HTTP ${res.status}` };
	} catch (err) {
		const latency_ms = Date.now() - start;
		const msg = err instanceof Error ? err.message : String(err);
		const isSsl = sslCheck && /ssl|certificate|tls/i.test(msg);
		return { status: 'down', latency_ms, ssl_error: isSsl || undefined, error: msg };
	}
}

function parseTcpTarget(target: string): { hostname: string; port: number } {
	const normalized = target.startsWith('tcp://') ? target : `tcp://${target}`;
	const url = new URL(normalized);
	const port = Number(url.port);
	if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid TCP target: ${target}`);
	}
	return { hostname: url.hostname, port };
}

function parseDnsTarget(target: string): { hostname: string; recordType: string } {
	const [hostname, recordType = 'A'] = target.split('/');
	if (!hostname) throw new Error(`Invalid DNS target: ${target}`);
	return { hostname, recordType: recordType.toUpperCase() };
}

async function dnsCheck(target: string): Promise<ProbeResult> {
	const start = Date.now();
	try {
		const { hostname, recordType } = parseDnsTarget(target);
		const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${recordType}`;
		const res = await fetch(url, {
			headers: { Accept: 'application/dns-json' },
			signal: AbortSignal.timeout(10_000),
		});
		const latency_ms = Date.now() - start;
		if (!res.ok) return { status: 'down', latency_ms, error: `DoH HTTP ${res.status}` };
		const body = (await res.json()) as { Status: number; Answer?: unknown[] };
		if (body.Status === 0 && body.Answer?.length) return { status: 'up', latency_ms };
		return { status: 'down', latency_ms, error: `DNS status ${body.Status}` };
	} catch (err) {
		return { status: 'down', latency_ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
	}
}

async function tcpCheck(target: string): Promise<ProbeResult> {
	const start = Date.now();
	let socket: Socket | undefined;
	try {
		const { hostname, port } = parseTcpTarget(target);
		socket = connect({ hostname, port });
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			socket.opened,
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error('TCP connect timeout')), 10_000);
			}),
		]).finally(() => clearTimeout(timeoutId ?? null));
		const latency_ms = Date.now() - start;
		return { status: 'up', latency_ms, tcp_connect_ms: latency_ms };
	} catch (err) {
		const latency_ms = Date.now() - start;
		return {
			status: 'down',
			latency_ms,
			tcp_connect_ms: latency_ms,
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		socket?.close();
	}
}

async function storeResult(env: Env, monitor: MonitorRow, result: ProbeResult, executionId: string, now: string): Promise<{ newFailures: number; newSuccesses: number }> {
	const prevStatus = monitor.current_status ?? 'unknown';
	const failures = result.status === 'down' ? monitor.consecutive_failures + 1 : 0;
	const successes = result.status === 'up' ? monitor.consecutive_successes + 1 : 0;

	await env.DB.prepare(
		`INSERT INTO monitor_state (monitor_id, status, last_check_at, last_success_at, consecutive_failures, consecutive_successes)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(monitor_id) DO UPDATE SET
		   status = excluded.status,
		   last_check_at = excluded.last_check_at,
		   last_success_at = CASE WHEN excluded.status = 'up' THEN excluded.last_check_at ELSE last_success_at END,
		   consecutive_failures = excluded.consecutive_failures,
		   consecutive_successes = excluded.consecutive_successes`,
	)
		.bind(monitor.id, result.status, now, result.status === 'up' ? now : null, failures, successes)
		.run();

	await env.DB.prepare(
		`INSERT INTO metric_series (id, monitor_id, recorded_at, availability, latency_ms, tcp_connect_ms)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(executionId, monitor.id, now, result.status === 'up' ? 1 : 0, result.latency_ms, result.tcp_connect_ms ?? null)
		.run();

	if (result.status !== prevStatus || result.status === 'down') {
		await env.DB.prepare(
			`INSERT INTO monitor_executions (id, monitor_id, started_at, completed_at, status, latency_ms, error)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(executionId, monitor.id, now, now, result.status, result.latency_ms, result.error ?? null)
			.run();
	}

	return { newFailures: failures, newSuccesses: successes };
}

async function fetchNotificationChannels(env: Env, monitorId: string): Promise<NotificationChannelDbRow[]> {
	const { results: perMonitor } = await env.DB.prepare(
		`SELECT nc.id, nc.name, nc.type, nc.configuration
		 FROM notification_channels nc
		 JOIN monitor_notification_channels mnc ON mnc.channel_id = nc.id
		 WHERE mnc.monitor_id = ? AND mnc.enabled = 1 AND nc.enabled = 1`,
	).bind(monitorId).all<NotificationChannelDbRow>();
	if (perMonitor.length > 0) return perMonitor;
	const { results: defaults } = await env.DB.prepare(
		`SELECT id, name, type, configuration FROM notification_channels WHERE is_default = 1 AND enabled = 1`,
	).all<NotificationChannelDbRow>();
	return defaults;
}

function resolveVars(env: Env, value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (_, key) => (env as unknown as Record<string, string | undefined>)[key] ?? '');
}

async function sendToChannel(env: Env, channel: NotificationChannelDbRow, incidentId: string, text: string, now: string): Promise<void> {
	const cfg = JSON.parse(channel.configuration) as Record<string, unknown>;
	const resolve = (v: unknown): string => (typeof v === 'string' ? resolveVars(env, v) : String(v ?? ''));

	let error: string | null = null;
	try {
		if (channel.type === 'slack' || channel.type === 'webhook') {
			const url = resolve(cfg.url);
			if (!url) throw new Error('missing url in channel configuration');
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (cfg.headers && typeof cfg.headers === 'object') {
				for (const [k, v] of Object.entries(cfg.headers as Record<string, string>)) headers[k] = resolve(v);
			}
			const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ text }) });
			if (!res.ok) error = `HTTP ${res.status}`;
		} else {
			error = `${channel.type} notifications not yet implemented`;
		}
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
	await env.DB.prepare(
		`INSERT INTO notification_deliveries (id, incident_id, channel_id, status, attempt_count, last_attempt_at, error)
		 VALUES (?, ?, ?, ?, 1, ?, ?)`,
	).bind(crypto.randomUUID(), incidentId, channel.id, error ? 'failed' : 'sent', now, error).run();
}

async function evaluateAlerts(env: Env, monitor: MonitorRow, result: ProbeResult, newFailures: number, newSuccesses: number, now: string): Promise<void> {
	const { results: rules } = await env.DB.prepare(
		`SELECT id, monitor_id, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled
		 FROM alert_rules
		 WHERE monitor_id = ? AND enabled = 1
		 ORDER BY failure_count ASC`,
	).bind(monitor.id).all<AlertRuleDbRow>();

	for (const rule of rules) {
		if (result.status === 'down' && newFailures >= rule.failure_count && !monitor.active_incident_id) {
			if (rule.cooldown_seconds > 0) {
				const last = await env.DB.prepare(
					`SELECT resolved_at FROM incidents WHERE monitor_id = ? AND status = 'resolved' ORDER BY resolved_at DESC LIMIT 1`,
				).bind(monitor.id).first<{ resolved_at: string }>();
				if (last?.resolved_at) {
					const elapsed = (new Date(now).getTime() - new Date(last.resolved_at).getTime()) / 1000;
					if (elapsed < rule.cooldown_seconds) break;
				}
			}
			const incidentId = crypto.randomUUID();
			await env.DB.prepare(
				`INSERT INTO incidents (id, monitor_id, alert_rule_id, status, severity, started_at, reason)
				 VALUES (?, ?, ?, 'open', ?, ?, ?)`,
			).bind(incidentId, monitor.id, rule.id, rule.severity, now, result.error ?? null).run();
			await env.DB.prepare(
				`UPDATE monitor_state SET active_incident_id = ? WHERE monitor_id = ?`,
			).bind(incidentId, monitor.id).run();
			await (env.NOTIFICATION_QUEUE as Queue<NotificationMessage>).send({
				incidentId,
				monitorId: monitor.id,
				monitorName: monitor.name,
				eventType: 'down',
				count: newFailures,
				error: result.error,
			});
			break;
		}

		if (result.status === 'up' && newSuccesses >= rule.recovery_count && monitor.active_incident_id) {
			const incidentId = monitor.active_incident_id;
			await env.DB.prepare(
				`UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?`,
			).bind(now, incidentId).run();
			await env.DB.prepare(
				`UPDATE monitor_state SET active_incident_id = NULL WHERE monitor_id = ?`,
			).bind(monitor.id).run();
			await (env.NOTIFICATION_QUEUE as Queue<NotificationMessage>).send({
				incidentId,
				monitorId: monitor.id,
				monitorName: monitor.name,
				eventType: 'recovered',
				count: newSuccesses,
			});
			break;
		}
	}
}

// ─── Status page helpers ──────────────────────────────────────────────────────

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

function buildStatusPage({
	nowMs,
	monitors,
	uptimeDays,
	latencyPoints,
	activeIncidents,
	recentIncidents,
	d1Usage,
}: {
	nowMs: number;
	monitors: MonitorDbRow[];
	uptimeDays: UptimeDayRow[];
	latencyPoints: LatencyRow[];
	activeIncidents: IncidentRow[];
	recentIncidents: IncidentRow[];
	d1Usage: UsageSnapshot;
}): string {
	// Build lookup maps
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

	// Overall status
	const hasDown = monitors.some((m) => m.status === 'down');
	const hasDegraded = monitors.some((m) => m.status === 'degraded');
	const overallText = hasDown ? 'Partial Outage' : hasDegraded ? 'Degraded Performance' : 'All Systems Operational';
	const bannerBg = hasDown ? '#fef2f2' : hasDegraded ? '#fffbeb' : '#f0fdf4';
	const bannerBorder = hasDown ? '#fecaca' : hasDegraded ? '#fde68a' : '#bbf7d0';
	const bannerColor = hasDown ? '#b91c1c' : hasDegraded ? '#b45309' : '#15803d';

	// 90-day uptime bars for a monitor
	const today = new Date(nowMs);
	function renderBars(monitorId: string): string {
		const days = uptimeByMonitor.get(monitorId);
		let bars = '';
		for (let i = 89; i >= 0; i--) {
			const d = new Date(today);
			d.setUTCDate(d.getUTCDate() - i);
			const day = d.toISOString().slice(0, 10);
			const avg = days?.get(day);
			let color: string, tip: string;
			if (avg === undefined) {
				color = '#d4d4d8'; tip = 'No data';
			} else if (avg >= 0.99) {
				color = '#4ade80'; tip = `${(avg * 100).toFixed(1)}% uptime`;
			} else if (avg >= 0.95) {
				color = '#fbbf24'; tip = `${(avg * 100).toFixed(1)}% uptime`;
			} else {
				color = '#f87171'; tip = `${(avg * 100).toFixed(1)}% uptime`;
			}
			bars += `<span class="bar" style="background:${color}" title="${day}: ${tip}"></span>`;
		}
		return bars;
	}

	// Uptime stat for N past days
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

	// Monitor rows
	const monitorsHtml = monitors.map((m) => {
		const pts = latencyByMonitor.get(m.id) ?? [];
		const inc = activeByMonitor.get(m.id);
		const sparkline = pts.length >= 3 ? renderSparkline(pts.slice(-40)) : '';
		return `
		<div class="monitor-row">
			<div class="monitor-header">
				<div style="display:flex;align-items:flex-start;gap:9px">
					${statusDot(m.status)}
					<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
						<span class="monitor-name">${escHtml(m.name)}</span>
						${typeBadge(m.type)}
					</div>
				</div>
				<div style="display:flex;align-items:center;gap:14px">
					${statusLabel(m.status)}
					<span class="meta-text">checked ${timeAgo(m.last_check_at)}</span>
				</div>
			</div>
			${inc ? `<div class="incident-inline">⚠ Incident ongoing · started ${timeAgo(inc.started_at)}${inc.reason ? ` · ${escHtml(inc.reason)}` : ''}</div>` : ''}
			<div class="bars-row">${renderBars(m.id)}</div>
			<div class="stats-row">
				<span>24h <b>${uptimeStat(m.id, 1)}</b></span>
				<span>7d <b>${uptimeStat(m.id, 7)}</b></span>
				<span>30d <b>${uptimeStat(m.id, 30)}</b></span>
				<span>avg latency <b>${avgLatency(m.id)}</b></span>
				${sparkline ? `<span class="sparkline-wrap">${sparkline}</span>` : ''}
			</div>
		</div>`;
	}).join('\n');

	// Active incidents section
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

	// Incident history
	const historyHtml = recentIncidents.length > 0 ? `
	<section class="section">
		<h2 class="section-title">Incident History</h2>
		<div style="background:#fff;border:1px solid #e4e4e7;border-radius:10px;overflow:hidden">
			${recentIncidents.map((inc, i) => {
				const isLast = i === recentIncidents.length - 1;
				const isCrit = inc.severity === 'critical';
				return `<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;${isLast ? '' : 'border-bottom:1px solid #f4f4f5;'}gap:12px;flex-wrap:wrap">
					<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
						<span style="font-size:14px;font-weight:500">${escHtml(inc.monitor_name ?? inc.monitor_id)}</span>
						<span style="font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;text-transform:uppercase;background:${isCrit ? '#fee2e2' : '#fef9c3'};color:${isCrit ? '#b91c1c' : '#92400e'}">${escHtml(inc.severity)}</span>
						${inc.reason ? `<span class="meta-text">· ${escHtml(inc.reason)}</span>` : ''}
					</div>
					<span class="meta-text">${timeAgo(inc.started_at)} · ${formatDuration(inc.started_at, inc.resolved_at)}</span>
				</div>`;
			}).join('\n')}
		</div>
	</section>` : '';

	// Usage block
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

	const { d1, d1Percent, workers } = d1Usage;
	const workersReqPct = workers ? (workers.requests / workersFreeLimit.requestsPerDay) * 100 : 0;

	const usageHtml = `
	<section class="section">
		<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
			<h2 class="section-title" style="margin:0">Infrastructure Usage</h2>
			<span class="meta-text">resets in ${usageResetsIn(nowMs)}</span>
		</div>
		<div class="usage-sublabel">D1 Database · Free Plan · 5M reads / 100K writes / 5 GB / day</div>
		<div class="usage-grid">
			${progressBar('Rows Read', formatNumber(d1.rowsRead), '5M / day', d1Percent.rowsRead)}
			${progressBar('Rows Written', formatNumber(d1.rowsWritten), '100K / day', d1Percent.rowsWritten)}
			${progressBar('Storage', formatBytes(d1.databaseSizeBytes), '5 GB', d1Percent.storage)}
		</div>
		<div class="usage-sublabel" style="margin-top:16px">Workers · Free Plan · 100K requests / day</div>
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
.bars-row{display:flex;gap:2px;margin-bottom:8px;overflow:hidden}
.bar{flex-shrink:0;width:7px;height:26px;border-radius:2px;cursor:default;transition:opacity .12s}
.bar:hover{opacity:.7}
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
</style>
</head>
<body>
<header>
<div class="container">
<div class="header-inner">
<div class="logo">💓 HeartbeatFlare</div>
<div class="overall-badge"><span class="overall-dot"></span>${overallText}</div>
<span class="meta-text">Updated ${nowDisplay}</span>
</div>
</div>
</header>
<main class="container">
${activeIncidentsHtml}
<section class="section">
<h2 class="section-title">Monitors (${monitors.length})</h2>
${monitorsHtml}
</section>
${historyHtml}
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
</body>
</html>`;
}

// ─── Worker ──────��──────────────────────────────��─────────────────────────────

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname } = new URL(request.url);
		const runtimeEnv = env as RuntimeEnv;

		if (request.method === 'POST' && pathname.startsWith('/beat/')) {
			const monitorId = pathname.slice(6);
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

		if (request.method === 'GET' && pathname === '/api/status') {
			const [{ results: monitors }, { results: rules }] = await Promise.all([
				env.DB.prepare(
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
				).all<MonitorDbRow>(),
				env.DB.prepare(
					`SELECT id, monitor_id, condition, threshold, severity,
					        failure_count, recovery_count, cooldown_seconds, enabled
					 FROM alert_rules
					 ORDER BY monitor_id`,
				).all<AlertRuleDbRow>(),
			]);
			const snapshot = await fetchUsage(runtimeEnv);
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

		if (request.method !== 'GET' || pathname !== '/') {
			return new Response(null, { status: 404 });
		}

		const nowMs = Date.now();
		const [
			{ results: monitors },
			{ results: uptimeDays },
			{ results: latencyPoints },
			{ results: activeIncidents },
			{ results: recentIncidents },
			d1Usage,
		] = await Promise.all([
			env.DB.prepare(
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
			).all<MonitorDbRow>(),
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
	},

	async scheduled(event, env, ctx): Promise<void> {
		const now = new Date().toISOString();

		const { results } = await env.DB.prepare(
			`SELECT m.id, m.name, m.type, m.scrape_url, m.interval_seconds, m.ssl_check,
			        ms.status AS current_status, ms.last_check_at,
			        COALESCE(ms.consecutive_failures, 0) AS consecutive_failures,
			        COALESCE(ms.consecutive_successes, 0) AS consecutive_successes,
			        ms.active_incident_id
			 FROM monitors m
			 LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
			 WHERE m.enabled = 1 AND m.type IN ('http', 'tcp', 'dns') AND m.mode = 'external'
			   AND (ms.last_check_at IS NULL
			        OR datetime(ms.last_check_at, '+' || m.interval_seconds || ' seconds') <= datetime('now'))`,
		).all<MonitorRow>();

		await Promise.allSettled(
			results.map(async (monitor) => {
				const executionId = crypto.randomUUID();
				const result =
					monitor.type === 'tcp' ? await tcpCheck(monitor.scrape_url!) :
					monitor.type === 'dns' ? await dnsCheck(monitor.scrape_url!) :
					await httpCheck(monitor.scrape_url!, monitor.ssl_check === 1);
				const { newFailures, newSuccesses } = await storeResult(env, monitor, result, executionId, now);
				await evaluateAlerts(env, monitor, result, newFailures, newSuccesses, now);
			}),
		);

		const { results: staleHeartbeats } = await env.DB.prepare(
			`SELECT m.id, m.name, m.type, m.scrape_url, m.interval_seconds,
			        COALESCE(m.ssl_check, 1) AS ssl_check,
			        ms.status AS current_status, ms.last_check_at,
			        COALESCE(ms.consecutive_failures, 0) AS consecutive_failures,
			        COALESCE(ms.consecutive_successes, 0) AS consecutive_successes,
			        ms.active_incident_id
			 FROM monitors m
			 LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
			 WHERE m.enabled = 1 AND m.type = 'heartbeat'
			   AND (ms.last_success_at IS NULL
			        OR datetime(ms.last_success_at, '+' || m.interval_seconds || ' seconds') <= datetime('now'))`,
		).all<MonitorRow>();

		await Promise.allSettled(
			staleHeartbeats.map(async (monitor) => {
				const result = { status: 'down' as const, latency_ms: 0, error: 'Heartbeat missed' };
				const { newFailures, newSuccesses } = await storeResult(env, monitor, result, crypto.randomUUID(), now);
				await evaluateAlerts(env, monitor, result, newFailures, newSuccesses, now);
			}),
		);
	},
	async queue(batch: MessageBatch<NotificationMessage>, env: Env): Promise<void> {
		const now = new Date().toISOString();
		await Promise.allSettled(
			batch.messages.map(async (msg) => {
				const { incidentId, monitorId, monitorName, eventType, count, error } = msg.body;
				const channels = await fetchNotificationChannels(env, monitorId);
				const text =
					eventType === 'down'
						? `🔴 **${monitorName} is DOWN** — ${count} consecutive failure${count !== 1 ? 's' : ''}${error ? `: ${error}` : ''}`
						: `🟢 **${monitorName} recovered** — back up after ${count} successful check${count !== 1 ? 's' : ''}`;
				await Promise.allSettled(channels.map((ch) => sendToChannel(env, ch, incidentId, text, now)));
				msg.ack();
			}),
		);
	},
} satisfies ExportedHandler<Env>;
