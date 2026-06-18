// Channel resolution and delivery. Per-monitor channel assignments take precedence; channels
// marked is_default are the fallback. Channel configuration comes from D1 with ${VAR}
// placeholders — the real secret (webhook URL etc.) is resolved from the Worker env at send
// time, so credentials never land in config.yaml or D1.
import { log } from './log';
import type { NotificationChannelDbRow, NotificationMessage } from './types';

const EMAIL_DESTINATION_CACHE_MS = 5 * 60 * 1000;
const EMAIL_DESTINATION_PAGE_SIZE = 50;

let emailDestinationCache: { accountId: string; verified: Set<string>; expiresAt: number } | null = null;

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

function emailSubject(event: NotificationMessage, prefix: string): string {
	const base =
		event.eventType === 'down'
			? `${event.monitorName} is DOWN`
			: event.eventType === 'escalation'
				? `${event.monitorName} STILL DOWN`
				: `${event.monitorName} recovered`;
	return prefix ? `${prefix} ${base}` : `HeartBeat: ${base}`;
}

function emailRecipients(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.length > 0);
	if (typeof value === 'string' && value.length > 0) return [value];
	return [];
}

function sanitizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, ' ').slice(0, 300);
}

async function verifiedEmailDestinations(env: Env, nowMs: number = Date.now()): Promise<Set<string> | null> {
	const runtimeEnv = env as Env & {
		CLOUDFLARE_ACCOUNT_ID?: string;
		CLOUDFLARE_RUNTIME_API_TOKEN?: string;
		CLOUDFLARE_GRAPHQL_API_TOKEN?: string;
	};
	const accountId = runtimeEnv.CLOUDFLARE_ACCOUNT_ID;
	const token = runtimeEnv.CLOUDFLARE_RUNTIME_API_TOKEN ?? runtimeEnv.CLOUDFLARE_GRAPHQL_API_TOKEN;
	if (!accountId || !token) return null;
	if (emailDestinationCache?.accountId === accountId && emailDestinationCache.expiresAt > nowMs) {
		return emailDestinationCache.verified;
	}

	const verified = new Set<string>();
	for (let page = 1; ; page++) {
		const res = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${accountId}/email/routing/addresses?page=${page}&per_page=${EMAIL_DESTINATION_PAGE_SIZE}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		const data = (await res.json()) as {
			success?: boolean;
			errors?: { message?: string }[];
			result?: { email?: string; verified?: string | null; status?: string }[];
		};
		if (!res.ok || !data.success || !Array.isArray(data.result)) {
			const detail = data.errors?.map((e) => e.message).filter(Boolean).join(', ') || `HTTP ${res.status}`;
			throw new Error(`Email Routing address lookup failed: ${detail}`);
		}
		for (const address of data.result) {
			if (address.email && address.status === 'verified' && address.verified) verified.add(address.email.toLowerCase());
		}
		if (data.result.length < EMAIL_DESTINATION_PAGE_SIZE) break;
	}

	emailDestinationCache = { accountId, verified, expiresAt: nowMs + EMAIL_DESTINATION_CACHE_MS };
	return verified;
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
	let countsAsDelivered = false;
	try {
		if (channel.type === 'slack') {
			const url = resolve(cfg.url);
			if (!url) throw new Error('missing url in channel configuration');
			const res = await fetch(url, { method: 'POST', headers: buildHeaders(), body: JSON.stringify({ text }) });
			if (!res.ok) error = `HTTP ${res.status}`;
			else countsAsDelivered = true;
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
			else countsAsDelivered = true;
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
			} else {
				countsAsDelivered = true;
			}
		} else if (channel.type === 'email') {
			const email = (env as Env & { EMAIL?: SendEmail }).EMAIL;
			if (!email) throw new Error('missing EMAIL binding');
			const fromEmail = resolve(cfg.from);
			const to = emailRecipients(cfg.to)
				.map((recipient) => resolve(recipient))
				.filter((recipient) => recipient.length > 0);
			if (!fromEmail || to.length === 0) throw new Error('missing from or to in channel configuration');
			let verified: Set<string> | null;
			try {
				verified = await verifiedEmailDestinations(env);
			} catch (e) {
				const reason = sanitizeError(e);
				log('warn', 'notification.email_verification_lookup_failed', { channelId: channel.id, error: reason });
				error = reason;
				countsAsDelivered = true; // Skip this email without retrying the whole queue.
				verified = null;
			}
			if (verified === null) {
				if (!error) {
					error = 'missing CLOUDFLARE_RUNTIME_API_TOKEN or CLOUDFLARE_ACCOUNT_ID for email recipient verification';
					log('warn', 'notification.email_verification_unavailable', { channelId: channel.id });
					countsAsDelivered = true;
				}
			} else {
				const verifiedTo = to.filter((recipient) => verified.has(recipient.toLowerCase()));
				const skipped = to.filter((recipient) => !verified.has(recipient.toLowerCase()));
				if (skipped.length > 0) {
					log('warn', 'notification.email_recipient_unverified', { channelId: channel.id, recipients: skipped });
				}
				if (verifiedTo.length === 0) {
					error = `email recipient not verified: ${skipped.join(', ')}`;
					countsAsDelivered = true; // Nothing actionable until verification completes.
				} else {
					await email.send({
						from: { email: fromEmail, name: resolve(cfg.from_name) || 'HeartBeat' },
						to: verifiedTo,
						subject: emailSubject(event, resolve(cfg.subject_prefix)),
						text,
					});
					countsAsDelivered = true;
				}
			}
		} else {
			error = `${channel.type} notifications not yet implemented`;
		}
	} catch (e) {
		error = sanitizeError(e);
	}
	await env.DB.prepare(
		`INSERT INTO notification_deliveries (id, incident_id, channel_id, status, attempt_count, last_attempt_at, error)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).bind(crypto.randomUUID(), event.incidentId, channel.id, error ? 'failed' : 'sent', attemptCount, now, error).run();
	if (error) {
		// No url / headers / message body — only the channel id, type and error reason.
		log('warn', 'notification.delivery_failed', { incidentId: event.incidentId, channelId: channel.id, channelType: channel.type, attempt: attemptCount, error });
	}
	return countsAsDelivered;
}

export function _resetEmailDestinationCacheForTest(): void {
	emailDestinationCache = null;
}
