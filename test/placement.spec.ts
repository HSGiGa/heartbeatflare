// Workers placement config helpers (Issue #48). Pure-lib tests for validation and wrangler
// `placement` generation — mirrors test/vpc.spec.ts (generate-time helpers in the WP pool).
import { describe, it, expect } from 'vitest';
import { buildPlacement, validatePlacementConfig } from '../scripts/lib/placement';

describe('validatePlacementConfig', () => {
	it('accepts each supported field on its own', () => {
		expect(() => validatePlacementConfig({ mode: 'smart' })).not.toThrow();
		expect(() => validatePlacementConfig({ region: 'aws:eu-central-1' })).not.toThrow();
		expect(() => validatePlacementConfig({ hostname: 'api.example.com' })).not.toThrow();
	});

	it('accepts all fields together', () => {
		expect(() =>
			validatePlacementConfig({ mode: 'smart', region: 'aws:eu-central-1', hostname: 'api.example.com' }),
		).not.toThrow();
	});

	it('rejects an empty placement block', () => {
		expect(() => validatePlacementConfig({})).toThrowError(/at least one/i);
	});

	it('rejects a mode other than "smart"', () => {
		expect(() => validatePlacementConfig({ mode: 'off' })).toThrowError(/unsupported/i);
	});
});

describe('buildPlacement', () => {
	it('returns null for an empty object', () => {
		// validate first guards against empty; buildPlacement surfaces the same error.
		expect(() => buildPlacement({})).toThrowError(/at least one/i);
	});

	it('returns only mode when only mode is set', () => {
		expect(buildPlacement({ mode: 'smart' })).toEqual({ mode: 'smart' });
	});

	it('preserves region and hostname verbatim', () => {
		expect(buildPlacement({ region: 'aws:eu-central-1' })).toEqual({ region: 'aws:eu-central-1' });
		expect(buildPlacement({ hostname: 'api.example.com' })).toEqual({ hostname: 'api.example.com' });
	});

	it('omits unset fields', () => {
		expect(buildPlacement({ mode: 'smart', hostname: 'api.example.com' })).toEqual({
			mode: 'smart',
			hostname: 'api.example.com',
		});
	});

	it('emits all three fields when all are set', () => {
		expect(
			buildPlacement({ mode: 'smart', region: 'aws:eu-central-1', hostname: 'api.example.com' }),
		).toEqual({ mode: 'smart', region: 'aws:eu-central-1', hostname: 'api.example.com' });
	});
});
