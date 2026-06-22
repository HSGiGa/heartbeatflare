// Workers placement config helpers (Issue #48). Pure (no Node/SDK deps) so it runs in the Workers
// vitest pool alongside the source tests, mirroring scripts/lib/vpc.ts.
//
// Maps deploy.placement straight onto Wrangler's `placement` object (same field names) so Smart
// Placement / region hints land in the generated wrangler.jsonc:
// https://developers.cloudflare.com/workers/configuration/placement/
//
// v1 exposes mode/region/hostname only (not the layer-4 `host` probe). mode accepts "smart" — the
// only value Wrangler supports.

export interface PlacementConfig {
	hostname?: string;
	mode?: string;
	region?: string;
}

// Wrangler binding output shape (what lands in wrangler.jsonc). Only the supplied fields are emitted.
export interface PlacementBinding {
	mode?: string;
	region?: string;
	hostname?: string;
}

// Validates the shape of deploy.placement against what Wrangler actually accepts, throwing a clear
// message on the first problem. Run at config:import time (not just wrangler generation) so bad
// values never reach D1. Two valid forms mirror Wrangler's placement schema:
//   - Smart Placement: mode "smart" (or "off"), with no region/hostname.
//   - Targeted hint:   mode "targeted" with exactly one of region/hostname (non-empty strings).
export function validatePlacementConfig(placement: PlacementConfig): void {
	const { hostname, mode, region } = placement;
	if (mode === undefined) {
		throw new Error('deploy.placement.mode is required — use "smart" (or "off"), or "targeted" with a region/hostname.');
	}
	const requireNonEmptyString = (value: unknown, field: string): void => {
		if (typeof value !== 'string' || value.trim() === '') {
			throw new Error(`deploy.placement.${field} must be a non-empty string.`);
		}
	};

	if (mode === 'smart' || mode === 'off') {
		if (region !== undefined || hostname !== undefined) {
			throw new Error(`deploy.placement.mode "${mode}" does not take region/hostname — those require mode: targeted.`);
		}
		return;
	}

	if (mode === 'targeted') {
		if (region !== undefined && hostname !== undefined) {
			throw new Error('deploy.placement sets both region and hostname — they are mutually exclusive; set exactly one.');
		}
		if (region === undefined && hostname === undefined) {
			throw new Error('deploy.placement.mode "targeted" requires exactly one of region or hostname.');
		}
		if (region !== undefined) requireNonEmptyString(region, 'region');
		if (hostname !== undefined) requireNonEmptyString(hostname, 'hostname');
		return;
	}

	throw new Error(`deploy.placement.mode "${mode}" is unsupported — use "smart", "off", or "targeted".`);
}

// Builds the wrangler `placement` object from deploy.placement, omitting unset fields. Returns null
// when nothing is configured so the caller can leave `placement` out of wrangler.jsonc entirely.
export function buildPlacement(placement: PlacementConfig): PlacementBinding | null {
	validatePlacementConfig(placement);
	const out: PlacementBinding = {};
	if (placement.mode !== undefined) out.mode = placement.mode;
	if (placement.region !== undefined) out.region = placement.region;
	if (placement.hostname !== undefined) out.hostname = placement.hostname;
	return Object.keys(out).length > 0 ? out : null;
}
