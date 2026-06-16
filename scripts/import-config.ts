import { parse } from 'yaml';
import Cloudflare from 'cloudflare';
import { assertUserConfig, loadConfig, loadConfigRaw, resolveDeploy, requireEnv } from './lib/deploy-config';
import { findDatabaseId } from './lib/d1';
import { heartbeatSecretName, slug } from './lib/naming';

const API_BASE = 'https://api.cloudflare.com/client/v4';

const token = requireEnv('CLOUDFLARE_API_TOKEN');
const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');

// Resolved by name at the start of main(); the D1 exists by then (provision runs earlier).
let DB_ID = '';

interface AlertConfig {
	condition: string;
	severity: 'warning' | 'critical';
	failures: number;
	recovery: number;
	cooldown?: string;
	escalation?: string;
}

interface MonitorConfig {
	name: string;
	type: 'http' | 'tcp' | 'dns' | 'heartbeat' | 'openmetrics';
	mode: 'external' | 'internal';
	visibility?: 'public' | 'private';
	ssl?: boolean;
	enabled?: boolean;
	target?: string; // required for all types except heartbeat (push)
	interval?: string;
	alerts?: AlertConfig[];
	notification_channels?: string[];
	// Custom HTTP probe headers (type: http only). Not stored in D1 — shipped to the Worker as the
	// generated PROBE_HEADERS var by scripts/generate-wrangler.ts. Listed here so the config type is honest.
	headers?: Record<string, string>;
}

interface NotificationTemplatesConfig {
	down?: string;
	recovered?: string;
	escalation?: string;
}

interface SlackChannelConfig {
	name: string;
	type: 'slack';
	url: string;
	channel?: string;
	templates?: NotificationTemplatesConfig;
	is_default?: boolean;
}

interface WebhookChannelConfig {
	name: string;
	type: 'webhook';
	url: string;
	headers?: Record<string, string>;
	templates?: NotificationTemplatesConfig;
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
	templates?: NotificationTemplatesConfig;
	is_default?: boolean;
}

type NotificationChannelConfig = SlackChannelConfig | WebhookChannelConfig | EmailChannelConfig | TelegramChannelConfig;

interface AuthConfig {
	provider: 'cloudflare_access';
	team_name: string;
	aud: string;
}

interface MaintenanceConfig {
	title: string;
	body?: string;
	starts_at: string;
	ends_at: string;
	monitors?: string[];
}

interface Config {
	monitors: MonitorConfig[];
	notification_channels?: NotificationChannelConfig[];
	auth?: AuthConfig;
	maintenance?: MaintenanceConfig[];
}

function parseInterval(interval: string): number {
	const m = interval.match(/^(\d+)([smhd])$/);
	if (!m) throw new Error(`Unknown interval format: ${interval}`);
	const n = parseInt(m[1], 10);
	const unit: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
	return n * unit[m[2]];
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

function parseDuration(value?: string): number {
	if (!value) return 0;
	const sMatch = value.match(/^(\d+)s$/);
	if (sMatch) return parseInt(sMatch[1]);
	const mMatch = value.match(/^(\d+)m$/);
	if (mMatch) return parseInt(mMatch[1]) * 60;
	const hMatch = value.match(/^(\d+)h$/);
	if (hMatch) return parseInt(hMatch[1]) * 3600;
	return 0;
}

function parseCooldown(cooldown?: string): number {
	return parseDuration(cooldown);
}

function parseEscalation(escalation?: string): number | null {
	if (!escalation) return null;
	const secs = parseDuration(escalation);
	return secs > 0 ? secs : null;
}

function normalizeTarget(monitor: MonitorConfig): string {
	if (!monitor.target) throw new Error(`Monitor "${monitor.name}" of type ${monitor.type} requires a target`);
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
	assertUserConfig();
	const raw = loadConfigRaw();
	const config = parse(raw) as Config;

	const { databaseName } = resolveDeploy(loadConfig());
	const found = await findDatabaseId(new Cloudflare({ apiToken: token }), accountId, databaseName);
	if (!found) {
		console.error(`D1 database "${databaseName}" not found — run \`npm run provision\` first`);
		process.exit(1);
	}
	DB_ID = found;

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
		if (!id) throw new Error(`Monitor "${monitor.name}" produces an empty id — give it a name with letters or digits`);
		const intervalSeconds = parseInterval(monitor.interval ?? '5m');
		const isHeartbeat = monitor.type === 'heartbeat';
		// Heartbeat is push-based: no probe target, no SSL probe. Its token lives in a Worker Secret;
		// D1 stores only the reference `secret:<NAME>`, with NAME derived from the monitor id.
		const scrapeUrl = isHeartbeat ? null : normalizeTarget(monitor);
		const sslCheck = isHeartbeat ? 0 : (monitor.ssl ?? true) ? 1 : 0;
		const heartbeatToken = isHeartbeat ? `secret:${heartbeatSecretName(id)}` : null;

		console.log(`Importing monitor: ${monitor.name} (${id})${isHeartbeat ? ` [heartbeat secret: ${heartbeatSecretName(id)}]` : ''}`);

		// Upsert (not INSERT OR REPLACE): REPLACE deletes the row first, which would cascade
		// through ON DELETE CASCADE and wipe monitor_state, incidents, executions and metric_series
		// on every import. ON CONFLICT updates in place and preserves runtime data + created_at.
		await d1Query(
			`INSERT INTO monitors (id, name, type, mode, visibility, scrape_url, interval_seconds, ssl_check, heartbeat_token, paused, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         mode = excluded.mode,
         visibility = excluded.visibility,
         scrape_url = excluded.scrape_url,
         interval_seconds = excluded.interval_seconds,
         ssl_check = excluded.ssl_check,
         heartbeat_token = excluded.heartbeat_token,
         paused = excluded.paused,
         enabled = 1,
         updated_at = datetime('now')`,
			[
				id,
				monitor.name,
				monitor.type,
				monitor.mode,
				monitor.visibility ?? 'private',
				scrapeUrl,
				intervalSeconds,
				sslCheck,
				heartbeatToken,
				monitor.enabled === false ? 1 : 0,
			],
		);

		const alerts = monitor.alerts ?? [];
		for (let i = 0; i < alerts.length; i++) {
			const alert = alerts[i];
			const alertId = `${id}-alert-${i}`;
			const { dbCondition, threshold, metricName } = parseCondition(alert.condition);
			const cooldownSeconds = parseCooldown(alert.cooldown);
			const escalationSeconds = parseEscalation(alert.escalation);

			// Upsert: incidents.alert_rule_id references this row (no cascade), so a REPLACE
			// delete would fail or orphan history. ON CONFLICT updates the rule in place.
			await d1Query(
				`INSERT INTO alert_rules (id, monitor_id, metric_name, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, escalation_seconds, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET
           monitor_id = excluded.monitor_id,
           metric_name = excluded.metric_name,
           condition = excluded.condition,
           threshold = excluded.threshold,
           severity = excluded.severity,
           failure_count = excluded.failure_count,
           recovery_count = excluded.recovery_count,
           cooldown_seconds = excluded.cooldown_seconds,
           escalation_seconds = excluded.escalation_seconds,
           enabled = 1`,
				[alertId, id, metricName ?? null, dbCondition, threshold, alert.severity, alert.failures, alert.recovery, cooldownSeconds, escalationSeconds],
			);
		}

		// Per-monitor channel routing. An explicit list pins the monitor to those channels;
		// omitting the key (or giving an empty list) clears any per-monitor assignment so the
		// monitor falls back to the is_default channels. We always fully reconcile D1 with the
		// YAML — including the omitted case — so stale assignments never linger after a list is
		// removed (otherwise fetchNotificationChannels keeps using the old per-monitor rows and
		// the default fallback never kicks in).
		const channelNames = monitor.notification_channels ?? [];
		for (const channelName of channelNames) {
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
		// Disable every assignment not in the YAML list. Empty list → disable all → use defaults.
		if (channelNames.length > 0) {
			const placeholders = channelNames.map(() => '?').join(', ');
			const channelIds = channelNames.map((n) => slug(n));
			await d1Query(
				`UPDATE monitor_notification_channels SET enabled = 0 WHERE monitor_id = ? AND channel_id NOT IN (${placeholders})`,
				[id, ...channelIds],
			);
		} else {
			await d1Query(`UPDATE monitor_notification_channels SET enabled = 0 WHERE monitor_id = ?`, [id]);
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
			`INSERT OR REPLACE INTO auth_config (id, provider, team_name, aud, enabled, updated_at)
       VALUES ('default', ?, ?, ?, 1, datetime('now'))`,
			[config.auth.provider, config.auth.team_name, config.auth.aud],
		);
		console.log('Auth config imported.');
	} else {
		await d1Query(`UPDATE auth_config SET enabled = 0, updated_at = datetime('now') WHERE id = 'default'`);
	}

	// Maintenance windows: upsert each window (id = slug(title)) and re-sync its affected
	// monitors, then hard-delete windows no longer in YAML (CASCADE clears their monitor links).
	const windows = config.maintenance ?? [];
	const windowIds = windows.map((w) => slug(w.title));
	for (const w of windows) {
		const id = slug(w.title);
		console.log(`Importing maintenance window: ${w.title} (${id})`);
		await d1Query(
			`INSERT INTO maintenance_windows (id, title, body, starts_at, ends_at, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         starts_at = excluded.starts_at,
         ends_at = excluded.ends_at,
         enabled = 1,
         updated_at = datetime('now')`,
			[id, w.title, w.body ?? null, w.starts_at, w.ends_at],
		);
		// Re-sync affected monitors: clear then insert the configured set (empty = global window).
		await d1Query('DELETE FROM maintenance_window_monitors WHERE window_id = ?', [id]);
		for (const monitorName of w.monitors ?? []) {
			await d1Query('INSERT OR IGNORE INTO maintenance_window_monitors (window_id, monitor_id) VALUES (?, ?)', [id, slug(monitorName)]);
		}
	}
	const existingWindows = await d1Query<{ id: string }>('SELECT id FROM maintenance_windows');
	for (const r of existingWindows.filter((row) => !windowIds.includes(row.id))) {
		console.log(`Deleting maintenance window: ${r.id}`);
		await d1Query('DELETE FROM maintenance_windows WHERE id = ?', [r.id]);
	}

	// Ensure channel assignments are disabled for any monitor that is disabled,
	// regardless of when it was soft-deleted (catches pre-existing stale rows too).
	await d1Query(
		'UPDATE monitor_notification_channels SET enabled = 0 WHERE monitor_id IN (SELECT id FROM monitors WHERE enabled = 0)',
	);

	// A soft-deleted monitor is never probed again, so its open incident can never auto-resolve.
	// Resolve it and clear the active-incident pointer — covers this import's removals and any
	// pre-existing stale rows from earlier soft-deletes.
	await d1Query(
		"UPDATE incidents SET status = 'resolved', resolved_at = datetime('now') WHERE status = 'open' AND monitor_id IN (SELECT id FROM monitors WHERE enabled = 0)",
	);
	await d1Query(
		'UPDATE monitor_state SET active_incident_id = NULL WHERE monitor_id IN (SELECT id FROM monitors WHERE enabled = 0)',
	);

	console.log(
		`Import complete. ${config.monitors.length} monitor(s) imported, ${removed.length} soft-deleted, ${config.notification_channels?.length ?? 0} channel(s) imported, ${removedChannels.length} channel(s) soft-deleted, ${windows.length} maintenance window(s) imported.`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
