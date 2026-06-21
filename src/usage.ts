// Infrastructure-usage block for the private status page: D1 reads/writes/storage and Worker
// invocations for today, fetched from the Cloudflare GraphQL API and cached 60s per isolate.
// Limits are plan-dependent; plan detection needs Billing:Read on the token and falls back to
// Free Plan limits without it. Errors keep serving the last (or fallback) snapshot.
import type { RuntimeEnv, D1Usage, D1UsagePercent, UsageSnapshot, UsageGraphQLResponse, QueueGraphQLResponse, TrendsGraphQLResponse, HourlyGroup, PlanInfo, QueueUsage, EmailRoutingUsage, VpcItemStatus, UsageTrends } from './types';

export const TREND_HOURS = 24;

// Core usage (D1 + Workers) and the optional datasets (queues) are fetched as separate GraphQL
// requests on purpose: GraphQL collapses the whole document to data:null on any field/permission
// error, so keeping them apart means a problem with an optional dataset can't take down the core.
const CORE_USAGE_QUERY =
	'query Usage($accountTag: string!, $date: Date, $databaseId: string, $scriptName: string) { viewer { accounts(filter: { accountTag: $accountTag }) { d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date, databaseId: $databaseId }) { sum { readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes } } d1StorageAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date, databaseId: $databaseId }) { max { databaseSizeBytes } } workersInvocationsAdaptive(limit: 10000, filter: { date_geq: $date, date_leq: $date, scriptName: $scriptName }) { sum { requests errors subrequests } } } } }';

// Produced/consumed are not sum fields on this dataset (only billableOperations/bytes exist); the
// direction is the actionType dimension, so we group by it and reduce client-side. The dataset only
// filters by queueId (not queueName, which the runtime doesn't have) — this worker uses a single
// notifications queue, so we aggregate by actionType across the account instead.
const QUEUE_USAGE_QUERY =
	'query QueueUsage($accountTag: string!, $date: Date) { viewer { accounts(filter: { accountTag: $accountTag }) { queueMessageOperationsAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date }) { sum { billableOperations } dimensions { actionType } } } } }';

// Hourly buckets for the last TREND_HOURS, for the sparklines. Same Account Analytics:Read scope as
// the core query; fetched separately so a failure here can't take down the core block.
const TREND_QUERY =
	'query Trends($accountTag: string!, $since: Time, $databaseId: string, $scriptName: string) { viewer { accounts(filter: { accountTag: $accountTag }) { d1AnalyticsAdaptiveGroups(limit: 1000, orderBy: [datetimeHour_ASC], filter: { datetime_geq: $since, databaseId: $databaseId }) { sum { rowsRead rowsWritten } dimensions { datetimeHour } } workersInvocationsAdaptive(limit: 1000, orderBy: [datetimeHour_ASC], filter: { datetime_geq: $since, scriptName: $scriptName }) { sum { requests errors } dimensions { datetimeHour } } } } }';

// The ISO top-of-hour keys for the last `hours` buckets, oldest→newest, ending at the current hour.
export function hourKeys(nowMs: number, hours: number): string[] {
	const top = Math.floor(nowMs / 3_600_000) * 3_600_000;
	// top-of-hour ISO has zero minutes/seconds; strip millis to match the API's datetimeHour format.
	return Array.from({ length: hours }, (_, i) => new Date(top - (hours - 1 - i) * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
}

// Maps datetimeHour-grouped rows onto a fixed-length, gap-filled series aligned to `keys`.
export function hourlySeries<S extends Record<string, number | undefined>>(
	groups: Array<HourlyGroup<S>>,
	field: keyof S,
	keys: string[],
): number[] {
	const byHour = new Map<string, number>();
	for (const g of groups) {
		if (g.dimensions?.datetimeHour) byHour.set(g.dimensions.datetimeHour, (g.sum?.[field] as number | undefined) ?? 0);
	}
	return keys.map((k) => byHour.get(k) ?? 0);
}

let cachedTrends: UsageTrends | null = null;
let cachedTrendsUntil = 0;

async function fetchUsageTrends(accountId: string, apiToken: string, databaseId: string, scriptName: string, nowMs: number): Promise<UsageTrends | null> {
	if (nowMs < cachedTrendsUntil) return cachedTrends;

	const keys = hourKeys(nowMs, TREND_HOURS);
	const body = await cfGraphQL<TrendsGraphQLResponse>(apiToken, TREND_QUERY, {
		accountTag: accountId,
		since: keys[0],
		databaseId,
		scriptName,
	});
	const account = body?.data?.viewer?.accounts?.[0];
	if (!body || body.errors?.length || !account) return cachedTrends;

	const d1 = account.d1AnalyticsAdaptiveGroups ?? [];
	const workers = account.workersInvocationsAdaptive ?? [];
	cachedTrends = {
		d1RowsRead: hourlySeries(d1, 'rowsRead', keys),
		d1RowsWritten: hourlySeries(d1, 'rowsWritten', keys),
		workerRequests: hourlySeries(workers, 'requests', keys),
		workerErrors: hourlySeries(workers, 'errors', keys),
	};
	cachedTrendsUntil = nowMs + 60_000;
	return cachedTrends;
}

async function cfGraphQL<T>(apiToken: string, query: string, variables: Record<string, unknown>): Promise<T | null> {
	try {
		const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
			method: 'POST',
			headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query, variables }),
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

export const workersFreeLimit = {
	requestsPerDay: 100_000,
};

const PLAN_LIMITS = {
	free: { label: 'Free',         rowsRead: 5_000_000,      rowsWritten: 100_000,    storageBytes: 5_000_000_000  } satisfies PlanInfo,
	paid: { label: 'Workers Paid', rowsRead: 25_000_000_000, rowsWritten: 50_000_000, storageBytes: 50_000_000_000 } satisfies PlanInfo,
};

let cachedPlan: PlanInfo | null = null;
let cachedPlanUntil = 0;

async function fetchPlanInfo(accountId: string, apiToken: string): Promise<PlanInfo> {
	const nowMs = Date.now();
	if (cachedPlan && nowMs < cachedPlanUntil) return cachedPlan;

	try {
		// Requires Account → Billing → Read permission on the token.
		// Returns 401/403 without it — falls back to Free plan limits, which is correct for most accounts.
		const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/subscriptions`, {
			headers: { Authorization: `Bearer ${apiToken}` },
		});
		if (res.ok) {
			const body = (await res.json()) as { result?: Array<{ id?: string; state?: string }> };
			const isPaid = (body.result ?? []).some(
				(s) => s.state === 'Active' && typeof s.id === 'string' && s.id.startsWith('workers'),
			);
			cachedPlan = isPaid ? PLAN_LIMITS.paid : PLAN_LIMITS.free;
		} else {
			cachedPlan = PLAN_LIMITS.free;
		}
	} catch {
		cachedPlan = PLAN_LIMITS.free;
	}

	cachedPlanUntil = nowMs + 3_600_000; // cache 1 hour
	return cachedPlan;
}

const fallbackUsage: D1Usage = {
	readQueries: 59,
	writeQueries: 81,
	rowsRead: 317,
	rowsWritten: 257,
	databaseSizeBytes: 159744,
};

function calculateUsagePercent(usage: D1Usage, limits: PlanInfo): D1UsagePercent {
	return {
		rowsRead: Number(((usage.rowsRead / limits.rowsRead) * 100).toFixed(5)),
		rowsWritten: Number(((usage.rowsWritten / limits.rowsWritten) * 100).toFixed(5)),
		storage: Number(((usage.databaseSizeBytes / limits.storageBytes) * 100).toFixed(5)),
	};
}

let cachedVpc: VpcItemStatus[] | null = null;
let cachedVpcUntil = 0;

async function fetchVpcStatus(accountId: string, apiToken: string, env: RuntimeEnv): Promise<VpcItemStatus[] | null> {
	const nowMs = Date.now();
	if (cachedVpc && nowMs < cachedVpcUntil) return cachedVpc;

	// Networks only: their backing Cloudflare Tunnel (cfd_tunnel) exposes a health status. VPC
	// services are intentionally excluded — their API returns configuration only, no health field.
	type NetworkEntry = { binding: string; tunnel_id: string };

	let networks: NetworkEntry[] = [];
	try {
		if (env.VPC_NETWORK_IDS) networks = JSON.parse(env.VPC_NETWORK_IDS) as NetworkEntry[];
	} catch {
		return null;
	}
	if (networks.length === 0) return null;

	const results = await Promise.all(
		networks.map(async (n): Promise<VpcItemStatus> => {
			try {
				const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${n.tunnel_id}`, {
					headers: { Authorization: `Bearer ${apiToken}` },
				});
				if (!res.ok) return { binding: n.binding, kind: 'network', id: n.tunnel_id, status: null };
				const data = (await res.json()) as { result?: { status?: string; name?: string } };
				return { binding: n.binding, kind: 'network', id: n.tunnel_id, status: data.result?.status ?? null, name: data.result?.name };
			} catch {
				return { binding: n.binding, kind: 'network', id: n.tunnel_id, status: null };
			}
		}),
	);

	cachedVpc = results;
	cachedVpcUntil = nowMs + 60_000;
	return cachedVpc;
}

// Reduces the actionType-grouped queue operations into produced (writes) vs consumed (reads +
// deletes). billableOperations is operations, used here as a message-count proxy.
export function reduceQueueOperations(
	groups: Array<{ sum?: { billableOperations?: number }; dimensions?: { actionType?: string } }>,
): QueueUsage {
	let messagesProduced = 0;
	let messagesConsumed = 0;
	for (const g of groups) {
		const ops = g.sum?.billableOperations ?? 0;
		const action = g.dimensions?.actionType;
		if (action === 'WriteMessage') messagesProduced += ops;
		else if (action === 'ReadMessage' || action === 'DeleteMessage') messagesConsumed += ops;
	}
	return { messagesProduced, messagesConsumed };
}

async function fetchQueueUsage(accountId: string, apiToken: string, date: string): Promise<QueueUsage | null> {
	const body = await cfGraphQL<QueueGraphQLResponse>(apiToken, QUEUE_USAGE_QUERY, { accountTag: accountId, date });
	const groups = body?.data?.viewer?.accounts?.[0]?.queueMessageOperationsAdaptiveGroups;
	if (!body || body.errors?.length || !groups) return null;
	return reduceQueueOperations(groups);
}

let cachedEmail: EmailRoutingUsage | null = null;
let cachedEmailUntil = 0;

async function fetchEmailRoutingUsage(accountId: string, apiToken: string): Promise<EmailRoutingUsage | null> {
	const nowMs = Date.now();
	// Cache by timestamp (not by truthiness) so an empty result is cached too, not re-fetched every tick.
	if (nowMs < cachedEmailUntil) return cachedEmail;

	const verified: string[] = [];
	const pending: string[] = [];
	try {
		for (let page = 1; page <= 20; page++) {
			const res = await fetch(
				`https://api.cloudflare.com/client/v4/accounts/${accountId}/email/routing/addresses?page=${page}&per_page=50`,
				{ headers: { Authorization: `Bearer ${apiToken}` } },
			);
			if (!res.ok) break;
			const data = (await res.json()) as { success?: boolean; result?: Array<{ email?: string; verified?: string | null; status?: string }> };
			if (!data.success || !Array.isArray(data.result)) break;
			for (const addr of data.result) {
				if (!addr.email) continue;
				if (addr.status === 'verified' && addr.verified) verified.push(addr.email);
				else pending.push(addr.email);
			}
			if (data.result.length < 50) break;
		}
	} catch {
		return cachedEmail;
	}

	cachedEmail = verified.length === 0 && pending.length === 0 ? null : { verified, pending };
	cachedEmailUntil = nowMs + 60_000;
	return cachedEmail;
}

let cachedUsage: UsageSnapshot = {
	d1: fallbackUsage,
	d1Percent: calculateUsagePercent(fallbackUsage, PLAN_LIMITS.free),
	workers: null,
	queues: null,
	email: null,
	vpc: null,
	trends: null,
	fetchedAt: null,
	plan: null,
};

let cachedUsageUntil = 0;

function utcDateString(date: Date): string {
	return date.toISOString().slice(0, 10);
}

export function usageResetsIn(nowMs: number): string {
	const now = new Date(nowMs);
	const resetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
	const diffMs = resetAt - nowMs;
	const hours = Math.floor(diffMs / 3_600_000);
	const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
	return `${hours}h ${minutes}m`;
}

export async function fetchUsage(env: RuntimeEnv): Promise<UsageSnapshot> {
	const nowMs = Date.now();
	if (nowMs < cachedUsageUntil) return cachedUsage;

	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	const databaseId = env.D1_DATABASE_ID;
	const apiToken = env.CLOUDFLARE_RUNTIME_API_TOKEN;
	if (!accountId || !databaseId || !apiToken) {
		return cachedUsage;
	}

	const today = utcDateString(new Date(nowMs));
	// Core query gates the snapshot; the optional ones (queue/email/vpc/trends) degrade to null on their own.
	const [plan, coreBody, queues, emailUsage, vpcStatus, trends] = await Promise.all([
		fetchPlanInfo(accountId, apiToken),
		cfGraphQL<UsageGraphQLResponse>(apiToken, CORE_USAGE_QUERY, {
			accountTag: accountId,
			date: today,
			databaseId,
			scriptName: env.WORKER_NAME ?? '',
		}),
		fetchQueueUsage(accountId, apiToken, today),
		fetchEmailRoutingUsage(accountId, apiToken),
		fetchVpcStatus(accountId, apiToken, env),
		fetchUsageTrends(accountId, apiToken, databaseId, env.WORKER_NAME ?? '', nowMs),
	]);

	const account = coreBody?.data?.viewer?.accounts?.[0];
	if (!coreBody || coreBody.errors?.length || !account) {
		cachedUsageUntil = nowMs + 30_000;
		return cachedUsage;
	}

	const analytics = account.d1AnalyticsAdaptiveGroups?.[0]?.sum ?? {};
	const storage = account.d1StorageAdaptiveGroups?.[0]?.max ?? {};
	const workersSum = account.workersInvocationsAdaptive?.[0]?.sum;

	const d1: D1Usage = {
		readQueries: analytics.readQueries ?? 0,
		writeQueries: analytics.writeQueries ?? 0,
		rowsRead: analytics.rowsRead ?? 0,
		rowsWritten: analytics.rowsWritten ?? 0,
		databaseSizeBytes: storage.databaseSizeBytes ?? cachedUsage.d1.databaseSizeBytes,
	};

	cachedUsage = {
		d1,
		d1Percent: calculateUsagePercent(d1, plan),
		workers: workersSum
			? { requests: workersSum.requests ?? 0, errors: workersSum.errors ?? 0, subrequests: workersSum.subrequests ?? 0 }
			: null,
		queues,
		email: emailUsage,
		vpc: vpcStatus,
		trends,
		fetchedAt: new Date(nowMs).toISOString(),
		plan,
	};
	cachedUsageUntil = nowMs + 60_000;
	return cachedUsage;
}
