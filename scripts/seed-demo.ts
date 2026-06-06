import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';

const TODAY = new Date();
TODAY.setUTCHours(12, 0, 0, 0);

const monitors = [
	{ id: 'cloudflare-dns-tcp', alertRuleId: 'cloudflare-dns-tcp-alert-0', needsRule: true },
	{ id: 'google', alertRuleId: 'google-alert-0', needsRule: false },
	{ id: 'google-dns', alertRuleId: 'google-dns-alert-0', needsRule: false },
	{ id: 'gmail-smtp', alertRuleId: 'gmail-smtp-alert-0', needsRule: false },
];

function daysAgo(n: number): Date {
	const d = new Date(TODAY);
	d.setUTCDate(d.getUTCDate() - n);
	return d;
}

function isoStr(d: Date): string {
	return d.toISOString().slice(0, 19) + 'Z';
}

function vary(monIdx: number, offset: number): number {
	return ((monIdx * 17 + offset * 13) % 100) / 100;
}

const sql: string[] = [];

// Seed alert rule for monitor with no rules
sql.push(
	`INSERT OR IGNORE INTO alert_rules (id, monitor_id, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled)` +
	` VALUES ('cloudflare-dns-tcp-alert-0', 'cloudflare-dns-tcp', 'gt', 1000, 'critical', 3, 2, 300, 1);`,
);

// uptime_daily: 60 days per monitor
const CHECKS_PER_DAY = 288; // every 5 min
for (let monIdx = 0; monIdx < monitors.length; monIdx++) {
	const mon = monitors[monIdx];
	for (let i = 60; i >= 1; i--) {
		const d = daysAgo(i);
		const dayStr = d.toISOString().slice(0, 10);
		const v = vary(monIdx, i);

		let avgUp: number;
		let latency: number;

		if (i === 25 || i === 24) {
			// Major dip ~25 days ago
			avgUp = 0.68 + v * 0.18;
			latency = 350 + Math.round(v * 600);
		} else if (i === 12) {
			// Minor dip ~12 days ago
			avgUp = 0.87 + v * 0.09;
			latency = 180 + Math.round(v * 320);
		} else {
			avgUp = 0.994 + v * 0.005;
			latency = 60 + Math.round(v * 220);
		}

		const upChecks = Math.min(CHECKS_PER_DAY, Math.max(0, Math.round(CHECKS_PER_DAY * avgUp)));
		sql.push(
			`INSERT OR IGNORE INTO uptime_daily (monitor_id, day, total_checks, up_checks, avg_latency_ms)` +
			` VALUES ('${mon.id}', '${dayStr}', ${CHECKS_PER_DAY}, ${upChecks}, ${latency});`,
		);
	}
}

// uptime_hourly: last 47 hours per monitor (feeds sparklines + 24h uptime stat)
for (let monIdx = 0; monIdx < monitors.length; monIdx++) {
	const mon = monitors[monIdx];
	for (let h = 47; h >= 1; h--) {
		const d = new Date(TODAY);
		d.setUTCHours(d.getUTCHours() - h);
		const hourStr = d.toISOString().slice(0, 13);
		const latency = 65 + Math.round(vary(monIdx, h) * 180);
		sql.push(
			`INSERT OR IGNORE INTO uptime_hourly (monitor_id, hour, total_checks, up_checks, avg_latency_ms)` +
			` VALUES ('${mon.id}', '${hourStr}', 12, 12, ${latency});`,
		);
	}
}

// incidents: 3 per monitor
const templates = [
	{ daysBack: 25, startHour: 3, durationMs: 2 * 3600_000, severity: 'critical', reason: 'Connection timeout' },
	{ daysBack: 12, startHour: 7, durationMs: 45 * 60_000, severity: 'warning', reason: 'High latency detected' },
	{ daysBack: 4, startHour: 14, durationMs: 20 * 60_000, severity: 'critical', reason: 'SSL handshake failed' },
];

for (const mon of monitors) {
	for (let t = 0; t < templates.length; t++) {
		const tmpl = templates[t];
		const start = daysAgo(tmpl.daysBack);
		start.setUTCHours(tmpl.startHour, 0, 0, 0);
		const end = new Date(start.getTime() + tmpl.durationMs);
		const id = `seed-${mon.id}-${t}`;
		sql.push(
			`INSERT OR IGNORE INTO incidents (id, monitor_id, alert_rule_id, status, severity, started_at, resolved_at, reason)` +
			` VALUES ('${id}', '${mon.id}', '${mon.alertRuleId}', 'resolved', '${tmpl.severity}', '${isoStr(start)}', '${isoStr(end)}', '${tmpl.reason}');`,
		);
	}
}

const sqlFile = '/tmp/hbf-seed.sql';
writeFileSync(sqlFile, sql.join('\n') + '\n');
console.log(`Generated ${sql.length} SQL statements → ${sqlFile}`);

try {
	execSync(`npx wrangler d1 execute heartbeatflare-prod-db --remote --file ${sqlFile}`, { stdio: 'inherit' });
	console.log('\nSeed complete.');
} finally {
	unlinkSync(sqlFile);
}
