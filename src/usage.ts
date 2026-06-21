// Infrastructure-usage block for the private status page: D1 reads/writes/storage and Worker
// invocations for today, fetched from the Cloudflare GraphQL API and cached 60s per isolate.
// Limits are plan-dependent; plan detection needs Billing:Read on the token and falls back to
// Free Plan limits without it. Errors keep serving the last (or fallback) snapshot.
import type { RuntimeEnv, D1Usage, D1UsagePercent, UsageSnapshot, UsageGraphQLResponse, PlanInfo, QueueUsage, CronUsage, EmailRoutingUsage } from './types';

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

let cachedEmail: EmailRoutingUsage | null = null;
let cachedEmailUntil = 0;

async function fetchEmailRoutingUsage(accountId: string, apiToken: string): Promise<EmailRoutingUsage | null> {
	const nowMs = Date.now();
	if (cachedEmail && nowMs < cachedEmailUntil) return cachedEmail;

	const verified: string[] = [];
	const pending: string[] = [];
	try {
		for (let page = 1; ; page++) {
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

	if (verified.length === 0 && pending.length === 0) return null;
	cachedEmail = { verified, pending };
	cachedEmailUntil = nowMs + 60_000;
	return cachedEmail;
}

let cachedUsage: UsageSnapshot = {
	d1: fallbackUsage,
	d1Percent: calculateUsagePercent(fallbackUsage, PLAN_LIMITS.free),
	workers: null,
	queues: null,
	cron: null,
	email: null,
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
	const [plan, response, emailUsage] = await Promise.all([
		fetchPlanInfo(accountId, apiToken),
		fetch('https://api.cloudflare.com/client/v4/graphql', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			query:
				'query Usage($accountTag: string!, $date: Date, $databaseId: string, $scriptName: string, $queueName: string) { viewer { accounts(filter: { accountTag: $accountTag }) { d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date, databaseId: $databaseId }) { sum { readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes } } d1StorageAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date, databaseId: $databaseId }) { max { databaseSizeBytes } } workersInvocationsAdaptive(limit: 10000, filter: { date_geq: $date, date_leq: $date, scriptName: $scriptName }) { sum { requests errors subrequests } } queueMessageOperationsAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date, queueName: $queueName }) { sum { messagesProduced messagesConsumed } } workersScheduledEventsAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date, scriptName: $scriptName }) { sum { scheduledSuccesses scheduledErrors } } } } }',
			variables: {
				accountTag: accountId,
				date: today,
				databaseId,
				scriptName: env.WORKER_NAME ?? '',
				queueName: `${env.WORKER_NAME ?? ''}-notifications`,
			},
		}),
	}),
		fetchEmailRoutingUsage(accountId, apiToken),
	]);

	if (!response.ok) {
		cachedUsageUntil = nowMs + 30_000;
		return cachedUsage;
	}

	const body = (await response.json()) as UsageGraphQLResponse;
	const account = body.data?.viewer?.accounts?.[0];
	if (!account) {
		cachedUsageUntil = nowMs + 30_000;
		return cachedUsage;
	}

	const analytics = account.d1AnalyticsAdaptiveGroups?.[0]?.sum ?? {};
	const storage = account.d1StorageAdaptiveGroups?.[0]?.max ?? {};
	const workersSum = account.workersInvocationsAdaptive?.[0]?.sum;
	const queueSum = account.queueMessageOperationsAdaptiveGroups?.[0]?.sum;
	const cronSum = account.workersScheduledEventsAdaptiveGroups?.[0]?.sum;

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
		queues: queueSum
			? { messagesProduced: queueSum.messagesProduced ?? 0, messagesConsumed: queueSum.messagesConsumed ?? 0 }
			: null,
		cron: cronSum
			? { scheduledInvocations: cronSum.scheduledSuccesses ?? 0, scheduledErrors: cronSum.scheduledErrors ?? 0 }
			: null,
		email: emailUsage,
		fetchedAt: new Date(nowMs).toISOString(),
		plan,
	};
	cachedUsageUntil = nowMs + 60_000;
	return cachedUsage;
}
