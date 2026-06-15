// Channel resolution and delivery. Per-monitor channel assignments take precedence; channels
// marked is_default are the fallback. Channel configuration comes from D1 with ${VAR}
// placeholders — the real secret (webhook URL etc.) is resolved from the Worker env at send
// time, so credentials never land in config.yaml or D1.
import { log } from './log';
import type { NotificationChannelDbRow, NotificationMessage } from './types';

export async function fetchNotificationChannels(env: Env, monitorId: string): Promise<NotificationChannelDbRow[]> {
	const { results: perMonitor } = await env.DB.prepare(
		`SELECT nc.id, nc.name, nc.type, nc.configuration
		 FROM notification_channels nc
		 JOIN monitor_notification_channels mnc ON mnc.channel_id = nc.id
		 WHERE mnc.monitor_id = ? AND mnc.enabled = 1 AND nc.enabled = 1`,
	).bind(monitorId).all<NotificationChannelDbRow>();
	if (perMonitor.length > 0) return perMonitor;
	const { results: defaults } = await env.DB.prepare(
		`SELECT id, name, type, configuration FROM notification_channels WHERE is_default = 1 AND enabled = 1`,
	).all<NotificationChannelDbRow>();
	return defaults;
}

function resolveVars(env: Env, value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (_, key) => (env as unknown as Record<string, string | undefined>)[key] ?? '');
}

const TELEGRAM_TEXT_LIMIT = 4096;

function escapeAndBold(text: string): string {
	const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return escaped.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

function toTelegramHtml(text: string): string {
	const full = escapeAndBold(text);
	if (full.length <= TELEGRAM_TEXT_LIMIT) return full;

	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (escapeAndBold(`${text.slice(0, mid)}...`).length <= TELEGRAM_TEXT_LIMIT) lo = mid;
		else hi = mid - 1;
	}
	return escapeAndBold(`${text.slice(0, lo)}...`);
}

function statusLabel(eventType: NotificationMessage['eventType']): string {
	if (eventType === 'down') return 'DOWN';
	if (eventType === 'escalation') return 'STILL DOWN';
	return 'recovered';
}

function fillTemplate(template: string, event: NotificationMessage): string {
	return template
		.replace(/\{monitor\}/g, event.monitorName)
		.replace(/\{count\}/g, String(event.count))
		.replace(/\{error\}/g, event.error ?? '')
		.replace(/\{status\}/g, statusLabel(event.eventType));
}

export function renderMessage(event: NotificationMessage, templates?: Record<string, unknown>): string {
	const custom = templates?.[event.eventType];
	if (typeof custom === 'string' && custom.length > 0) return fillTemplate(custom, event);

	const { monitorName, count, error, eventType } = event;
	if (eventType === 'down') {
		return `🔴 **${monitorName} is DOWN** — ${count} consecutive failure${count !== 1 ? 's' : ''}${error ? `: ${error}` : ''}`;
	}
	if (eventType === 'escalation') {
		return `🔴 **${monitorName} STILL DOWN** — open for ${count >= 60 ? `${Math.floor(count / 60)}h ${count % 60}m` : `${count}m`}, no recovery yet`;
	}
	return `🟢 **${monitorName} recovered** — back up after ${count} successful check${count !== 1 ? 's' : ''}`;
}

// Attempts delivery to a single channel, records the outcome, and reports whether it succeeded.
// `attemptCount` is the queue message's attempt number, so retried deliveries are tracked accurately.
export async function sendToChannel(
	env: Env,
	channel: NotificationChannelDbRow,
	event: NotificationMessage,
	now: string,
	attemptCount: number,
): Promise<boolean> {
	const cfg = JSON.parse(channel.configuration) as Record<string, unknown>;
	const resolve = (v: unknown): string => (typeof v === 'string' ? resolveVars(env, v) : String(v ?? ''));
	const buildHeaders = (): Record<string, string> => {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (cfg.headers && typeof cfg.headers === 'object') {
			for (const [k, v] of Object.entries(cfg.headers as Record<string, string>)) headers[k] = resolve(v);
		}
		return headers;
	};
	const templates = cfg.templates && typeof cfg.templates === 'object' ? (cfg.templates as Record<string, unknown>) : undefined;
	const text = renderMessage(event, templates);

	let error: string | null = null;
	try {
		if (channel.type === 'slack') {
			const url = resolve(cfg.url);
			if (!url) throw new Error('missing url in channel configuration');
			const res = await fetch(url, { method: 'POST', headers: buildHeaders(), body: JSON.stringify({ text }) });
			if (!res.ok) error = `HTTP ${res.status}`;
		} else if (channel.type === 'webhook') {
			const url = resolve(cfg.url);
			if (!url) throw new Error('missing url in channel configuration');
			const body = JSON.stringify({
				monitor: { id: event.monitorId, name: event.monitorName },
				incidentId: event.incidentId,
				status: event.eventType === 'recovered' ? 'recovered' : 'error',
				eventType: event.eventType,
				count: event.count,
				...(event.error ? { errorMessage: event.error } : {}),
				message: text,
				cronTimestamp: Date.parse(now),
				timestamp: now,
			});
			const res = await fetch(url, { method: 'POST', headers: buildHeaders(), body });
			if (!res.ok) error = `HTTP ${res.status}`;
		} else if (channel.type === 'telegram') {
			const botToken = resolve(cfg.bot_token);
			const chatId = resolve(cfg.chat_id);
			if (!botToken || !chatId) throw new Error('missing bot_token or chat_id in channel configuration');
			const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: chatId,
					text: toTelegramHtml(text),
					parse_mode: 'HTML',
					disable_web_page_preview: true,
				}),
			});
			if (!res.ok) {
				let detail = '';
				try {
					const body = (await res.json()) as { description?: string };
					if (typeof body?.description === 'string') detail = `: ${body.description.slice(0, 200)}`;
				} catch {
					// Non-JSON Telegram responses are not logged to avoid persisting unexpected bodies.
				}
				error = `HTTP ${res.status}${detail}`;
			}
		} else {
			error = `${channel.type} notifications not yet implemented`;
		}
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
	await env.DB.prepare(
		`INSERT INTO notification_deliveries (id, incident_id, channel_id, status, attempt_count, last_attempt_at, error)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).bind(crypto.randomUUID(), event.incidentId, channel.id, error ? 'failed' : 'sent', attemptCount, now, error).run();
	if (error) {
		// No url / headers / message body — only the channel id, type and error reason.
		log('warn', 'notification.delivery_failed', { incidentId: event.incidentId, channelId: channel.id, channelType: channel.type, attempt: attemptCount, error });
	}
	return error === null;
}
