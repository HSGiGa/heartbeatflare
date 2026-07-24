// Per-deployment rate-limit namespace derivation (Issue #63). Pure-lib tests for the generate-time
// helper — mirrors test/placement.spec.ts (generate-time helpers in the WP pool).
import { describe, it, expect } from 'vitest';
import { buildRateLimits, rateLimitNamespaceId, type RateLimitBinding } from '../scripts/lib/ratelimits';

describe('rateLimitNamespaceId', () => {
	it('is deterministic for the same deploy + binding pair', () => {
		expect(rateLimitNamespaceId('acme-prod', 'BEAT_IP_RATE_LIMITER')).toBe(
			rateLimitNamespaceId('acme-prod', 'BEAT_IP_RATE_LIMITER'),
		);
	});

	it('differs across deployments for the same binding', () => {
		expect(rateLimitNamespaceId('acme-prod', 'BEAT_IP_RATE_LIMITER')).not.toBe(
			rateLimitNamespaceId('acme-staging', 'BEAT_IP_RATE_LIMITER'),
		);
	});

	it('differs across bindings within one deployment', () => {
		const ids = [
			rateLimitNamespaceId('acme-prod', 'BEAT_IP_RATE_LIMITER'),
			rateLimitNamespaceId('acme-prod', 'BEAT_MONITOR_RATE_LIMITER'),
			rateLimitNamespaceId('acme-prod', 'READ_IP_RATE_LIMITER'),
		];
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('always yields a positive-integer string', () => {
		for (const deploy of ['acme-prod', 'a', 'x'.repeat(63), 'name-with-üñïçødé']) {
			for (const binding of ['BEAT_IP_RATE_LIMITER', 'BEAT_MONITOR_RATE_LIMITER', 'READ_IP_RATE_LIMITER']) {
				expect(rateLimitNamespaceId(deploy, binding)).toMatch(/^[1-9]\d*$/);
			}
		}
	});
});

describe('buildRateLimits', () => {
	const template: RateLimitBinding[] = [
		{ name: 'BEAT_IP_RATE_LIMITER', namespace_id: '1001', simple: { limit: 60, period: 60 } },
		{ name: 'BEAT_MONITOR_RATE_LIMITER', namespace_id: '1002', simple: { limit: 20, period: 60 } },
		{ name: 'READ_IP_RATE_LIMITER', namespace_id: '1003', simple: { limit: 120, period: 60 } },
	];

	it('overwrites the placeholder ids and preserves name + limits', () => {
		const out = buildRateLimits('acme-prod', template);
		expect(out).toHaveLength(template.length);
		out.forEach((binding, i) => {
			expect(binding.name).toBe(template[i].name);
			expect(binding.simple).toEqual(template[i].simple);
			expect(binding.namespace_id).toBe(rateLimitNamespaceId('acme-prod', template[i].name));
			expect(binding.namespace_id).not.toMatch(/^100[123]$/);
		});
	});

	it('gives every entry a distinct namespace_id', () => {
		const ids = buildRateLimits('acme-prod', template).map((b) => b.namespace_id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('does not mutate the input bindings', () => {
		buildRateLimits('acme-prod', template);
		expect(template[0].namespace_id).toBe('1001');
	});
});
