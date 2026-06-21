// Free-plan scheduler capacity (Issue #45). Shared by the runtime scheduler and the build-time config
// warning so the math can't drift. Checks run directly in cron (not via Queues, which cap at 10k
// ops/day on Free); each cron tick probes at most MAX_CHECKS_PER_RUN monitors with at most
// MAX_CONCURRENT_CHECKS in flight. These are conservative starting points — verify CPU with real
// telemetry (workersInvocationsAdaptive quantiles) and tune; they are not a guaranteed-under-10ms claim.
export const MAX_CHECKS_PER_RUN = 3;
export const MAX_CONCURRENT_CHECKS = 2;

export type ProbeDemandInput = {
	type: string;
	interval_seconds: number;
	paused?: number;
	enabled?: number;
	mode?: string;
};

// Probes required per minute to honour every monitor's configured interval. Counts all enabled,
// non-paused pull monitors (http/tcp/dns) — including mode: internal (VPC) checks, which also take a
// scheduler slot. Heartbeat monitors are push-driven and excluded.
export function probeDemandPerMinute(monitors: ProbeDemandInput[]): number {
	return monitors
		.filter((m) => ['http', 'tcp', 'dns'].includes(m.type) && m.paused !== 1 && m.enabled !== 0)
		.reduce((sum, m) => sum + 60 / (m.interval_seconds || 60), 0);
}

// Estimated real cadence (minutes) for a monitor of the given interval under the current demand. When
// demand exceeds MAX_CHECKS_PER_RUN the scheduler can't keep up, so the effective interval stretches by
// roughly demand/capacity. An estimate only: actual order is oldest-checked-first and varies with
// timeouts/errors.
export function effectiveCadenceMinutes(intervalSeconds: number, demandPerMinute: number): number {
	const nominalMin = intervalSeconds / 60;
	const overload = Math.max(1, demandPerMinute / MAX_CHECKS_PER_RUN);
	return nominalMin * overload;
}
