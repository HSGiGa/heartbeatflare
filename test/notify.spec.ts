import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMessage, sendToChannel } from '../src/notify';
import type { NotificationChannelDbRow, NotificationMessage } from '../src/types';
// @ts-expect-error vite ?raw import
import m01 from '../migrations/0001_initial_schema.sql?raw';

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

async function deliveryFor(channelId: string) {
	return env.DB.prepare(
		`SELECT status, error FROM notification_deliveries WHERE incident_id = ? AND channel_id = ? ORDER BY last_attempt_at DESC LIMIT 1`,
	)
		.bind('notify-incident', channelId)
		.first<{ status: string; error: string | null }>();
}

async function upsertTelegramChannel(id: string, configuration: Record<string, unknown>): Promise<NotificationChannelDbRow> {
	await env.DB.prepare(
		`INSERT OR REPLACE INTO notification_channels (id, name, type, configuration, is_default, enabled)
		 VALUES (?, ?, 'telegram', ?, 0, 1)`,
	)
		.bind(id, id, JSON.stringify(configuration))
		.run();
	const row = await env.DB.prepare(`SELECT id, name, type, configuration FROM notification_channels WHERE id = ?`)
		.bind(id)
		.first<NotificationChannelDbRow>();
	if (!row) throw new Error(`channel ${id} not found`);
	return row;
}

async function upsertWebhookChannel(id: string, configuration: Record<string, unknown>): Promise<NotificationChannelDbRow> {
	await env.DB.prepare(
		`INSERT OR REPLACE INTO notification_channels (id, name, type, configuration, is_default, enabled)
		 VALUES (?, ?, 'webhook', ?, 0, 1)`,
	)
		.bind(id, id, JSON.stringify(configuration))
		.run();
	const row = await env.DB.prepare(`SELECT id, name, type, configuration FROM notification_channels WHERE id = ?`)
		.bind(id)
		.first<NotificationChannelDbRow>();
	if (!row) throw new Error(`channel ${id} not found`);
	return row;
}

function event(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
	return {
		incidentId: 'notify-incident',
		monitorId: 'notify-monitor',
		monitorName: 'Notify Monitor',
		eventType: 'down',
		count: 1,
		...overrides,
	};
}

beforeAll(async () => {
	await applyMigration(m01 as string);
	await env.DB.prepare(
		`INSERT OR REPLACE INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, enabled)
		 VALUES ('notify-monitor', 'Notify Monitor', 'http', 'external', 'public', 'https://notify.example.com', 60, 1)`,
	).run();
	await env.DB.prepare(
		`INSERT OR REPLACE INTO incidents (id, monitor_id, alert_rule_id, status, severity, started_at, reason)
		 VALUES ('notify-incident', 'notify-monitor', NULL, 'open', 'critical', '2026-06-14T00:00:00Z', 'test')`,
	).run();
});

beforeEach(async () => {
	await env.DB.prepare(`DELETE FROM notification_deliveries WHERE incident_id = 'notify-incident'`).run();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('renderMessage', () => {
	it('renders default down, escalation and recovered messages', () => {
		expect(renderMessage(event({ monitorName: 'X', count: 3, error: 'boom' }))).toBe('🔴 **X is DOWN** — 3 consecutive failures: boom');
		expect(renderMessage(event({ monitorName: 'X', eventType: 'escalation', count: 61 }))).toBe('🔴 **X STILL DOWN** — open for 1h 1m, no recovery yet');
		expect(renderMessage(event({ monitorName: 'X', eventType: 'recovered', count: 2 }))).toBe('🟢 **X recovered** — back up after 2 successful checks');
	});

	it('renders custom templates and leaves unknown placeholders intact', () => {
		expect(renderMessage(event({ monitorName: 'X', count: 3, error: 'boom' }), { down: '{monitor} {status} {count} {error}' })).toBe('X DOWN 3 boom');
		expect(renderMessage(event({ monitorName: 'X' }), { down: '{monitor} {bogus}' })).toBe('X {bogus}');
		expect(renderMessage(event({ monitorName: 'X' }), { down: '{monitor} {error}' })).toBe('X ');
	});
});

describe('sendToChannel telegram', () => {
	it('sends a Telegram message and records a sent delivery', async () => {
		const channel = await upsertTelegramChannel('telegram-success', { bot_token: '${TEST_TG_TOKEN}', chat_id: '123' });
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

		const ok = await sendToChannel(env, channel, event(), '2026-06-14T00:00:01Z', 1);

		expect(ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe('https://api.telegram.org/bottelegram-secret-xyz/sendMessage');
		const body = JSON.parse(String((init as RequestInit).body)) as { chat_id: string; parse_mode: string; text: string; disable_web_page_preview: boolean };
		expect(body).toMatchObject({
			chat_id: '123',
			parse_mode: 'HTML',
			disable_web_page_preview: true,
		});
		expect(body.text).toContain('<b>Notify Monitor is DOWN</b>');
		expect(body.text).not.toContain('**');

		await expect(deliveryFor(channel.id)).resolves.toMatchObject({ status: 'sent', error: null });
	});

	it('escapes dynamic HTML before applying Telegram bold markup', async () => {
		const channel = await upsertTelegramChannel('telegram-escaping', { bot_token: '${TEST_TG_TOKEN}', chat_id: '123' });
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

		await sendToChannel(env, channel, event({ monitorName: 'X', error: 'failed <probe> & retry' }), '2026-06-14T00:00:02Z', 1);

		const [, init] = fetchSpy.mock.calls[0];
		const body = JSON.parse(String((init as RequestInit).body)) as { text: string };
		expect(body.text).toContain('<b>X is DOWN</b>');
		expect(body.text).toContain('&lt;probe&gt;');
		expect(body.text).toContain('&amp; retry');
	});

	it('records Telegram error descriptions without logging the bot token', async () => {
		const channel = await upsertTelegramChannel('telegram-error', { bot_token: '${TEST_TG_TOKEN}', chat_id: '123' });
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":false,"description":"chat not found"}', { status: 400 }));

		const ok = await sendToChannel(env, channel, event({ monitorName: 'X' }), '2026-06-14T00:00:03Z', 2);

		expect(ok).toBe(false);
		const delivery = await deliveryFor(channel.id);
		expect(delivery).toMatchObject({ status: 'failed' });
		expect(delivery?.error).toContain('HTTP 400: chat not found');
		expect(delivery?.error).not.toContain('telegram-secret-xyz');
		expect(delivery?.error).not.toContain('"ok":false');
	});

	it('records missing Telegram configuration without calling fetch', async () => {
		const channel = await upsertTelegramChannel('telegram-missing-config', { bot_token: '${MISSING_TG_TOKEN}', chat_id: '123' });
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unexpected fetch', { status: 500 }));

		const ok = await sendToChannel(env, channel, event({ monitorName: 'X' }), '2026-06-14T00:00:04Z', 1);

		expect(ok).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
		const delivery = await deliveryFor(channel.id);
		expect(delivery).toMatchObject({ status: 'failed', error: 'missing bot_token or chat_id in channel configuration' });
	});

	it('truncates formatted Telegram HTML to the sendMessage limit', async () => {
		const channel = await upsertTelegramChannel('telegram-long', { bot_token: '${TEST_TG_TOKEN}', chat_id: '123' });
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

		await sendToChannel(env, channel, event({ monitorName: 'X', error: '&'.repeat(5000) }), '2026-06-14T00:00:05Z', 1);

		const [, init] = fetchSpy.mock.calls[0];
		const body = JSON.parse(String((init as RequestInit).body)) as { text: string };
		expect(body.text.length).toBeLessThanOrEqual(4096);
		expect(body.text).toContain('<b>X is DOWN</b>');
		expect(body.text).toContain('...');
	});

	it('uses channel templates for Telegram messages', async () => {
		const channel = await upsertTelegramChannel('telegram-template', {
			bot_token: '${TEST_TG_TOKEN}',
			chat_id: '123',
			templates: { down: '{monitor} custom {count}: {error}' },
		});
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

		await sendToChannel(env, channel, event({ count: 2, error: 'timeout' }), '2026-06-14T00:00:06Z', 1);

		const [, init] = fetchSpy.mock.calls[0];
		const body = JSON.parse(String((init as RequestInit).body)) as { text: string };
		expect(body.text).toBe('Notify Monitor custom 2: timeout');
	});
});

describe('sendToChannel webhook', () => {
	it('sends a structured payload with resolved auth headers', async () => {
		const channel = await upsertWebhookChannel('webhook-success', {
			url: '${TEST_WEBHOOK_URL}',
			headers: { Authorization: 'Bearer ${TEST_WEBHOOK_TOKEN}' },
		});
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

		const ok = await sendToChannel(env, channel, event({ count: 3, error: 'boom' }), '2026-06-14T00:00:01Z', 1);

		expect(ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe('https://webhook.example.com/hook');
		expect((init as RequestInit).method).toBe('POST');
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer webhook-secret-abc');
		expect(headers['Content-Type']).toBe('application/json');
		const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
		expect(body).toMatchObject({
			monitor: { id: 'notify-monitor', name: 'Notify Monitor' },
			incidentId: 'notify-incident',
			status: 'error',
			eventType: 'down',
			count: 3,
			errorMessage: 'boom',
			timestamp: '2026-06-14T00:00:01Z',
			cronTimestamp: Date.parse('2026-06-14T00:00:01Z'),
		});
		expect(body.message).toContain('Notify Monitor is DOWN');
		expect(body).not.toHaveProperty('text');
		await expect(deliveryFor(channel.id)).resolves.toMatchObject({ status: 'sent', error: null });
	});

	it('maps recovered payloads and omits errorMessage when there is no error', async () => {
		const channel = await upsertWebhookChannel('webhook-recovered', { url: '${TEST_WEBHOOK_URL}' });
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

		await sendToChannel(env, channel, event({ eventType: 'recovered', count: 2, error: undefined }), '2026-06-14T00:00:02Z', 1);

		const [, init] = fetchSpy.mock.calls[0];
		const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
		expect(body.status).toBe('recovered');
		expect(body.eventType).toBe('recovered');
		expect(body).not.toHaveProperty('errorMessage');
	});

	it('maps escalation payloads to error status', async () => {
		const channel = await upsertWebhookChannel('webhook-escalation', { url: '${TEST_WEBHOOK_URL}' });
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

		await sendToChannel(env, channel, event({ eventType: 'escalation', count: 30 }), '2026-06-14T00:00:03Z', 1);

		const [, init] = fetchSpy.mock.calls[0];
		const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
		expect(body.status).toBe('error');
		expect(body.eventType).toBe('escalation');
	});

	it('records webhook HTTP failures', async () => {
		const channel = await upsertWebhookChannel('webhook-error', { url: '${TEST_WEBHOOK_URL}' });
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));

		const ok = await sendToChannel(env, channel, event(), '2026-06-14T00:00:04Z', 2);

		expect(ok).toBe(false);
		await expect(deliveryFor(channel.id)).resolves.toMatchObject({ status: 'failed', error: 'HTTP 500' });
	});

	it('records missing webhook URL without calling fetch', async () => {
		const channel = await upsertWebhookChannel('webhook-missing-url', { url: '${MISSING_VAR}' });
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unexpected', { status: 500 }));

		const ok = await sendToChannel(env, channel, event(), '2026-06-14T00:00:05Z', 1);

		expect(ok).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
		await expect(deliveryFor(channel.id)).resolves.toMatchObject({ status: 'failed', error: 'missing url in channel configuration' });
	});

	it('uses channel templates for webhook message', async () => {
		const channel = await upsertWebhookChannel('webhook-template', {
			url: '${TEST_WEBHOOK_URL}',
			templates: { down: '{monitor} custom {count}: {error}' },
		});
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

		await sendToChannel(env, channel, event({ count: 2, error: 'timeout' }), '2026-06-14T00:00:06Z', 1);

		const [, init] = fetchSpy.mock.calls[0];
		const body = JSON.parse(String((init as RequestInit).body)) as { message: string };
		expect(body.message).toBe('Notify Monitor custom 2: timeout');
	});
});
