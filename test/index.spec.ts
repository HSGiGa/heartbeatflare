import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import worker from '../src/index';
// @ts-expect-error vite ?raw import
import migrationSql from '../migrations/0001_initial_schema.sql?raw';

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

beforeAll(async () => {
	const statements = (migrationSql as string)
		.split(';')
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && !s.startsWith('--'));
	for (const stmt of statements) {
		await env.DB.prepare(stmt).run();
	}
	await env.DB.prepare(
		`INSERT INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, enabled)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
	)
		.bind('tcp-example', 'TCP Example', 'tcp', 'external', 'public', '1.1.1.1:53', 60)
		.run();
});

describe('GET /', () => {
	it('includes TCP monitors from D1', async () => {
		const response = await SELF.fetch('https://example.com/');
		const body = (await response.json()) as { monitors: Array<{ id: string; type: string; target: string }> };
		expect(body.monitors).toContainEqual(expect.objectContaining({ id: 'tcp-example', type: 'tcp', target: '1.1.1.1:53' }));
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
