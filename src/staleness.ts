// Detects two distinct failure modes of the scheduler (Issue #45), surfaced loudly instead of silently:
//   • stalled  — NO external monitor has recorded a check within the threshold → cron likely wedged.
//   • behind   — individual monitors overdue while others keep checking → capacity overload (too many
//                monitors for the per-tick probe cap). The global "freshest check" signal can't see this.
// Pure and side-effect free so it is testable and cheap to call on the fetch path.
export type StaleCheckInput = {
	type: string;
	last_check_at: string | null;
	created_at?: string | null;
	interval_seconds: number;
	paused?: number;
	enabled?: number;
};

export type Staleness = {
	stalled: boolean; // freshest external check older than the global threshold (cron likely dead)
	behindCount: number; // active monitors individually overdue beyond their own threshold
	ageMs: number | null; // age of the freshest external check, or null when none have run yet
	freshest: string | null;
	thresholdMs: number; // global threshold (3× shortest active interval, floored at 3 min)
};

// Per-monitor "overdue" threshold: 3× its interval, floored at 3 min so a single skipped 1-min tick
// doesn't false-alarm. Doubles as the grace period for never-checked monitors (measured from created_at).
function monitorThresholdMs(intervalSeconds: number): number {
	return Math.max(180_000, (intervalSeconds || 60) * 3000);
}

// Only externally-probed monitors advance via the scheduler; heartbeats are push-driven and paused/
// disabled ones are intentionally idle. mode: internal (VPC) checks count — they use a scheduler slot.
export function schedulerStaleness(monitors: StaleCheckInput[], nowMs: number): Staleness {
	const active = monitors.filter(
		(m) => ['http', 'tcp', 'dns'].includes(m.type) && m.paused !== 1 && m.enabled !== 0,
	);
	const minIntervalSec = active.reduce((min, m) => Math.min(min, m.interval_seconds || 60), Number.POSITIVE_INFINITY);
	const thresholdMs = Math.max(180_000, (Number.isFinite(minIntervalSec) ? minIntervalSec : 60) * 3000);

	const checkedAt = active
		.map((m) => (m.last_check_at ? Date.parse(m.last_check_at) : NaN))
		.filter((t) => Number.isFinite(t));
	const freshestMs = checkedAt.length > 0 ? Math.max(...checkedAt) : null;
	const ageMs = freshestMs === null ? null : nowMs - freshestMs;
	const stalled = ageMs !== null && ageMs > thresholdMs;

	// Per-monitor lag, with a created_at-based grace so a freshly-imported monitor isn't flagged before
	// it has had a fair chance to run. A never-checked monitor with no created_at is skipped (can't judge).
	let behindCount = 0;
	for (const m of active) {
		const ref = m.last_check_at ?? m.created_at ?? null;
		if (!ref) continue;
		const age = nowMs - Date.parse(ref);
		if (Number.isFinite(age) && age > monitorThresholdMs(m.interval_seconds)) behindCount++;
	}

	return { stalled, behindCount, ageMs, freshest: freshestMs === null ? null : new Date(freshestMs).toISOString(), thresholdMs };
}
