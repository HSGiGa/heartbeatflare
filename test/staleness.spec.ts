// Pure-lib tests for the scheduler staleness/capacity detector (Issue #45). Mirrors test/vpc.spec.ts style.
import { describe, it, expect } from 'vitest';
import { schedulerStaleness } from '../src/staleness';

const now = Date.parse('2026-06-21T12:00:00Z');
const minsAgo = (m: number) => new Date(now - m * 60_000).toISOString();

describe('schedulerStaleness — stalled (global)', () => {
	it('flags stalled when the freshest external check is older than 3× the shortest interval', () => {
		const out = schedulerStaleness(
			[
				{ type: 'http', interval_seconds: 60, last_check_at: minsAgo(10) },
				{ type: 'tcp', interval_seconds: 300, last_check_at: minsAgo(20) },
			],
			now,
		);
		expect(out.stalled).toBe(true);
		expect(out.freshest).toBe(minsAgo(10));
		expect(out.thresholdMs).toBe(180_000); // floor (3 min), since 3×60s = 180s
	});

	it('is not stalled when a check ran within the threshold', () => {
		const out = schedulerStaleness([{ type: 'http', interval_seconds: 60, last_check_at: minsAgo(2) }], now);
		expect(out.stalled).toBe(false);
	});

	it('ignores heartbeat, paused, and disabled monitors', () => {
		const out = schedulerStaleness(
			[
				{ type: 'heartbeat', interval_seconds: 60, last_check_at: minsAgo(120) },
				{ type: 'http', interval_seconds: 60, last_check_at: minsAgo(120), paused: 1 },
				{ type: 'http', interval_seconds: 60, last_check_at: minsAgo(120), enabled: 0 },
			],
			now,
		);
		expect(out.stalled).toBe(false);
		expect(out.ageMs).toBeNull();
		expect(out.behindCount).toBe(0);
	});
});

describe('schedulerStaleness — behindCount (capacity)', () => {
	it('counts monitors overdue beyond their own threshold while others stay fresh (not stalled)', () => {
		const out = schedulerStaleness(
			[
				{ type: 'http', interval_seconds: 60, last_check_at: minsAgo(1) }, // fresh → keeps stalled=false
				{ type: 'http', interval_seconds: 60, last_check_at: minsAgo(10) }, // > 3 min → behind
				{ type: 'tcp', interval_seconds: 300, last_check_at: minsAgo(20) }, // > 15 min → behind
			],
			now,
		);
		expect(out.stalled).toBe(false);
		expect(out.behindCount).toBe(2);
	});

	it('applies a created_at grace period to never-checked monitors', () => {
		const fresh = schedulerStaleness([{ type: 'http', interval_seconds: 60, last_check_at: null, created_at: minsAgo(2) }], now);
		expect(fresh.behindCount).toBe(0); // within the 3-min grace
		const old = schedulerStaleness([{ type: 'http', interval_seconds: 60, last_check_at: null, created_at: minsAgo(30) }], now);
		expect(old.behindCount).toBe(1); // grace elapsed, still never checked
	});

	it('skips a never-checked monitor with no created_at (cannot judge)', () => {
		const out = schedulerStaleness([{ type: 'http', interval_seconds: 60, last_check_at: null }], now);
		expect(out).toMatchObject({ stalled: false, behindCount: 0, ageMs: null, freshest: null });
	});
});
