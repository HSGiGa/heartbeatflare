import { describe, it, expect } from 'vitest';
import { retryBackoffBase, retryDelaySeconds } from '../src/queue';

describe('notification retry backoff', () => {
	it('grows exponentially from 10s and caps at 180s', () => {
		const bases = [1, 2, 3, 4, 5, 6, 7, 8].map(retryBackoffBase);
		expect(bases).toEqual([10, 20, 40, 80, 160, 180, 180, 180]);
	});

	it('jittered delay is an integer within [base/2, base] across attempts', () => {
		for (let attempts = 1; attempts <= 8; attempts++) {
			const base = retryBackoffBase(attempts);
			for (let i = 0; i < 200; i++) {
				const d = retryDelaySeconds(attempts);
				expect(Number.isInteger(d)).toBe(true);
				expect(d).toBeGreaterThanOrEqual(Math.floor(base / 2));
				expect(d).toBeLessThanOrEqual(base);
			}
		}
	});
});
