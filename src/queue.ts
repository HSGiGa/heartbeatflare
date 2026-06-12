// Notification queue consumer. One message per incident open/resolve (produced by alerts.ts);
// delivers to the monitor's channels and records each attempt in notification_deliveries.
import { fetchNotificationChannels, sendToChannel } from './notify';
import type { NotificationMessage } from './types';

function asNotificationMessage(value: unknown): NotificationMessage | null {
	if (!value || typeof value !== 'object') return null;
	const msg = value as Partial<NotificationMessage>;
	if (
		typeof msg.incidentId !== 'string' ||
		typeof msg.monitorId !== 'string' ||
		typeof msg.monitorName !== 'string' ||
		(msg.eventType !== 'down' && msg.eventType !== 'recovered') ||
		typeof msg.count !== 'number'
	) {
		return null;
	}
	return {
		incidentId: msg.incidentId,
		monitorId: msg.monitorId,
		monitorName: msg.monitorName,
		eventType: msg.eventType,
		count: msg.count,
		error: typeof msg.error === 'string' ? msg.error : undefined,
	};
}

export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
	const now = new Date().toISOString();
	await Promise.allSettled(
		batch.messages.map(async (msg) => {
			const body = asNotificationMessage(msg.body);
			if (!body) {
				msg.ack();
				return;
			}

			const { incidentId, monitorId, monitorName, eventType, count, error } = body;
			const channels = await fetchNotificationChannels(env, monitorId);
			if (channels.length === 0) {
				msg.ack(); // nothing to deliver to — retrying would never succeed
				return;
			}
			const text =
				eventType === 'down'
					? `🔴 **${monitorName} is DOWN** — ${count} consecutive failure${count !== 1 ? 's' : ''}${error ? `: ${error}` : ''}`
					: `🟢 **${monitorName} recovered** — back up after ${count} successful check${count !== 1 ? 's' : ''}`;
			const outcomes = await Promise.allSettled(channels.map((ch) => sendToChannel(env, ch, incidentId, text, now, msg.attempts)));
			const anyDelivered = outcomes.some((o) => o.status === 'fulfilled' && o.value === true);
			// Retry only on total failure: re-delivering would double-notify already-successful channels.
			// The queue's max_retries bound (wrangler.jsonc) caps attempts before the message is dropped.
			if (anyDelivered) msg.ack();
			else msg.retry();
		}),
	);
}
