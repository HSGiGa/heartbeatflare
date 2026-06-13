// Channel resolution and delivery. Per-monitor channel assignments take precedence; channels
// marked is_default are the fallback. Channel configuration comes from D1 with ${VAR}
// placeholders — the real secret (webhook URL etc.) is resolved from the Worker env at send
// time, so credentials never land in config.yaml or D1.
import { log } from './log';
import type { NotificationChannelDbRow } from './types';

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

// Attempts delivery to a single channel, records the outcome, and reports whether it succeeded.
// `attemptCount` is the queue message's attempt number, so retried deliveries are tracked accurately.
export async function sendToChannel(
	env: Env,
	channel: NotificationChannelDbRow,
	incidentId: string,
	text: string,
	now: string,
	attemptCount: number,
): Promise<boolean> {
	const cfg = JSON.parse(channel.configuration) as Record<string, unknown>;
	const resolve = (v: unknown): string => (typeof v === 'string' ? resolveVars(env, v) : String(v ?? ''));

	let error: string | null = null;
	try {
		if (channel.type === 'slack' || channel.type === 'webhook') {
			const url = resolve(cfg.url);
			if (!url) throw new Error('missing url in channel configuration');
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (cfg.headers && typeof cfg.headers === 'object') {
				for (const [k, v] of Object.entries(cfg.headers as Record<string, string>)) headers[k] = resolve(v);
			}
			const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ text }) });
			if (!res.ok) error = `HTTP ${res.status}`;
		} else {
			error = `${channel.type} notifications not yet implemented`;
		}
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
	await env.DB.prepare(
		`INSERT INTO notification_deliveries (id, incident_id, channel_id, status, attempt_count, last_attempt_at, error)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).bind(crypto.randomUUID(), incidentId, channel.id, error ? 'failed' : 'sent', attemptCount, now, error).run();
	if (error) {
		// No url / headers / message body — only the channel id, type and error reason.
		log('warn', 'notification.delivery_failed', { incidentId, channelId: channel.id, channelType: channel.type, attempt: attemptCount, error });
	}
	return error === null;
}
