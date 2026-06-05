import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
// @ts-expect-error vite ?raw import
import migrationSql from '../migrations/0001_initial_schema.sql?raw';
// @ts-expect-error vite ?raw import
import migration2Sql from '../migrations/0002_remove_ping_type.sql?raw';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function expectUsageFields(body: { usage: unknown; usagePercent: unknown }) {
	expect(body.usage).toEqual({
		readQueries: expect.any(Number),
		writeQueries: expect.any(Number),
		rowsRead: expect.any(Number),
		rowsWritten: expect.any(Number),
		databaseSizeBytes: expect.any(Number),
	});
	expect(body.usagePercent).toEqual({
		rowsRead: expect.any(Number),
		rowsWritten: expect.any(Number),
		storage: expect.any(Number),
	});
}

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
	await applyMigration(migrationSql as string);
	await applyMigration(migration2Sql as string);
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
	await env.DB.prepare(
		`INSERT INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, enabled)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
	)
		.bind('hb-example', 'Heartbeat Example', 'heartbeat', 'external', 'public', null, 60)
		.run();
});

describe('GET /', () => {
	it('includes TCP monitors from D1', async () => {
		const response = await SELF.fetch('https://example.com/');
		const body = (await response.json()) as { monitors: Array<{ id: string; type: string; target: string }> };
		expect(body.monitors).toContainEqual(expect.objectContaining({ id: 'tcp-example', type: 'tcp', target: '1.1.1.1:53' }));
	});

	it('includes DNS monitors from D1', async () => {
		const response = await SELF.fetch('https://example.com/');
		const body = (await response.json()) as { monitors: Array<{ id: string; type: string; target: string }> };
		expect(body.monitors).toContainEqual(expect.objectContaining({ id: 'dns-example', type: 'dns', target: 'example.com' }));
	});

	it('includes heartbeat monitors from D1', async () => {
		const response = await SELF.fetch('https://example.com/');
		const body = (await response.json()) as { monitors: Array<{ id: string; type: string }> };
		expect(body.monitors).toContainEqual(expect.objectContaining({ id: 'hb-example', type: 'heartbeat' }));
	});

	it('returns JSON monitors list (unit style)', async () => {
		const request = new IncomingRequest('http://example.com/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		const body = (await response.json()) as { monitors: unknown[]; usage: unknown; usagePercent: unknown };
		expect(Array.isArray(body.monitors)).toBe(true);
		expectUsageFields(body);
	});

	it('returns JSON monitors list (integration style)', async () => {
		const response = await SELF.fetch('https://example.com/');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		const body = (await response.json()) as { monitors: unknown[]; usage: unknown; usagePercent: unknown };
		expect(Array.isArray(body.monitors)).toBe(true);
		expectUsageFields(body);
	});
});

describe('POST /beat/:id', () => {
	it('records beat and marks monitor up', async () => {
		const res = await SELF.fetch('https://example.com/beat/hb-example', { method: 'POST' });
		expect(res.status).toBe(200);
		const state = await env.DB.prepare(`SELECT status FROM monitor_state WHERE monitor_id = ?`)
			.bind('hb-example')
			.first<{ status: string }>();
		expect(state?.status).toBe('up');
	});

	it('returns 404 for unknown monitor id', async () => {
		const res = await SELF.fetch('https://example.com/beat/nonexistent', { method: 'POST' });
		expect(res.status).toBe(404);
	});

	it('returns 404 for non-heartbeat monitor', async () => {
		const res = await SELF.fetch('https://example.com/beat/tcp-example', { method: 'POST' });
		expect(res.status).toBe(404);
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
