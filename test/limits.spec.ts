// Pure-lib tests for the scheduler capacity math (Issue #45). Shared by runtime + the import warning.
import { describe, it, expect } from 'vitest';
import { MAX_CHECKS_PER_RUN, probeDemandPerMinute, effectiveCadenceMinutes } from '../src/limits';

describe('probeDemandPerMinute', () => {
	it('sums 60/interval over enabled external monitors, including mode: internal', () => {
		const demand = probeDemandPerMinute([
			{ type: 'http', interval_seconds: 60 }, // 1.0/min
			{ type: 'tcp', interval_seconds: 120 }, // 0.5/min
			{ type: 'http', interval_seconds: 60, mode: 'internal' }, // 1.0/min (VPC still uses a slot)
		]);
		expect(demand).toBeCloseTo(2.5, 5);
	});

	it('excludes heartbeat, paused, and disabled monitors', () => {
		const demand = probeDemandPerMinute([
			{ type: 'heartbeat', interval_seconds: 60 },
			{ type: 'http', interval_seconds: 60, paused: 1 },
			{ type: 'http', interval_seconds: 60, enabled: 0 },
			{ type: 'dns', interval_seconds: 60 }, // only this counts
		]);
		expect(demand).toBeCloseTo(1.0, 5);
	});
});

describe('effectiveCadenceMinutes', () => {
	it('returns the nominal interval when demand is within capacity', () => {
		expect(effectiveCadenceMinutes(60, MAX_CHECKS_PER_RUN)).toBeCloseTo(1, 5); // demand == capacity → 1×
	});

	it('stretches the cadence proportionally to overload', () => {
		// 60s nominal (1 min), demand 6/min vs capacity 3 → ~2× → ~2 min
		expect(effectiveCadenceMinutes(60, 6)).toBeCloseTo((6 / MAX_CHECKS_PER_RUN) * 1, 5);
	});
});
