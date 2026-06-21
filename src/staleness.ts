// Detects a wedged/stalled scheduler (Issue #45): if no external monitor has recorded a check
// within a few of its own intervals, checks have stopped advancing — surfaced loudly on the status
// page and in cron logs instead of failing silently. Pure and side-effect free so it is testable and
// cheap to call on the fetch path.
export type StaleCheckInput = {
	type: string;
	last_check_at: string | null;
	interval_seconds: number;
	paused?: number;
	enabled?: number;
};

export type Staleness = {
	stale: boolean;
	ageMs: number | null; // age of the freshest external check, or null when none have run yet
	freshest: string | null;
	thresholdMs: number;
};

// Only externally-probed monitors advance via the scheduler; heartbeats are push-driven and paused/
// disabled ones are intentionally idle. Threshold = 3× the shortest active interval, floored at 3 min
// so a single 1-min monitor doesn't false-alarm on one skipped tick.
export function schedulerStaleness(monitors: StaleCheckInput[], nowMs: number): Staleness {
	const active = monitors.filter(
		(m) => ['http', 'tcp', 'dns'].includes(m.type) && m.paused !== 1 && m.enabled !== 0,
	);
	const minIntervalSec = active.reduce((min, m) => Math.min(min, m.interval_seconds || 60), Number.POSITIVE_INFINITY);
	const thresholdMs = Math.max(180_000, (Number.isFinite(minIntervalSec) ? minIntervalSec : 60) * 3000);

	const checkedAt = active
		.map((m) => (m.last_check_at ? Date.parse(m.last_check_at) : NaN))
		.filter((t) => Number.isFinite(t));
	if (checkedAt.length === 0) return { stale: false, ageMs: null, freshest: null, thresholdMs };

	const freshestMs = Math.max(...checkedAt);
	const ageMs = nowMs - freshestMs;
	return { stale: ageMs > thresholdMs, ageMs, freshest: new Date(freshestMs).toISOString(), thresholdMs };
}
