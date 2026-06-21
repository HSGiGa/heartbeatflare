// Pure-lib tests for the scheduler staleness detector (Issue #45). Mirrors test/vpc.spec.ts style.
import { describe, it, expect } from 'vitest';
import { schedulerStaleness } from '../src/staleness';

const now = Date.parse('2026-06-21T12:00:00Z');
const minsAgo = (m: number) => new Date(now - m * 60_000).toISOString();

describe('schedulerStaleness', () => {
	it('flags stale when the freshest external check is older than 3× the shortest interval', () => {
		const out = schedulerStaleness(
			[
				{ type: 'http', interval_seconds: 60, last_check_at: minsAgo(10) },
				{ type: 'tcp', interval_seconds: 300, last_check_at: minsAgo(20) },
			],
			now,
		);
		expect(out.stale).toBe(true);
		expect(out.freshest).toBe(minsAgo(10)); // most recent of the two
		expect(out.thresholdMs).toBe(180_000); // floor (3 min) since 3×60s = 180s
	});

	it('is not stale when a check ran within the threshold', () => {
		const out = schedulerStaleness([{ type: 'http', interval_seconds: 60, last_check_at: minsAgo(2) }], now);
		expect(out.stale).toBe(false);
	});

	it('uses 3× the shortest interval when that exceeds the 3-min floor', () => {
		// shortest interval 300s → threshold 900s (15 min); a 12-min-old check is still fresh.
		const out = schedulerStaleness([{ type: 'tcp', interval_seconds: 300, last_check_at: minsAgo(12) }], now);
		expect(out.thresholdMs).toBe(900_000);
		expect(out.stale).toBe(false);
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
		expect(out.stale).toBe(false);
		expect(out.ageMs).toBeNull(); // no active external monitor contributes a timestamp
	});

	it('is not stale when no active monitor has ever been checked', () => {
		const out = schedulerStaleness([{ type: 'http', interval_seconds: 60, last_check_at: null }], now);
		expect(out).toMatchObject({ stale: false, ageMs: null, freshest: null });
	});
});
