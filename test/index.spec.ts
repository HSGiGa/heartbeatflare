import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
import { _invalidateAuthCache } from '../src/auth';
import { CONNECTIVITY_CLASS, evaluateAlerts } from '../src/alerts';
import type { AlertRuleDbRow, MonitorRow } from '../src/types';
// Apply the full migration chain in order so the test schema always matches production —
// add each new migration here when it lands, or columns added later (paused, escalation, …)
// will be missing and queries against them will fail.
// @ts-expect-error vite ?raw import
import m01 from '../migrations/0001_initial_schema.sql?raw';
// @ts-expect-error vite ?raw import
import m02 from '../migrations/0002_remove_ping_type.sql?raw';
// @ts-expect-error vite ?raw import
import m03 from '../migrations/0003_add_ssl_check.sql?raw';
// @ts-expect-error vite ?raw import
import m04 from '../migrations/0004_uptime_aggregates.sql?raw';
// @ts-expect-error vite ?raw import
import m05 from '../migrations/0005_auth_config.sql?raw';
// @ts-expect-error vite ?raw import
import m06 from '../migrations/0006_ssl_cert_state.sql?raw';
// @ts-expect-error vite ?raw import
import m07 from '../migrations/0007_alert_rules_ssl_expiry.sql?raw';
// @ts-expect-error vite ?raw import
import m08 from '../migrations/0008_drop_metric_series_ssl_expiry.sql?raw';
// @ts-expect-error vite ?raw import
import m09 from '../migrations/0009_default_ssl_alert_rules.sql?raw';
// @ts-expect-error vite ?raw import
import m10 from '../migrations/0010_fix_ssl_crit_default_rules.sql?raw';
// @ts-expect-error vite ?raw import
import m11 from '../migrations/0011_latency_count.sql?raw';
// @ts-expect-error vite ?raw import
import m12 from '../migrations/0012_add_monitor_paused.sql?raw';
// @ts-expect-error vite ?raw import
import m13 from '../migrations/0013_alert_escalation.sql?raw';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function applyMigration(sql: string) {
	const stripped = sql
		.split('\n')
		.map((line) => {
			const i = line.indexOf('--');
			return i >= 0 ? line.slice(0, i) : line;
		})
		.join('\n');
	const statements = stripped
		.split(';')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	for (const stmt of statements) {
		await env.DB.prepare(stmt).run();
	}
}

beforeAll(async () => {
	for (const sql of [m01, m02, m03, m04, m05, m06, m07, m08, m09, m10, m11, m12, m13]) {
		await applyMigration(sql as string);
	}
	await env.DB.prepare(
		`INSERT INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, enabled)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
	)
		.bind('tcp-example', 'TCP Example', 'tcp', 'external', 'public', '1.1.1.1:53', 60)
		.run();
	await env.DB.prepare(
		`INSERT INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, enabled)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
	)
		.bind('dns-example', 'DNS Example', 'dns', 'external', 'public', 'example.com', 60)
		.run();
});

describe('GET /', () => {
	it('returns HTML status page', async () => {
		const response = await SELF.fetch('https://example.com/');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/html');
		const html = await response.text();
		expect(html).toContain('<!DOCTYPE html>');
		expect(html).toContain('HeartbeatFlare');
	});
});

describe('GET /api/status', () => {
	// These run before auth_config is seeded, so requests are unauthenticated (public view):
	// public monitors appear, but targets and the usage block are withheld (fail-closed).
	it('includes TCP monitors from D1 (target withheld for public)', async () => {
		const response = await SELF.fetch('https://example.com/api/status');
		const body = (await response.json()) as { monitors: Array<{ id: string; type: string; target: string | null }> };
		expect(body.monitors).toContainEqual(expect.objectContaining({ id: 'tcp-example', type: 'tcp', target: null }));
	});

	it('includes DNS monitors from D1 (target withheld for public)', async () => {
		const response = await SELF.fetch('https://example.com/api/status');
		const body = (await response.json()) as { monitors: Array<{ id: string; type: string; target: string | null }> };
		expect(body.monitors).toContainEqual(expect.objectContaining({ id: 'dns-example', type: 'dns', target: null }));
	});

	it('returns JSON monitors list without usage for public (unit style)', async () => {
		const request = new IncomingRequest('http://example.com/api/status');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		const body = (await response.json()) as { monitors: unknown[]; d1: unknown };
		expect(Array.isArray(body.monitors)).toBe(true);
		expect(body.d1).toBeUndefined();
	});

	it('returns JSON monitors list without usage for public (integration style)', async () => {
		const response = await SELF.fetch('https://example.com/api/status');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		const body = (await response.json()) as { monitors: unknown[]; d1: unknown };
		expect(Array.isArray(body.monitors)).toBe(true);
		expect(body.d1).toBeUndefined();
	});
});

describe('other routes', () => {
	it('GET /other returns 404', async () => {
		const response = await SELF.fetch('https://example.com/other');
		expect(response.status).toBe(404);
	});

	it('POST / returns 404', async () => {
		const response = await SELF.fetch('https://example.com/', { method: 'POST' });
		expect(response.status).toBe(404);
	});
});

describe('SSL cert fields', () => {
	it('/api/status includes ssl_not_after: null for monitors without cert data', async () => {
		const response = await SELF.fetch('https://example.com/api/status');
		const body = (await response.json()) as { monitors: Array<{ state: { ssl_not_after: unknown; ssl_issuer: unknown } }> };
		expect(body.monitors.every((m) => m.state.ssl_not_after === null)).toBe(true);
		expect(body.monitors.every((m) => m.state.ssl_issuer === null)).toBe(true);
	});
});

describe('incident independence', () => {
	it('opens a connectivity incident even when an SSL incident is already open', async () => {
		await env.DB.prepare(
			`INSERT OR IGNORE INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, enabled)
			 VALUES ('indep-test', 'Indep', 'http', 'external', 'public', 'https://indep.example.com', 60, 1)`,
		).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO monitor_state (monitor_id, status, consecutive_failures, consecutive_successes)
			 VALUES ('indep-test', 'down', 1, 0)`,
		).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO alert_rules (id, monitor_id, metric_name, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled)
			 VALUES ('indep-conn', 'indep-test', NULL, 'eq', 0, 'critical', 2, 2, 0, 1)`,
		).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO alert_rules (id, monitor_id, metric_name, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled)
			 VALUES ('indep-ssl', 'indep-test', 'ssl_expiry', 'lt', 7, 'warning', 1, 1, 0, 1)`,
		).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO incidents (id, monitor_id, alert_rule_id, status, severity, started_at, reason)
			 VALUES ('indep-ssl-inc', 'indep-test', 'indep-ssl', 'open', 'warning', '2026-01-01T00:00:00Z', 'SSL cert expires in 5 day(s)')`,
		).run();

		const monitor: MonitorRow = {
			id: 'indep-test',
			name: 'Indep',
			type: 'http',
			scrape_url: 'https://indep.example.com',
			interval_seconds: 60,
			ssl_check: 1,
			current_status: 'down',
			last_check_at: null,
			consecutive_failures: 1,
			consecutive_successes: 0,
			active_incident_id: null,
			ssl_not_after: null,
			ssl_issuer: null,
		};
		const rules: AlertRuleDbRow[] = [
			{ id: 'indep-conn', monitor_id: 'indep-test', metric_name: null, condition: 'eq', threshold: 0, severity: 'critical', failure_count: 2, recovery_count: 2, cooldown_seconds: 0, enabled: 1 },
		];
		// Only an SSL incident is active — the connectivity slot is empty
		const activeByClass = new Map([['ssl_expiry', { id: 'indep-ssl-inc', severity: 'warning' }]]);

		await evaluateAlerts(env, monitor, { status: 'down', latency_ms: 0, error: 'HTTP 500' }, 2, 0, '2026-06-11T00:00:00Z', rules, activeByClass);

		const conn = await env.DB.prepare(
			`SELECT id FROM incidents WHERE monitor_id = 'indep-test' AND status = 'open' AND alert_rule_id = 'indep-conn'`,
		).first<{ id: string }>();
		expect(conn).not.toBeNull();

		// The pre-existing SSL incident must remain open and untouched
		const ssl = await env.DB.prepare(`SELECT status FROM incidents WHERE id = 'indep-ssl-inc'`).first<{ status: string }>();
		expect(ssl?.status).toBe('open');
	});
});

describe('auth visibility filtering', () => {
	beforeAll(async () => {
		await env.DB.prepare(
			`INSERT OR IGNORE INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, enabled)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
		)
			.bind('private-test', 'Private Monitor', 'http', 'external', 'private', 'https://internal.example.com', 60)
			.run();

		await env.DB.prepare(
			`INSERT OR REPLACE INTO auth_config (id, provider, team_domain, aud, enabled)
			 VALUES ('default', 'cloudflare_access', 'test-team', 'test-aud-123', 1)`,
		).run();

		_invalidateAuthCache();
	});

	it('hides private monitors when no JWT header', async () => {
		const req = new IncomingRequest('http://example.com/api/status');
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		const body = (await res.json()) as { monitors: Array<{ id: string }> };
		expect(body.monitors.some((m) => m.id === 'private-test')).toBe(false);
	});

	it('hides target URLs when no JWT header', async () => {
		const req = new IncomingRequest('http://example.com/api/status');
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		const body = (await res.json()) as { monitors: Array<{ target: unknown }> };
		expect(body.monitors.every((m) => m.target === null)).toBe(true);
	});

	it('returns 302 for /auth/logout when auth configured', async () => {
		const req = new IncomingRequest('http://example.com/auth/logout');
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('http://example.com/public');
		expect(res.headers.get('Set-Cookie')).toContain('CF_Authorization=;');
	});
});
