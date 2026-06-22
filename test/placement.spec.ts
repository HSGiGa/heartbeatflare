// Workers placement config helpers (Issue #48). Pure-lib tests for validation and wrangler
// `placement` generation — mirrors test/vpc.spec.ts (generate-time helpers in the WP pool).
//
// Valid forms mirror Wrangler's placement schema: Smart Placement (mode smart/off, no
// region/hostname) or an explicit hint (exactly one of region/hostname; mode optional, "targeted" if
// set).
import { describe, it, expect } from 'vitest';
import { buildPlacement, validatePlacementConfig } from '../scripts/lib/placement';

describe('validatePlacementConfig', () => {
	it('accepts Smart Placement modes on their own', () => {
		expect(() => validatePlacementConfig({ mode: 'smart' })).not.toThrow();
		expect(() => validatePlacementConfig({ mode: 'off' })).not.toThrow();
	});

	it('accepts a region or hostname hint with no mode', () => {
		expect(() => validatePlacementConfig({ region: 'aws:eu-central-1' })).not.toThrow();
		expect(() => validatePlacementConfig({ hostname: 'api.example.com' })).not.toThrow();
	});

	it('accepts a region or hostname hint with mode: targeted', () => {
		expect(() => validatePlacementConfig({ mode: 'targeted', region: 'aws:eu-central-1' })).not.toThrow();
		expect(() => validatePlacementConfig({ mode: 'targeted', hostname: 'api.example.com' })).not.toThrow();
	});

	it('rejects an empty placement (no mode, no hint)', () => {
		expect(() => validatePlacementConfig({})).toThrowError(/empty/i);
	});

	it('rejects an unsupported mode', () => {
		expect(() => validatePlacementConfig({ mode: 'fast' })).toThrowError(/unsupported/i);
	});

	it('rejects mode: targeted with no hint', () => {
		expect(() => validatePlacementConfig({ mode: 'targeted' })).toThrowError(/requires a region or hostname/i);
	});

	it('rejects a hint combined with a non-targeted mode', () => {
		expect(() => validatePlacementConfig({ mode: 'smart', region: 'aws:eu-central-1' })).toThrowError(/cannot be combined/i);
		expect(() => validatePlacementConfig({ mode: 'off', hostname: 'api.example.com' })).toThrowError(/cannot be combined/i);
	});

	it('rejects both region and hostname together', () => {
		expect(() =>
			validatePlacementConfig({ region: 'aws:eu-central-1', hostname: 'api.example.com' }),
		).toThrowError(/mutually exclusive/i);
	});

	it('rejects an empty or non-string region/hostname', () => {
		expect(() => validatePlacementConfig({ region: '   ' })).toThrowError(/region must be a non-empty string/i);
		// YAML can parse unquoted scalars as numbers; the validator must reject them.
		expect(() => validatePlacementConfig({ hostname: 123 as unknown as string })).toThrowError(/hostname must be a non-empty string/i);
	});
});

describe('buildPlacement', () => {
	it('emits Smart Placement as mode only', () => {
		expect(buildPlacement({ mode: 'smart' })).toEqual({ mode: 'smart' });
		expect(buildPlacement({ mode: 'off' })).toEqual({ mode: 'off' });
	});

	it('emits a mode-less region/hostname hint verbatim', () => {
		expect(buildPlacement({ region: 'aws:eu-central-1' })).toEqual({ region: 'aws:eu-central-1' });
		expect(buildPlacement({ hostname: 'api.example.com' })).toEqual({ hostname: 'api.example.com' });
	});

	it('preserves an explicit targeted hint verbatim', () => {
		expect(buildPlacement({ mode: 'targeted', region: 'aws:eu-central-1' })).toEqual({
			mode: 'targeted',
			region: 'aws:eu-central-1',
		});
	});

	it('throws on invalid config rather than emitting it', () => {
		expect(() => buildPlacement({ mode: 'smart', region: 'aws:eu-central-1' })).toThrowError(/cannot be combined/i);
	});
});
