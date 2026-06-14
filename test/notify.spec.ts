import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendToChannel } from '../src/notify';
import type { NotificationChannelDbRow } from '../src/types';
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

describe('sendToChannel telegram', () => {
	it('sends a Telegram message and records a sent delivery', async () => {
		const channel = await upsertTelegramChannel('telegram-success', { bot_token: '${TEST_TG_TOKEN}', chat_id: '123' });
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

		const ok = await sendToChannel(env, channel, 'notify-incident', '**Notify Monitor is DOWN** - failure', '2026-06-14T00:00:01Z', 1);

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

		await sendToChannel(env, channel, 'notify-incident', '**X is DOWN** - failed <probe> & retry', '2026-06-14T00:00:02Z', 1);

		const [, init] = fetchSpy.mock.calls[0];
		const body = JSON.parse(String((init as RequestInit).body)) as { text: string };
		expect(body.text).toContain('<b>X is DOWN</b>');
		expect(body.text).toContain('&lt;probe&gt;');
		expect(body.text).toContain('&amp; retry');
	});

	it('records Telegram error descriptions without logging the bot token', async () => {
		const channel = await upsertTelegramChannel('telegram-error', { bot_token: '${TEST_TG_TOKEN}', chat_id: '123' });
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":false,"description":"chat not found"}', { status: 400 }));

		const ok = await sendToChannel(env, channel, 'notify-incident', '**X is DOWN**', '2026-06-14T00:00:03Z', 2);

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

		const ok = await sendToChannel(env, channel, 'notify-incident', '**X is DOWN**', '2026-06-14T00:00:04Z', 1);

		expect(ok).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
		const delivery = await deliveryFor(channel.id);
		expect(delivery).toMatchObject({ status: 'failed', error: 'missing bot_token or chat_id in channel configuration' });
	});

	it('truncates formatted Telegram HTML to the sendMessage limit', async () => {
		const channel = await upsertTelegramChannel('telegram-long', { bot_token: '${TEST_TG_TOKEN}', chat_id: '123' });
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

		await sendToChannel(env, channel, 'notify-incident', `**X is DOWN** - ${'&'.repeat(5000)}`, '2026-06-14T00:00:05Z', 1);

		const [, init] = fetchSpy.mock.calls[0];
		const body = JSON.parse(String((init as RequestInit).body)) as { text: string };
		expect(body.text.length).toBeLessThanOrEqual(4096);
		expect(body.text).toContain('<b>X is DOWN</b>');
		expect(body.text).toContain('...');
	});
});
