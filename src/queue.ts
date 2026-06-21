// Queue consumer. Check jobs execute one monitor probe per invocation; notification jobs deliver
// incident messages to channels and record each attempt in notification_deliveries.
import { log } from './log';
import { fetchNotificationChannels, sendToChannel } from './notify';
import { handleQueuedCheck } from './scheduler';
import type { CheckMessage, NotificationMessage } from './types';

// Exponential backoff for failed notification deliveries, tuned for transient downstream outages
// (Mattermost/Telegram 5xx/429/timeouts): fast first retries catch brief blips, capped growth avoids
// hammering a struggling provider. `attempts` is 1-based (Cloudflare's msg.attempts).
export function retryBackoffBase(attempts: number): number {
	return Math.min(10 * 2 ** (attempts - 1), 180); // 10, 20, 40, 80, 160, 180…
}

// Equal jitter over the base — keeps simultaneous incidents from retrying in lock-step against the
// same provider. Returns an integer in [base/2, base].
export function retryDelaySeconds(attempts: number): number {
	const base = retryBackoffBase(attempts);
	return Math.round(base / 2 + Math.random() * (base / 2));
}

function asNotificationMessage(value: unknown): NotificationMessage | null {
	if (!value || typeof value !== 'object') return null;
	const msg = value as Partial<NotificationMessage>;
	if (
		typeof msg.incidentId !== 'string' ||
		typeof msg.monitorId !== 'string' ||
		typeof msg.monitorName !== 'string' ||
		(msg.eventType !== 'down' && msg.eventType !== 'recovered' && msg.eventType !== 'escalation') ||
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

function asCheckMessage(value: unknown): CheckMessage | null {
	if (!value || typeof value !== 'object') return null;
	const msg = value as Partial<CheckMessage>;
	return msg.kind === 'check' && typeof msg.monitorId === 'string' ? { kind: 'check', monitorId: msg.monitorId } : null;
}

export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
	const now = new Date().toISOString();
	await Promise.allSettled(
		batch.messages.map(async (msg) => {
			const check = asCheckMessage(msg.body);
			if (check) {
				try {
					await handleQueuedCheck(env, check.monitorId);
					msg.ack();
				} catch (err) {
					const delaySeconds = retryDelaySeconds(msg.attempts);
					log('warn', 'check.retry', { monitorId: check.monitorId, attempt: msg.attempts, delaySeconds, error: err instanceof Error ? err.message : String(err) });
					msg.retry({ delaySeconds });
				}
				return;
			}
			const body = asNotificationMessage(msg.body);
			if (!body) {
				msg.ack();
				return;
			}

			const { incidentId, monitorId } = body;
			const channels = await fetchNotificationChannels(env, monitorId);
			if (channels.length === 0) {
				msg.ack(); // nothing to deliver to — retrying would never succeed
				return;
			}
			const outcomes = await Promise.allSettled(channels.map((ch) => sendToChannel(env, ch, body, now, msg.attempts)));
			const anyDelivered = outcomes.some((o) => o.status === 'fulfilled' && o.value === true);
			// Retry only on total failure: re-delivering would double-notify already-successful channels.
			// The queue's max_retries bound (wrangler.jsonc) caps attempts before the message is dropped.
			if (anyDelivered) msg.ack();
			else {
				const delaySeconds = retryDelaySeconds(msg.attempts);
				log('warn', 'notification.retry', { incidentId, attempt: msg.attempts, delaySeconds });
				msg.retry({ delaySeconds });
			}
		}),
	);
}
