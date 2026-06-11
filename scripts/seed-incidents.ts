// Seeds test incidents that line up exactly with the red/yellow uptime bars on the
// status page. Incidents are derived from the LIVE uptime_daily data (not relative
// dates), so they always match whatever dips are currently displayed.
//
//   red bar    = up/total < 0.95  -> critical incident
//   yellow bar = up/total < 0.99  -> warning incident
//
// Contiguous same-severity days are merged into a single incident. Idempotent:
// re-running clears prior `seed-inc-*` rows and regenerates from current data.
//
//   npx tsx scripts/seed-incidents.ts

const DB_ID = 'fe16be42-154e-47ed-bd63-a54cf5d5cd53';
const API_BASE = 'https://api.cloudflare.com/client/v4';

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!token || !accountId) {
	console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
	process.exit(1);
}

const RED_THRESHOLD = 0.95; // < => critical
const YELLOW_THRESHOLD = 0.99; // < => warning  (mirrors renderBars in src/status-page.ts)

async function d1Query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
	const res = await fetch(`${API_BASE}/accounts/${accountId}/d1/database/${DB_ID}/query`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ sql, params }),
	});
	const data = (await res.json()) as { success: boolean; errors: { message: string }[]; result: { results: T[] }[] };
	if (!data.success) throw new Error(`D1 error: ${data.errors.map((e) => e.message).join(', ')}`);
	return data.result[0]?.results ?? [];
}

type DayRow = { monitor_id: string; day: string; up_checks: number; total_checks: number };
type RuleRow = { monitor_id: string; id: string };
type Severity = 'critical' | 'warning';

function classify(up: number, total: number): Severity | null {
	if (total <= 0) return null;
	const avg = up / total;
	if (avg < RED_THRESHOLD) return 'critical';
	if (avg < YELLOW_THRESHOLD) return 'warning';
	return null;
}

const REASON: Record<Severity, string> = {
	critical: 'Connectivity failures — multiple consecutive checks failed',
	warning: 'Degraded performance — elevated latency',
};

async function main() {
	const [dipRows, ruleRows] = await Promise.all([
		d1Query<DayRow>(
			`SELECT monitor_id, day, up_checks, total_checks FROM uptime_daily
			 WHERE day >= date('now','-90 days') ORDER BY monitor_id, day`,
		),
		d1Query<RuleRow>(`SELECT monitor_id, id FROM alert_rules ORDER BY monitor_id, id`),
	]);

	// monitor -> a valid alert_rule id for the FK (prefer the `-alert-0` connectivity rule)
	const ruleByMonitor = new Map<string, string>();
	for (const r of ruleRows) {
		const existing = ruleByMonitor.get(r.monitor_id);
		if (!existing || r.id.endsWith('-alert-0')) ruleByMonitor.set(r.monitor_id, r.id);
	}

	// Group dip rows by monitor, preserving day order
	const byMonitor = new Map<string, DayRow[]>();
	for (const row of dipRows) {
		const list = byMonitor.get(row.monitor_id) ?? [];
		list.push(row);
		byMonitor.set(row.monitor_id, list);
	}

	type Incident = { id: string; monitorId: string; ruleId: string; severity: Severity; start: string; end: string; reason: string };
	const incidents: Incident[] = [];
	const skipped: string[] = [];

	for (const [monitorId, days] of byMonitor) {
		const ruleId = ruleByMonitor.get(monitorId);
		// Collapse into contiguous same-severity runs of dip days
		let run: { severity: Severity; first: string; last: string } | null = null;
		const flush = () => {
			if (!run) return;
			if (!ruleId) {
				skipped.push(monitorId);
				run = null;
				return;
			}
			incidents.push({
				id: `seed-inc-${monitorId}-${run.first}`,
				monitorId,
				ruleId,
				severity: run.severity,
				start: `${run.first}T02:00:00Z`,
				end: `${run.last}T21:00:00Z`,
				reason: REASON[run.severity],
			});
			run = null;
		};

		let prevDay: string | null = null;
		for (const d of days) {
			const sev = classify(d.up_checks, d.total_checks);
			if (sev === null) {
				flush();
				prevDay = d.day;
				continue;
			}
			const contiguous = prevDay !== null && dayDiff(prevDay, d.day) === 1;
			if (run && run.severity === sev && contiguous) {
				run.last = d.day;
			} else {
				flush();
				run = { severity: sev, first: d.day, last: d.day };
			}
			prevDay = d.day;
		}
		flush();
	}

	// Idempotent: clear previously seeded incidents, then insert the freshly computed set
	await d1Query(`DELETE FROM incidents WHERE id LIKE 'seed-inc-%'`);

	for (const inc of incidents) {
		await d1Query(
			`INSERT OR REPLACE INTO incidents (id, monitor_id, alert_rule_id, status, severity, started_at, resolved_at, reason)
			 VALUES (?, ?, ?, 'resolved', ?, ?, ?, ?)`,
			[inc.id, inc.monitorId, inc.ruleId, inc.severity, inc.start, inc.end, inc.reason],
		);
		console.log(`  ${inc.severity.padEnd(8)} ${inc.monitorId.padEnd(14)} ${inc.start.slice(0, 10)} → ${inc.end.slice(0, 10)}`);
	}

	console.log(`\nSeeded ${incidents.length} incident(s) matching current red/yellow bars.`);
	if (skipped.length) console.warn(`Skipped (no alert_rule for FK): ${[...new Set(skipped)].join(', ')}`);
}

function dayDiff(a: string, b: string): number {
	return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
