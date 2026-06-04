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
	type: 'http' | 'tcp';
	scrape_url: string;
	interval_seconds: number;
	current_status: string | null;
	last_check_at: string | null;
	consecutive_failures: number;
	consecutive_successes: number;
};

type ProbeResult = {
	status: 'up' | 'down';
	latency_ms: number;
	tcp_connect_ms?: number;
	error?: string;
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

type D1UsageSnapshot = {
	usage: D1Usage;
	usagePercent: D1UsagePercent;
	fetchedAt: string | null;
};

type D1GraphQLResponse = {
	data?: {
		viewer?: {
			accounts?: Array<{
				d1AnalyticsAdaptiveGroups?: Array<{
					sum?: Partial<Omit<D1Usage, 'databaseSizeBytes'> & { queryBatchResponseBytes: number }>;
				}>;
				d1StorageAdaptiveGroups?: Array<{
					max?: Partial<Pick<D1Usage, 'databaseSizeBytes'>>;
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

const fallbackUsage: D1Usage = {
	readQueries: 59,
	writeQueries: 81,
	rowsRead: 317,
	rowsWritten: 257,
	databaseSizeBytes: 159744,
};

let cachedUsage: D1UsageSnapshot = {
	usage: fallbackUsage,
	usagePercent: calculateUsagePercent(fallbackUsage),
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

async function fetchD1Usage(env: RuntimeEnv): Promise<D1UsageSnapshot> {
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
				'query D1Usage($accountTag: string!, $date: Date, $databaseId: string) { viewer { accounts(filter: { accountTag: $accountTag }) { d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date, databaseId: $databaseId }) { sum { readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes } } d1StorageAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date, databaseId: $databaseId }) { max { databaseSizeBytes } } } } }',
			variables: {
				accountTag: accountId,
				date: today,
				databaseId,
			},
		}),
	});

	if (!response.ok) {
		cachedUsageUntil = nowMs + 30_000;
		return cachedUsage;
	}

	const body = (await response.json()) as D1GraphQLResponse;
	if (body.errors?.length) {
		cachedUsageUntil = nowMs + 30_000;
		return cachedUsage;
	}

	const account = body.data?.viewer?.accounts?.[0];
	const analytics = account?.d1AnalyticsAdaptiveGroups?.[0]?.sum ?? {};
	const storage = account?.d1StorageAdaptiveGroups?.[0]?.max ?? {};
	const usage: D1Usage = {
		readQueries: analytics.readQueries ?? 0,
		writeQueries: analytics.writeQueries ?? 0,
		rowsRead: analytics.rowsRead ?? 0,
		rowsWritten: analytics.rowsWritten ?? 0,
		databaseSizeBytes: storage.databaseSizeBytes ?? cachedUsage.usage.databaseSizeBytes,
	};

	cachedUsage = {
		usage,
		usagePercent: calculateUsagePercent(usage),
		fetchedAt: new Date(nowMs).toISOString(),
	};
	cachedUsageUntil = nowMs + 60_000;
	return cachedUsage;
}

async function httpCheck(url: string): Promise<ProbeResult> {
	const start = Date.now();
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
		const latency_ms = Date.now() - start;
		if (res.ok) return { status: 'up', latency_ms };
		return { status: 'down', latency_ms, error: `HTTP ${res.status}` };
	} catch (err) {
		return {
			status: 'down',
			latency_ms: Date.now() - start,
			error: err instanceof Error ? err.message : String(err),
		};
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

async function tcpCheck(target: string): Promise<ProbeResult> {
	const start = Date.now();
	let socket: Socket | undefined;
	try {
		const { hostname, port } = parseTcpTarget(target);
		socket = connect({ hostname, port });
		await Promise.race([
			socket.opened,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TCP connect timeout')), 10_000)),
		]);
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

async function storeResult(env: Env, monitor: MonitorRow, result: ProbeResult, executionId: string, now: string): Promise<void> {
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
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname } = new URL(request.url);
		const runtimeEnv = env as RuntimeEnv;

		if (request.method !== 'GET' || pathname !== '/') {
			return new Response(null, { status: 404 });
		}

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
				 ORDER BY m.name`,
			).all<MonitorDbRow>(),
			env.DB.prepare(
				`SELECT id, monitor_id, condition, threshold, severity,
				        failure_count, recovery_count, cooldown_seconds, enabled
				 FROM alert_rules
				 ORDER BY monitor_id`,
			).all<AlertRuleDbRow>(),
		]);
		const d1Usage = await fetchD1Usage(runtimeEnv);

		const rulesByMonitor = new Map<string, AlertRuleDbRow[]>();
		for (const rule of rules) {
			const list = rulesByMonitor.get(rule.monitor_id) ?? [];
			list.push(rule);
			rulesByMonitor.set(rule.monitor_id, list);
		}

		return Response.json({
			usage: d1Usage.usage,
			usagePercent: d1Usage.usagePercent,
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
		});
	},

	async scheduled(event, env, ctx): Promise<void> {
		const now = new Date().toISOString();

		const { results } = await env.DB.prepare(
			`SELECT m.id, m.type, m.scrape_url, m.interval_seconds,
			        ms.status AS current_status, ms.last_check_at,
			        COALESCE(ms.consecutive_failures, 0) AS consecutive_failures,
			        COALESCE(ms.consecutive_successes, 0) AS consecutive_successes
			 FROM monitors m
			 LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
			 WHERE m.enabled = 1 AND m.type IN ('http', 'tcp') AND m.mode = 'external'
			   AND (ms.last_check_at IS NULL
			        OR datetime(ms.last_check_at, '+' || m.interval_seconds || ' seconds') <= datetime('now'))`,
		).all<MonitorRow>();

		await Promise.allSettled(
			results.map(async (monitor) => {
				const executionId = crypto.randomUUID();
				const result = monitor.type === 'tcp' ? await tcpCheck(monitor.scrape_url) : await httpCheck(monitor.scrape_url);
				await storeResult(env, monitor, result, executionId, now);
			}),
		);
	},
} satisfies ExportedHandler<Env>;
