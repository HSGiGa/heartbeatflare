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

// Validates the shape of deploy.placement, throwing a clear message on the first problem: at least
// one hint must be set (an empty placement: {} is a config mistake), and mode — if present — must be
// "smart".
export function validatePlacementConfig(placement: PlacementConfig): void {
	const { hostname, mode, region } = placement;
	if (!hostname && !mode && !region) {
		throw new Error('deploy.placement is empty — set at least one of "mode", "region", or "hostname".');
	}
	if (mode !== undefined && mode !== 'smart') {
		throw new Error(`deploy.placement.mode "${mode}" is unsupported — the only accepted value is "smart".`);
	}
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
