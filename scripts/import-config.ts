import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { loadConfig, requireEnv } from './lib/deploy-config';

const API_BASE = 'https://api.cloudflare.com/client/v4';

const token = requireEnv('CLOUDFLARE_API_TOKEN');
const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');

// provision is the single writer of this field and runs earlier in every pipeline
const DB_ID = loadConfig().deploy?.database_id;
if (!DB_ID || !/^[0-9a-f-]{36}$/.test(DB_ID)) {
	console.error('No valid deploy.database_id in config.yaml — run `npm run provision` first');
	process.exit(1);
}

interface AlertConfig {
	condition: string;
	severity: 'warning' | 'critical';
	failures: number;
	recovery: number;
	cooldown?: string;
}

interface MonitorConfig {
	name: string;
	type: 'http' | 'tcp' | 'dns' | 'openmetrics';
	mode: 'external' | 'internal';
	visibility?: 'public' | 'private';
	ssl?: boolean;
	enabled?: boolean;
	target: string;
	interval?: string;
	alerts?: AlertConfig[];
	notification_channels?: string[];
}

interface SlackChannelConfig {
	name: string;
	type: 'slack';
	url: string;
	channel?: string;
	is_default?: boolean;
}

interface WebhookChannelConfig {
	name: string;
	type: 'webhook';
	url: string;
	headers?: Record<string, string>;
	is_default?: boolean;
}

interface EmailChannelConfig {
	name: string;
	type: 'email';
	server: string;
	port: number;
	from: string;
	to: string | string[];
	username?: string;
	password?: string;
	is_default?: boolean;
}

interface TelegramChannelConfig {
	name: string;
	type: 'telegram';
	bot_token: string;
	chat_id: string;
	is_default?: boolean;
}

type NotificationChannelConfig = SlackChannelConfig | WebhookChannelConfig | EmailChannelConfig | TelegramChannelConfig;

interface AuthConfig {
	provider: 'cloudflare_access';
	team_domain: string;
	aud: string;
}

interface Config {
	monitors: MonitorConfig[];
	notification_channels?: NotificationChannelConfig[];
	auth?: AuthConfig;
}

function slug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

function parseInterval(interval: string): number {
	const sMatch = interval.match(/^(\d+)s$/);
	if (sMatch) return parseInt(sMatch[1]);
	const mMatch = interval.match(/^(\d+)m$/);
	if (mMatch) return parseInt(mMatch[1]) * 60;
	throw new Error(`Unknown interval format: ${interval}`);
}

function parseCondition(condition: string): { dbCondition: string; threshold: number; metricName?: string } {
	if (/status\s*!=\s*200/.test(condition)) return { dbCondition: 'eq', threshold: 0 };
	if (/connect\s*!=\s*true/.test(condition) || /status\s*!=\s*up/.test(condition)) return { dbCondition: 'eq', threshold: 0 };
	const latMatch = condition.match(/latency\s*(>=|<=|>|<)\s*(\d+)/);
	if (latMatch) {
		const opMap: Record<string, string> = { '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte' };
		return { dbCondition: opMap[latMatch[1]], threshold: parseFloat(latMatch[2]) };
	}
	const sslMatch = condition.match(/ssl_expiry(?:_days)?\s*<\s*(\d+)/i);
	if (sslMatch) return { dbCondition: 'lt', threshold: parseInt(sslMatch[1]), metricName: 'ssl_expiry' };
	throw new Error(`Cannot parse condition: ${condition}`);
}

function parseCooldown(cooldown?: string): number {
	if (!cooldown) return 0;
	const sMatch = cooldown.match(/^(\d+)s$/);
	if (sMatch) return parseInt(sMatch[1]);
	const mMatch = cooldown.match(/^(\d+)m$/);
	if (mMatch) return parseInt(mMatch[1]) * 60;
	return 0;
}

function normalizeTarget(monitor: MonitorConfig): string {
	if (monitor.type !== 'tcp') return monitor.target;

	const normalized = monitor.target.startsWith('tcp://') ? monitor.target : `tcp://${monitor.target}`;
	const url = new URL(normalized);
	const port = Number(url.port);
	if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid TCP target for monitor "${monitor.name}": ${monitor.target}. Use host:port or tcp://host:port.`);
	}
	return `${url.hostname}:${port}`;
}

async function d1Query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
	const res = await fetch(`${API_BASE}/accounts/${accountId}/d1/database/${DB_ID}/query`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ sql, params }),
	});
	const data = (await res.json()) as {
		success: boolean;
		errors: { message: string }[];
		result: { results: T[] }[];
	};
	if (!data.success) throw new Error(`D1 error: ${data.errors.map((e) => e.message).join(', ')}`);
	return data.result[0]?.results ?? [];
}

async function main() {
	const raw = readFileSync('config.yaml', 'utf-8');
	const config = parse(raw) as Config;

	const yamlIds = config.monitors.map((m) => slug(m.name));
	const yamlChannelIds = new Set((config.notification_channels ?? []).map((c) => slug(c.name)));
	const knownChannelNames = new Set((config.notification_channels ?? []).map((c) => c.name));

	// Import channels before monitors so per-monitor assignments can reference valid channel IDs.
	for (const channel of config.notification_channels ?? []) {
		const id = slug(channel.name);
		console.log(`Importing channel: ${channel.name} (${id})`);
		const { name: _n, type: _t, is_default: _d, ...rest } = channel as unknown as Record<string, unknown>;
		const configuration = JSON.stringify(rest);
		await d1Query(
			`INSERT INTO notification_channels (id, name, type, configuration, secret_name, is_default, enabled)
       VALUES (?, ?, ?, ?, '', ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         configuration = excluded.configuration,
         is_default = excluded.is_default,
         enabled = 1`,
			[id, channel.name, channel.type, configuration, channel.is_default ? 1 : 0],
		);
	}

	const existingChannels = await d1Query<{ id: string }>('SELECT id FROM notification_channels WHERE enabled = 1');
	const removedChannels = existingChannels.filter((r) => !yamlChannelIds.has(r.id));
	for (const r of removedChannels) {
		console.log(`Soft-deleting channel: ${r.id}`);
		await d1Query("UPDATE notification_channels SET enabled = 0 WHERE id = ?", [r.id]);
	}

	const existing = await d1Query<{ id: string }>('SELECT id FROM monitors WHERE enabled = 1');
	const existingIds = new Set(existing.map((r) => r.id));

	for (const monitor of config.monitors) {
		const id = slug(monitor.name);
		const intervalSeconds = parseInterval(monitor.interval ?? '5m');
		const target = normalizeTarget(monitor);

		console.log(`Importing monitor: ${monitor.name} (${id})`);

		// Upsert (not INSERT OR REPLACE): REPLACE deletes the row first, which would cascade
		// through ON DELETE CASCADE and wipe monitor_state, incidents, executions and metric_series
		// on every import. ON CONFLICT updates in place and preserves runtime data + created_at.
		await d1Query(
			`INSERT INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, ssl_check, paused, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         mode = excluded.mode,
         visibility = excluded.visibility,
         scrape_url = excluded.scrape_url,
         interval_seconds = excluded.interval_seconds,
         ssl_check = excluded.ssl_check,
         paused = excluded.paused,
         enabled = 1,
         updated_at = datetime('now')`,
			[
				id,
				monitor.name,
				monitor.type,
				monitor.mode,
				monitor.visibility ?? 'private',
				target,
				intervalSeconds,
				(monitor.ssl ?? true) ? 1 : 0,
				monitor.enabled === false ? 1 : 0,
			],
		);

		const alerts = monitor.alerts ?? [];
		for (let i = 0; i < alerts.length; i++) {
			const alert = alerts[i];
			const alertId = `${id}-alert-${i}`;
			const { dbCondition, threshold, metricName } = parseCondition(alert.condition);
			const cooldownSeconds = parseCooldown(alert.cooldown);

			// Upsert: incidents.alert_rule_id references this row (no cascade), so a REPLACE
			// delete would fail or orphan history. ON CONFLICT updates the rule in place.
			await d1Query(
				`INSERT INTO alert_rules (id, monitor_id, metric_name, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET
           monitor_id = excluded.monitor_id,
           metric_name = excluded.metric_name,
           condition = excluded.condition,
           threshold = excluded.threshold,
           severity = excluded.severity,
           failure_count = excluded.failure_count,
           recovery_count = excluded.recovery_count,
           cooldown_seconds = excluded.cooldown_seconds,
           enabled = 1`,
				[alertId, id, metricName ?? null, dbCondition, threshold, alert.severity, alert.failures, alert.recovery, cooldownSeconds],
			);
		}

		if (monitor.notification_channels !== undefined) {
			for (const channelName of monitor.notification_channels) {
				if (!knownChannelNames.has(channelName)) {
					console.warn(`Warning: monitor "${monitor.name}" references unknown channel "${channelName}" — channel not found in notification_channels config`);
				}
				const channelId = slug(channelName);
				await d1Query(
					`INSERT INTO monitor_notification_channels (monitor_id, channel_id, notify_on, enabled)
           VALUES (?, ?, '["incident_open","incident_resolved"]', 1)
           ON CONFLICT(monitor_id, channel_id) DO UPDATE SET enabled = 1`,
					[id, channelId],
				);
			}
			if (monitor.notification_channels.length > 0) {
				const placeholders = monitor.notification_channels.map(() => '?').join(', ');
				const channelIds = monitor.notification_channels.map((n) => slug(n));
				await d1Query(
					`UPDATE monitor_notification_channels SET enabled = 0 WHERE monitor_id = ? AND channel_id NOT IN (${placeholders})`,
					[id, ...channelIds],
				);
			}
		}

		// Add default SSL expiry rules if no ssl_expiry alerts are explicitly configured
		const hasSslRule = alerts.some((a) => /ssl_expiry/i.test(a.condition));
		const sslEnabled = monitor.ssl ?? true;
		if (!hasSslRule && sslEnabled && ['http', 'tcp'].includes(monitor.type)) {
			await d1Query(
				`INSERT OR IGNORE INTO alert_rules (id, monitor_id, metric_name, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled)
         VALUES (?, ?, 'ssl_expiry', 'lt', 7, 'warning', 1, 1, 0, 1)`,
				[`${id}-ssl-warn`, id],
			);
			await d1Query(
				`INSERT OR IGNORE INTO alert_rules (id, monitor_id, metric_name, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled)
         VALUES (?, ?, 'ssl_expiry', 'lt', 1, 'critical', 1, 1, 0, 1)`,
				[`${id}-ssl-crit`, id],
			);
		}
	}

	const removed = [...existingIds].filter((id) => !yamlIds.includes(id));
	for (const id of removed) {
		console.log(`Soft-deleting monitor: ${id}`);
		await d1Query("UPDATE monitors SET enabled = 0, updated_at = datetime('now') WHERE id = ?", [id]);
		await d1Query('UPDATE monitor_notification_channels SET enabled = 0 WHERE monitor_id = ?', [id]);
	}

	if (config.auth) {
		console.log('Importing auth config...');
		await d1Query(
			`INSERT OR REPLACE INTO auth_config (id, provider, team_domain, aud, enabled, updated_at)
       VALUES ('default', ?, ?, ?, 1, datetime('now'))`,
			[config.auth.provider, config.auth.team_domain, config.auth.aud],
		);
		console.log('Auth config imported.');
	} else {
		await d1Query(`UPDATE auth_config SET enabled = 0, updated_at = datetime('now') WHERE id = 'default'`);
	}

	// Ensure channel assignments are disabled for any monitor that is disabled,
	// regardless of when it was soft-deleted (catches pre-existing stale rows too).
	await d1Query(
		'UPDATE monitor_notification_channels SET enabled = 0 WHERE monitor_id IN (SELECT id FROM monitors WHERE enabled = 0)',
	);

	console.log(
		`Import complete. ${config.monitors.length} monitor(s) imported, ${removed.length} soft-deleted, ${config.notification_channels?.length ?? 0} channel(s) imported, ${removedChannels.length} channel(s) soft-deleted.`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
