// Per-deployment rate-limit namespace derivation (Issue #63). Pure (no Node/SDK deps) so it runs in
// the Workers vitest pool alongside the source tests, mirroring scripts/lib/placement.ts.
//
// A Workers Rate Limiting binding's `namespace_id` "uniquely defines this rate limiting namespace
// within your Cloudflare account" — bindings sharing a namespace_id, even across different Workers on
// the same account, share the same rate-limit counters for a given key:
// https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
//
// The template ships fixed literals (1001/1002/1003), so two heartbeatflare deployments in one account
// silently share /beat and read-endpoint budgets. We derive namespace_id per deployment+binding here so
// each deployment gets independent counters, matching how D1/queue names already derive from deploy.name.

// Wrangler rate-limit binding shape (what lands in wrangler.jsonc). Matches the `ratelimits[]` entries
// in wrangler.template.jsonc.
export interface RateLimitBinding {
	name: string;
	namespace_id: string;
	simple: { limit: number; period: number };
}

// FNV-1a 32-bit hash over the string's UTF-16 code units (a variant of the canonical byte-wise FNV-1a;
// charCodeAt, not the UTF-8 bytes). Deterministic and dependency-free, so the same deploy.name + binding
// pair yields the same namespace_id on every machine and every run.
function fnv1a32(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		// Multiply by the FNV prime (16777619) using 32-bit overflow arithmetic.
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

// Derives a rate-limit namespace_id from the deployment name and binding name. Cloudflare requires a
// string containing a positive integer; we mask the FNV-1a hash to a positive 31-bit int (mapping the
// zero case to 1) so the result is always in [1, 2^31 - 1]. The salted key keeps IDs distinct across
// deployments and across bindings within a deployment, and stable for a given pair.
export function rateLimitNamespaceId(deployName: string, bindingName: string): string {
	const key = `heartbeatflare:ratelimit:v1:${deployName}:${bindingName}`;
	const masked = fnv1a32(key) & 0x7fffffff;
	return String(masked === 0 ? 1 : masked);
}

// Rewrites every template rate-limit binding with a per-deployment namespace_id, preserving all other
// fields (name, simple.limit, simple.period) verbatim.
export function buildRateLimits(deployName: string, bindings: readonly RateLimitBinding[]): RateLimitBinding[] {
	return bindings.map((binding) => ({
		...binding,
		namespace_id: rateLimitNamespaceId(deployName, binding.name),
	}));
}
