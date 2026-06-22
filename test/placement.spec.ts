// Workers placement config helpers (Issue #48). Pure-lib tests for validation and wrangler
// `placement` generation — mirrors test/vpc.spec.ts (generate-time helpers in the WP pool).
//
// Valid forms mirror Wrangler's placement schema: Smart Placement (mode smart/off, no
// region/hostname) or a targeted hint (mode targeted + exactly one of region/hostname).
import { describe, it, expect } from 'vitest';
import { buildPlacement, validatePlacementConfig } from '../scripts/lib/placement';

describe('validatePlacementConfig', () => {
	it('accepts Smart Placement modes on their own', () => {
		expect(() => validatePlacementConfig({ mode: 'smart' })).not.toThrow();
		expect(() => validatePlacementConfig({ mode: 'off' })).not.toThrow();
	});

	it('accepts a targeted region or hostname', () => {
		expect(() => validatePlacementConfig({ mode: 'targeted', region: 'aws:eu-central-1' })).not.toThrow();
		expect(() => validatePlacementConfig({ mode: 'targeted', hostname: 'api.example.com' })).not.toThrow();
	});

	it('requires mode', () => {
		expect(() => validatePlacementConfig({})).toThrowError(/mode is required/i);
		expect(() => validatePlacementConfig({ region: 'aws:eu-central-1' })).toThrowError(/mode is required/i);
	});

	it('rejects an unsupported mode', () => {
		expect(() => validatePlacementConfig({ mode: 'fast' })).toThrowError(/unsupported/i);
	});

	it('rejects region/hostname under a smart/off mode', () => {
		expect(() => validatePlacementConfig({ mode: 'smart', region: 'aws:eu-central-1' })).toThrowError(/require mode: targeted/i);
		expect(() => validatePlacementConfig({ mode: 'off', hostname: 'api.example.com' })).toThrowError(/require mode: targeted/i);
	});

	it('rejects a targeted mode with neither region nor hostname', () => {
		expect(() => validatePlacementConfig({ mode: 'targeted' })).toThrowError(/requires exactly one/i);
	});

	it('rejects a targeted mode with both region and hostname', () => {
		expect(() =>
			validatePlacementConfig({ mode: 'targeted', region: 'aws:eu-central-1', hostname: 'api.example.com' }),
		).toThrowError(/mutually exclusive/i);
	});

	it('rejects an empty or non-string region/hostname', () => {
		expect(() => validatePlacementConfig({ mode: 'targeted', region: '   ' })).toThrowError(/region must be a non-empty string/i);
		// YAML can parse unquoted scalars as numbers; the validator must reject them.
		expect(() => validatePlacementConfig({ mode: 'targeted', hostname: 123 as unknown as string })).toThrowError(/hostname must be a non-empty string/i);
	});
});

describe('buildPlacement', () => {
	it('emits Smart Placement as mode only', () => {
		expect(buildPlacement({ mode: 'smart' })).toEqual({ mode: 'smart' });
		expect(buildPlacement({ mode: 'off' })).toEqual({ mode: 'off' });
	});

	it('preserves a targeted region verbatim', () => {
		expect(buildPlacement({ mode: 'targeted', region: 'aws:eu-central-1' })).toEqual({
			mode: 'targeted',
			region: 'aws:eu-central-1',
		});
	});

	it('preserves a targeted hostname verbatim', () => {
		expect(buildPlacement({ mode: 'targeted', hostname: 'api.example.com' })).toEqual({
			mode: 'targeted',
			hostname: 'api.example.com',
		});
	});

	it('throws on invalid config rather than emitting it', () => {
		expect(() => buildPlacement({ mode: 'smart', region: 'aws:eu-central-1' })).toThrowError(/require mode: targeted/i);
	});
});
