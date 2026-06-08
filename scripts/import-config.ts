import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const DB_ID = 'fe16be42-154e-47ed-bd63-a54cf5d5cd53';
const API_BASE = 'https://api.cloudflare.com/client/v4';

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!token || !accountId) {
	console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
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
	type: 'http' | 'tcp' | 'dns' | 'heartbeat' | 'openmetrics';
	mode: 'external' | 'internal';
	visibility?: 'public' | 'private';
	ssl?: boolean;
	target: string;
	interval?: string;
	alerts?: AlertConfig[];
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

	const existing = await d1Query<{ id: string }>('SELECT id FROM monitors WHERE enabled = 1');
	const existingIds = new Set(existing.map((r) => r.id));

	for (const monitor of config.monitors) {
		const id = slug(monitor.name);
		const intervalSeconds = parseInterval(monitor.interval ?? '5m');
		const target = normalizeTarget(monitor);

		console.log(`Importing monitor: ${monitor.name} (${id})`);

		await d1Query(
			`INSERT OR REPLACE INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, ssl_check, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1,
         COALESCE((SELECT created_at FROM monitors WHERE id = ?), datetime('now')),
         datetime('now'))`,
			[id, monitor.name, monitor.type, monitor.mode, monitor.visibility ?? 'private', target, intervalSeconds, (monitor.ssl ?? true) ? 1 : 0, id],
		);

		for (let i = 0; i < (monitor.alerts ?? []).length; i++) {
			const alert = monitor.alerts![i];
			const alertId = `${id}-alert-${i}`;
			const { dbCondition, threshold, metricName } = parseCondition(alert.condition);
			const cooldownSeconds = parseCooldown(alert.cooldown);

			await d1Query(
				`INSERT OR REPLACE INTO alert_rules (id, monitor_id, metric_name, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
				[alertId, id, metricName ?? null, dbCondition, threshold, alert.severity, alert.failures, alert.recovery, cooldownSeconds],
			);
		}
	}

	const removed = [...existingIds].filter((id) => !yamlIds.includes(id));
	for (const id of removed) {
		console.log(`Soft-deleting monitor: ${id}`);
		await d1Query("UPDATE monitors SET enabled = 0, updated_at = datetime('now') WHERE id = ?", [id]);
	}

	for (const channel of config.notification_channels ?? []) {
		const id = slug(channel.name);
		console.log(`Importing channel: ${channel.name} (${id})`);
		const { name: _n, type: _t, is_default: _d, ...rest } = channel as Record<string, unknown>;
		const configuration = JSON.stringify(rest);
		await d1Query(
			`INSERT OR REPLACE INTO notification_channels (id, name, type, configuration, secret_name, is_default, enabled)
       VALUES (?, ?, ?, ?, '', ?, 1)`,
			[id, channel.name, channel.type, configuration, channel.is_default ? 1 : 0],
		);
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

	console.log(
		`Import complete. ${config.monitors.length} monitor(s) imported, ${removed.length} soft-deleted, ${config.notification_channels?.length ?? 0} channel(s) imported.`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
