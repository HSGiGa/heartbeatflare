// Custom HTTP probe headers + default User-Agent (Issue #16). Covers the pure header helpers, the
// runtime ${VAR} resolution (incl. the fail-on-missing-secret guard that prevents placeholder leaks),
// the generate-time non-http / User-Agent rejection, and real header delivery on the wire.
import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { buildProbeHeaders, httpCheck, PROBE_USER_AGENT, tcpCheck } from '../src/probes';
import { resolveProbeHeaders } from '../src/scheduler';
import { buildProbeHeadersMap } from '../scripts/lib/probe-headers';

describe('buildProbeHeaders', () => {
	it('always sets the default User-Agent', () => {
		expect(buildProbeHeaders().get('User-Agent')).toBe('heartbeatflare/1.0');
		expect(PROBE_USER_AGENT).toBe('heartbeatflare/1.0');
	});

	it('delivers custom headers alongside the default UA', () => {
		const h = buildProbeHeaders({ 'X-Healthcheck-Token': 'sekret' });
		expect(h.get('X-Healthcheck-Token')).toBe('sekret');
		expect(h.get('User-Agent')).toBe('heartbeatflare/1.0');
	});

	it('does not let config override the default User-Agent (case-insensitive)', () => {
		expect(buildProbeHeaders({ 'User-Agent': 'evil/9' }).get('User-Agent')).toBe('heartbeatflare/1.0');
		expect(buildProbeHeaders({ 'user-agent': 'evil/9' }).get('User-Agent')).toBe('heartbeatflare/1.0');
	});
});

describe('resolveProbeHeaders', () => {
	it('substitutes ${VAR} from env', () => {
		const resolved = resolveProbeHeaders(env, { 'X-Healthcheck-Token': '${TEST_MONITOR_SECRET}' });
		expect(resolved['X-Healthcheck-Token']).toBe('sekret');
	});

	it('throws on a missing secret and never returns the literal placeholder', () => {
		expect(() => resolveProbeHeaders(env, { 'X-Foo': '${NOPE_MISSING_SECRET}' })).toThrowError(
			/header "X-Foo" references unset secret NOPE_MISSING_SECRET/,
		);
	});
});

describe('buildProbeHeadersMap (generate-time)', () => {
	it('maps an http monitor by slug, preserving placeholders', () => {
		const map = buildProbeHeadersMap([{ name: 'Example API', type: 'http', headers: { 'X-Healthcheck-Token': '${HEALTHCHECK_TOKEN}' } }]);
		expect(map).toEqual({ 'example-api': { 'X-Healthcheck-Token': '${HEALTHCHECK_TOKEN}' } });
	});

	it('skips monitors without headers', () => {
		expect(buildProbeHeadersMap([{ name: 'Plain', type: 'http' }])).toEqual({});
	});

	it('rejects headers on non-http monitors', () => {
		for (const type of ['tcp', 'dns', 'heartbeat']) {
			expect(() => buildProbeHeadersMap([{ name: 'X', type, headers: { A: 'b' } }])).toThrowError(/only supported on type: http/);
		}
	});

	it('rejects a config attempt to set User-Agent (case-insensitive)', () => {
		expect(() => buildProbeHeadersMap([{ name: 'API', type: 'http', headers: { 'User-Agent': 'evil/9' } }])).toThrowError(/cannot set a "User-Agent" header/);
		expect(() => buildProbeHeadersMap([{ name: 'API', type: 'http', headers: { 'user-agent': 'evil/9' } }])).toThrowError(/cannot set a "User-Agent" header/);
	});
});

describe('probe transport injection (Workers VPC, Issue #18)', () => {
	it('httpCheck uses the injected fetcher, not global fetch', async () => {
		const orig = globalThis.fetch;
		globalThis.fetch = vi.fn(() => Promise.reject(new Error('global fetch must not be used'))) as typeof fetch;
		const fetcher = vi.fn(async () => new Response('ok', { status: 200 }));
		try {
			const res = await httpCheck('http://demo.internal/health', false, undefined, fetcher);
			expect(res.status).toBe('up');
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(String(fetcher.mock.calls[0][0])).toBe('http://demo.internal/health');
			expect(globalThis.fetch).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = orig;
		}
	});

	it('tcpCheck uses the injected connector with parsed host/port', async () => {
		const close = vi.fn();
		const connector = vi.fn(() => ({ opened: Promise.resolve(), close }) as unknown as Socket);
		const res = await tcpCheck('10.0.1.50:6379', connector);
		expect(res.status).toBe('up');
		expect(connector).toHaveBeenCalledTimes(1);
		expect(connector.mock.calls[0][0]).toEqual({ hostname: '10.0.1.50', port: 6379 });
		expect(close).toHaveBeenCalled();
	});
});

describe('httpCheck header delivery', () => {
	it('sends the default User-Agent and custom headers on the wire', async () => {
		const orig = globalThis.fetch;
		let captured: Headers | undefined;
		globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			captured = new Headers(init?.headers);
			return new Response('ok', { status: 200 });
		}) as typeof fetch;
		try {
			const res = await httpCheck('https://probe.example.com/', false, { 'X-Healthcheck-Token': 'sekret' });
			expect(res.status).toBe('up');
			expect(captured?.get('user-agent')).toBe('heartbeatflare/1.0');
			expect(captured?.get('x-healthcheck-token')).toBe('sekret');
		} finally {
			globalThis.fetch = orig;
		}
	});
});
