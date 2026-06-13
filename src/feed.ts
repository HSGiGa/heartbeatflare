// Public Atom 1.0 feed of incidents and maintenance windows. A machine-readable update channel
// (feed readers, Slack/RSS bridges, automation) — no subscriber database, no email.
import type { IncidentRow, MaintenanceWindowRow } from './types';

function xmlEsc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Normalise a stored timestamp (ISO 8601, or D1 "YYYY-MM-DD HH:MM:SS") to RFC 3339 for Atom.
function rfc3339(value: string): string {
	const d = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
	return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

type FeedEntry = { id: string; title: string; updated: string; published: string; summary: string };

export function buildAtomFeed({
	origin,
	nowMs,
	incidents,
	maintenanceWindows,
}: {
	origin: string;
	nowMs: number;
	incidents: IncidentRow[];
	maintenanceWindows: MaintenanceWindowRow[];
}): string {
	const entries: FeedEntry[] = [];

	for (const inc of incidents) {
		const name = inc.monitor_name ?? inc.monitor_id;
		const resolved = inc.status === 'resolved' || inc.resolved_at != null;
		const title = resolved ? `Resolved: ${name}` : `${inc.severity === 'warning' ? 'Warning' : 'Outage'}: ${name}`;
		const parts = [`Severity: ${inc.severity}`, `Started: ${inc.started_at}`];
		if (inc.resolved_at) parts.push(`Resolved: ${inc.resolved_at}`);
		if (inc.reason) parts.push(inc.reason);
		entries.push({
			id: `urn:hbf:incident:${inc.id}`,
			title,
			updated: rfc3339(inc.resolved_at ?? inc.started_at),
			published: rfc3339(inc.started_at),
			summary: parts.join(' · '),
		});
	}

	for (const w of maintenanceWindows) {
		entries.push({
			id: `urn:hbf:maintenance:${w.id}`,
			title: `Maintenance: ${w.title}`,
			updated: rfc3339(w.starts_at),
			published: rfc3339(w.starts_at),
			summary: [`Scheduled ${w.starts_at} → ${w.ends_at}`, w.body ?? ''].filter(Boolean).join(' · '),
		});
	}

	entries.sort((a, b) => b.updated.localeCompare(a.updated));
	const feedUpdated = entries[0]?.updated ?? new Date(nowMs).toISOString();
	const self = `${origin}/feed.xml`;
	const page = `${origin}/public`;

	const entriesXml = entries
		.map(
			(e) => `  <entry>
    <id>${xmlEsc(e.id)}</id>
    <title>${xmlEsc(e.title)}</title>
    <updated>${xmlEsc(e.updated)}</updated>
    <published>${xmlEsc(e.published)}</published>
    <link href="${xmlEsc(page)}"/>
    <summary>${xmlEsc(e.summary)}</summary>
  </entry>`,
		)
		.join('\n');

	return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>HeartbeatFlare Status</title>
  <id>${xmlEsc(self)}</id>
  <link rel="self" href="${xmlEsc(self)}"/>
  <link href="${xmlEsc(page)}"/>
  <updated>${xmlEsc(feedUpdated)}</updated>
${entriesXml}
</feed>
`;
}
