// Builds the PROBE_HEADERS map (feature: WAF-safe monitoring, Issue #16) shipped to the Worker as a
// generated var. Keyed by monitor id, with ${VAR} placeholders preserved verbatim (resolved at probe
// runtime from Worker secrets). Custom headers are only valid on type: http monitors — a non-http
// monitor carrying headers throws, so generation fails loudly rather than silently dropping them.
// Pure (no Node/SDK deps) so it can be unit-tested in the Workers vitest pool.
import { slug } from './naming';

export type MonitorHeaders = { name: string; type: string; headers?: Record<string, string> };

export function buildProbeHeadersMap(monitors: MonitorHeaders[]): Record<string, Record<string, string>> {
	const map: Record<string, Record<string, string>> = {};
	for (const m of monitors) {
		if (!m.headers || Object.keys(m.headers).length === 0) continue;
		if (m.type !== 'http') {
			throw new Error(`monitor "${m.name}" sets headers but is type "${m.type}" — headers are only supported on type: http monitors.`);
		}
		// The default User-Agent (set in src/probes.ts) is fixed and not configurable — reject any attempt
		// to set it rather than silently dropping it at probe time.
		if (Object.keys(m.headers).some((k) => k.toLowerCase() === 'user-agent')) {
			throw new Error(`monitor "${m.name}" cannot set a "User-Agent" header — it is fixed and reserved.`);
		}
		map[slug(m.name)] = m.headers;
	}
	return map;
}
