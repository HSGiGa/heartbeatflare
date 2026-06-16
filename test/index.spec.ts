import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import worker from '../src/index';
import { _invalidateAuthCache, resolveAuthConfig } from '../src/auth';
import { CONNECTIVITY_CLASS, evaluateAlerts } from '../src/alerts';
import { handleScheduled } from '../src/scheduler';
import type { AlertRuleDbRow, MonitorRow } from '../src/types';
// Apply the single consolidated baseline so the test schema matches production. If the schema is
// ever split into further migrations, import and apply each one here in order.
// @ts-expect-error vite ?raw import
import m01 from '../migrations/0001_initial_schema.sql?raw';

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
	for (const sql of [m01]) {
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

describe('soft-deleted monitor incidents are hidden', () => {
	// A monitor removed from config.yaml is soft-deleted (enabled = 0). Its incidents must not
	// surface on any public read path, even if they are still 'open' in the DB (a disabled monitor
	// is never probed again, so the incident can't auto-resolve). Regression for issue #6.
	beforeAll(async () => {
		// Control: an enabled public monitor with an open incident — must still appear.
		await env.DB.prepare(
			`INSERT OR IGNORE INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, enabled)
			 VALUES ('control-enabled', 'Control Live', 'http', 'external', 'public', 'https://control.example.com', 60, 1)`,
		).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO incidents (id, monitor_id, alert_rule_id, status, severity, started_at, reason)
			 VALUES ('control-inc', 'control-enabled', NULL, 'open', 'critical', '2026-12-31T00:00:01Z', 'down')`,
		).run();
		// The soft-deleted monitor (enabled = 0), public, with a lingering open incident.
		await env.DB.prepare(
			`INSERT OR IGNORE INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, enabled)
			 VALUES ('ghost-disabled', 'Ghost Disabled', 'http', 'external', 'public', 'https://ghost.example.com', 60, 0)`,
		).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO incidents (id, monitor_id, alert_rule_id, status, severity, started_at, reason)
			 VALUES ('ghost-inc', 'ghost-disabled', NULL, 'open', 'critical', '2026-12-31T00:00:00Z', 'down')`,
		).run();
	});

	it('excludes them from GET /api/history', async () => {
		// Unique query so this fetch gets its own edge-cache entry (the public feed/api responses
		// are edge-cached by URL; a shared key would let an earlier test's render leak in).
		const response = await SELF.fetch('https://example.com/api/history?t=softdelete');
		expect(response.status).toBe(200);
		const body = (await response.json()) as { incidents: Array<{ id: string; monitor_id: string }> };
		const ids = body.incidents.map((i) => i.id);
		// Both incidents have the most recent started_at, so the control lands on page 1 if shown.
		expect(ids).toContain('control-inc');
		expect(ids).not.toContain('ghost-inc');
		expect(body.incidents.some((i) => i.monitor_id === 'ghost-disabled')).toBe(false);
	});

	it('excludes them from GET /feed.xml', async () => {
		// Unique query (cache-bust) so this earlier feed fetch doesn't populate the shared
		// /feed.xml edge-cache entry that a later test asserts against.
		const response = await SELF.fetch('https://example.com/feed.xml?t=softdelete');
		expect(response.status).toBe(200);
		const xml = await response.text();
		expect(xml).toContain('Control Live');
		expect(xml).not.toContain('Ghost Disabled');
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
			`INSERT OR REPLACE INTO auth_config (id, provider, team_name, aud, enabled)
			 VALUES ('default', 'cloudflare_access', 'test-team', 'test-aud-123', 1)`,
		).run();

		_invalidateAuthCache();
	});

	it('resolves auth team_name and aud env refs', async () => {
		await env.DB.prepare(
			`INSERT OR REPLACE INTO auth_config (id, provider, team_name, aud, enabled)
			 VALUES ('default', 'cloudflare_access', ?, ?, 1)`,
		)
			.bind('${CLOUDFLARE_ACCESS_TEAM_NAME}', '${CLOUDFLARE_ACCESS_AUD}')
			.run();
		_invalidateAuthCache();

		const cfg = await resolveAuthConfig({
			...env,
			CLOUDFLARE_ACCESS_TEAM_NAME: 'test-team-env',
			CLOUDFLARE_ACCESS_AUD: 'test-aud-env',
		} as Env);

		expect(cfg).toMatchObject({
			provider: 'cloudflare_access',
			team_name: 'test-team-env',
			aud: 'test-aud-env',
		});

		await env.DB.prepare(
			`INSERT OR REPLACE INTO auth_config (id, provider, team_name, aud, enabled)
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

	it('returns no-store for /auth/login redirect', async () => {
		const req = new IncomingRequest('http://example.com/auth/login');
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('http://example.com/private');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('returns 302 for /auth/logout when auth configured', async () => {
		const req = new IncomingRequest('http://example.com/auth/logout');
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('http://example.com/public');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(res.headers.get('Set-Cookie')).toContain('CF_Authorization=;');
	});

	it('returns no-store for root auth redirect', async () => {
		const req = new IncomingRequest('http://example.com/');
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('http://example.com/public');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('returns no-store for /private even without a valid session', async () => {
		const req = new IncomingRequest('http://example.com/private');
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/html');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('keeps /public cacheable', async () => {
		const req = new IncomingRequest('http://example.com/public?t=auth-cache-control');
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
	});
});

describe('maintenance windows, feed and badges', () => {
	beforeAll(async () => {
		await env.DB.prepare(
			`INSERT OR IGNORE INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, enabled)
			 VALUES ('badge-pub', 'Badge Public', 'http', 'external', 'public', 'https://pub.example.com', 60, 1)`,
		).run();
		await env.DB.prepare(`INSERT OR IGNORE INTO monitor_state (monitor_id, status) VALUES ('badge-pub', 'up')`).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, enabled)
			 VALUES ('badge-priv', 'Badge Private', 'http', 'external', 'private', 'https://priv.example.com', 60, 1)`,
		).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, enabled, paused)
			 VALUES ('badge-paused', 'Badge Paused', 'http', 'external', 'public', 'https://paused.example.com', 60, 1, 1)`,
		).run();
		await env.DB.prepare(`INSERT OR IGNORE INTO monitor_state (monitor_id, status) VALUES ('badge-paused', 'up')`).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, enabled)
			 VALUES ('badge-disabled', 'Badge Disabled', 'http', 'external', 'public', 'https://disabled.example.com', 60, 0)`,
		).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, enabled)
			 VALUES ('badge-special', 'A & "B" <test>', 'http', 'external', 'public', 'https://special.example.com', 60, 1)`,
		).run();
		await env.DB.prepare(`INSERT OR IGNORE INTO monitor_state (monitor_id, status) VALUES ('badge-special', 'up')`).run();
		// Alert rules referenced by the incidents below (incidents.alert_rule_id is a NOT NULL FK).
		await env.DB.prepare(
			`INSERT OR IGNORE INTO alert_rules (id, monitor_id, metric_name, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled)
			 VALUES ('badge-pub-rule', 'badge-pub', NULL, 'eq', 0, 'critical', 1, 1, 0, 1)`,
		).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO alert_rules (id, monitor_id, metric_name, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled)
			 VALUES ('badge-priv-rule', 'badge-priv', NULL, 'eq', 0, 'critical', 1, 1, 0, 1)`,
		).run();
		// A public incident (for the feed) and a private incident (must be excluded from the feed).
		await env.DB.prepare(
			`INSERT OR IGNORE INTO incidents (id, monitor_id, alert_rule_id, status, severity, started_at, reason)
			 VALUES ('feed-pub-inc', 'badge-pub', 'badge-pub-rule', 'open', 'critical', '2026-06-12T00:00:00Z', 'pub boom')`,
		).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO incidents (id, monitor_id, alert_rule_id, status, severity, started_at, reason)
			 VALUES ('feed-priv-inc', 'badge-priv', 'badge-priv-rule', 'open', 'critical', '2026-06-12T00:00:00Z', 'priv secret boom')`,
		).run();
		// An active maintenance window (started in the past, ends far in the future) on the public monitor.
		await env.DB.prepare(
			`INSERT OR IGNORE INTO maintenance_windows (id, title, body, starts_at, ends_at, enabled)
			 VALUES ('db-migration', 'DB migration window', 'upgrading postgres', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z', 1)`,
		).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO maintenance_window_monitors (window_id, monitor_id) VALUES ('db-migration', 'badge-pub')`,
		).run();
	});

	it('serves an SVG badge for a public monitor', async () => {
		const res = await SELF.fetch('https://example.com/badge/badge-pub.svg');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('image/svg+xml');
		const svg = await res.text();
		expect(svg).toContain('<svg');
		expect(svg).toContain('Operational');
	});

	it('returns 404 for a private monitor badge (no leak)', async () => {
		const res = await SELF.fetch('https://example.com/badge/badge-priv.svg');
		expect(res.status).toBe(404);
	});

	it('returns 404 for an unknown monitor badge', async () => {
		const res = await SELF.fetch('https://example.com/badge/does-not-exist.svg');
		expect(res.status).toBe(404);
	});

	it('serves a public badges page with snippets for public monitors', async () => {
		const res = await SELF.fetch(`https://status.example.test/badges?t=${Date.now()}-list`);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/html');
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
		const html = await res.text();
		expect(html).toContain('Status badges');
		expect(html).toContain('Badge Public');
		expect(html).toContain('Badge Paused');
		expect(html).toContain('paused');
		expect(html).toContain('src="/badge/badge-pub.svg"');
		expect(html).toContain('https://status.example.test/badge/badge-pub.svg');
		expect(html).toContain('![Badge Public status](https://status.example.test/badge/badge-pub.svg)');
		expect(html).toContain('&lt;img src=&quot;https://status.example.test/badge/badge-pub.svg&quot; alt=&quot;Badge Public status&quot;&gt;');
		expect(html).not.toContain('Badge Private');
		expect(html).not.toContain('Badge Disabled');
	});

	it('escapes special-character monitor names on the badges page', async () => {
		const res = await SELF.fetch(`https://status.example.test/badges?t=${Date.now()}-escape`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('A &amp; &quot;B&quot; &lt;test&gt;');
		expect(html).toContain('/badge/badge-special.svg');
		expect(html).toContain('label=A%20%26%20%22B%22%20%3Ctest%3E');
		expect(html).toContain('![A &amp; &quot;B&quot; &lt;test&gt; status](https://status.example.test/badge/badge-special.svg)');
		expect(html).toContain('alt=&quot;A &amp;amp; &amp;quot;B&amp;quot; &amp;lt;test&amp;gt; status&quot;');
		expect(html).not.toContain('<test>');
	});

	it('shows an empty state when there are no public badges', async () => {
		const { results: publicMonitors } = await env.DB.prepare(`SELECT id FROM monitors WHERE enabled = 1 AND visibility = 'public'`).all<{ id: string }>();
		try {
			for (const m of publicMonitors) {
				await env.DB.prepare(`UPDATE monitors SET enabled = 0 WHERE id = ?`).bind(m.id).run();
			}
			const res = await SELF.fetch(`https://example.com/badges?t=${Date.now()}-empty`);
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain('No public badges yet');
			expect(html).not.toContain('<article class="badge-row">');
		} finally {
			for (const m of publicMonitors) {
				await env.DB.prepare(`UPDATE monitors SET enabled = 1 WHERE id = ?`).bind(m.id).run();
			}
		}
	});

	it('serves an Atom feed with public incidents but not private ones', async () => {
		const res = await SELF.fetch('https://example.com/feed.xml');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('application/atom+xml');
		const xml = await res.text();
		expect(xml).toContain('<feed');
		expect(xml).toContain('Badge Public');
		expect(xml).toContain('Maintenance: DB migration window');
		expect(xml).not.toContain('priv secret boom');
		expect(xml).not.toContain('Badge Private');
	});

	it('shows a maintenance banner on the public status page', async () => {
		// Cache-busting query so we never hit an earlier cached /public render without the window.
		const res = await SELF.fetch(`https://example.com/public?t=${Date.now()}`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('DB migration window');
		expect(html).toContain('🔧');
	});

	it('renders active incidents in a card outside the header', async () => {
		const res = await SELF.fetch(`https://example.com/public?t=${Date.now()}-incidents`);
		expect(res.status).toBe(200);
		const html = await res.text();
		const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
		const footer = html.slice(html.indexOf('<footer>'), html.indexOf('</footer>'));
		const activeIncidents = html.slice(html.indexOf('<section class="incident-card"'), html.indexOf('<section class="section">'));
		expect(html).toContain('Active Incidents');
		expect(html).toContain('pub boom');
		expect(html).not.toContain('id="range-picker"');
		expect(html).not.toContain('data-days=');
		expect(html.indexOf('Active Incidents')).toBeGreaterThan(html.indexOf('</header>'));
		expect(header).not.toContain('Updated ');
		expect(header).not.toContain('pub boom');
		expect(footer).toContain('Updated ');
		expect(activeIncidents).toContain('incident-line sev-critical');
		expect(activeIncidents).not.toContain('Partial Outage');
	});
});

describe('heartbeat (push) monitoring', () => {
	const TOKEN = 'beat-secret-xyz'; // matches the TEST_BEAT_TOKEN binding in vitest.config.mts

	// Distinct IPs per test isolate the per-IP rate limiter; distinct monitor ids isolate the
	// per-monitor limiter — so no test trips another's bucket.
	const beat = (id: string, token: string, ip: string, method = 'POST') =>
		SELF.fetch(`https://example.com/beat/${id}/${token}`, { method, headers: { 'CF-Connecting-IP': ip } });

	const mkHeartbeat = (id: string, name: string, intervalSeconds: number) =>
		env.DB.prepare(
			`INSERT OR IGNORE INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, ssl_check, heartbeat_token, enabled)
			 VALUES (?, ?, 'heartbeat', 'external', 'private', NULL, ?, 0, 'secret:TEST_BEAT_TOKEN', 1)`,
		)
			.bind(id, name, intervalSeconds)
			.run();

	beforeAll(async () => {
		await mkHeartbeat('hb-valid', 'HB Valid', 600);
		await mkHeartbeat('hb-throttle', 'HB Throttle', 600);
		await mkHeartbeat('hb-rate', 'HB Rate', 600);
		await mkHeartbeat('hb-recover', 'HB Recover', 600);
	});

	it('valid beat returns 204 and records up', async () => {
		const res = await beat('hb-valid', TOKEN, '203.0.113.10');
		expect(res.status).toBe(204);
		const st = await env.DB.prepare(`SELECT status FROM monitor_state WHERE monitor_id = 'hb-valid'`).first<{ status: string }>();
		expect(st?.status).toBe('up');
	});

	it('bad token returns 404', async () => {
		const res = await beat('hb-valid', 'wrong-token', '203.0.113.11');
		expect(res.status).toBe(404);
	});

	it('unknown monitor returns 404', async () => {
		const res = await beat('hb-nope', TOKEN, '203.0.113.12');
		expect(res.status).toBe(404);
	});

	it('non-POST returns 405 with Allow: POST', async () => {
		const res = await beat('hb-valid', TOKEN, '203.0.113.13', 'GET');
		expect(res.status).toBe(405);
		expect(res.headers.get('Allow')).toBe('POST');
	});

	it('spam within the throttle window returns 204 without an extra sample', async () => {
		const count = async () =>
			(await env.DB.prepare(`SELECT COUNT(*) AS n FROM metric_series WHERE monitor_id = 'hb-throttle'`).first<{ n: number }>())!.n;
		const first = await beat('hb-throttle', TOKEN, '203.0.113.20');
		expect(first.status).toBe(204);
		const afterFirst = await count();
		const second = await beat('hb-throttle', TOKEN, '203.0.113.20');
		expect(second.status).toBe(204);
		expect(await count()).toBe(afterFirst); // throttled: no new metric_series row
	});

	it('rate-limited beat returns 429', async () => {
		let got429 = false;
		for (let i = 0; i < 25; i++) {
			const res = await beat('hb-rate', TOKEN, '203.0.113.30');
			if (res.status === 429) {
				got429 = true;
				break;
			}
		}
		expect(got429).toBe(true); // per-monitor limiter is 20/60s
	});

	it('a beat after a down incident resolves it (recovery)', async () => {
		await env.DB.prepare(
			`INSERT OR REPLACE INTO monitor_state (monitor_id, status, last_check_at, consecutive_failures, consecutive_successes, active_incident_id)
			 VALUES ('hb-recover', 'down', '2026-01-01T00:00:00Z', 2, 0, 'hb-rec-inc')`,
		).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO alert_rules (id, monitor_id, metric_name, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled)
			 VALUES ('hb-rec-rule', 'hb-recover', NULL, 'eq', 0, 'critical', 1, 1, 0, 1)`,
		).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO incidents (id, monitor_id, alert_rule_id, status, severity, started_at, reason)
			 VALUES ('hb-rec-inc', 'hb-recover', 'hb-rec-rule', 'open', 'critical', '2026-01-01T00:00:00Z', 'Heartbeat missed')`,
		).run();

		const res = await beat('hb-recover', TOKEN, '203.0.113.40');
		expect(res.status).toBe(204);
		const inc = await env.DB.prepare(`SELECT status FROM incidents WHERE id = 'hb-rec-inc'`).first<{ status: string }>();
		expect(inc?.status).toBe('resolved');
		const st = await env.DB
			.prepare(`SELECT status, active_incident_id FROM monitor_state WHERE monitor_id = 'hb-recover'`)
			.first<{ status: string; active_incident_id: string | null }>();
		expect(st?.status).toBe('up');
		expect(st?.active_incident_id).toBeNull();
	});

	describe('scheduler missed-heartbeat', () => {
		// Pause probe-based monitors so handleScheduled does no outbound network during these tests.
		beforeAll(async () => {
			await env.DB.prepare(`UPDATE monitors SET paused = 1 WHERE type != 'heartbeat'`).run();
		});
		afterAll(async () => {
			await env.DB.prepare(`UPDATE monitors SET paused = 0 WHERE type != 'heartbeat'`).run();
		});

		it('marks an overdue heartbeat as down', async () => {
			await mkHeartbeat('hb-overdue', 'HB Overdue', 60);
			await env.DB.prepare(
				`INSERT OR REPLACE INTO monitor_state (monitor_id, status, last_check_at, consecutive_failures, consecutive_successes)
				 VALUES ('hb-overdue', 'up', datetime('now', '-5 minutes'), 0, 1)`,
			).run();

			await handleScheduled(env);

			const st = await env.DB
				.prepare(`SELECT status, consecutive_failures FROM monitor_state WHERE monitor_id = 'hb-overdue'`)
				.first<{ status: string; consecutive_failures: number }>();
			expect(st?.status).toBe('down');
			expect(st?.consecutive_failures).toBeGreaterThanOrEqual(1);
		});

		it('opens an incident after failure_count missed intervals', async () => {
			await mkHeartbeat('hb-incident', 'HB Incident', 60);
			await env.DB.prepare(
				`INSERT OR IGNORE INTO alert_rules (id, monitor_id, metric_name, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled)
				 VALUES ('hb-inc-rule', 'hb-incident', NULL, 'eq', 0, 'critical', 3, 1, 0, 1)`,
			).run();
			await env.DB.prepare(
				`INSERT OR REPLACE INTO monitor_state (monitor_id, status, last_check_at, consecutive_failures, consecutive_successes)
				 VALUES ('hb-incident', 'up', datetime('now', '-5 minutes'), 0, 1)`,
			).run();

			await handleScheduled(env);

			const inc = await env.DB
				.prepare(`SELECT severity FROM incidents WHERE monitor_id = 'hb-incident' AND status = 'open'`)
				.first<{ severity: string }>();
			expect(inc).not.toBeNull();
			expect(inc?.severity).toBe('critical');
		});
	});
});
