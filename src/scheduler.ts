import { evaluateAlerts, storeResult } from './alerts';
import { dnsCheck, httpCheck, tcpCheck } from './probes';
import type { MonitorRow } from './types';

export async function handleScheduled(env: Env): Promise<void> {
	const now = new Date().toISOString();

	const { results } = await env.DB.prepare(
		`SELECT m.id, m.name, m.type, m.scrape_url, m.interval_seconds, m.ssl_check,
		        ms.status AS current_status, ms.last_check_at,
		        COALESCE(ms.consecutive_failures, 0) AS consecutive_failures,
		        COALESCE(ms.consecutive_successes, 0) AS consecutive_successes,
		        ms.active_incident_id
		 FROM monitors m
		 LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
		 WHERE m.enabled = 1 AND m.type IN ('http', 'tcp', 'dns') AND m.mode = 'external'
		   AND (ms.last_check_at IS NULL
		        OR datetime(ms.last_check_at, '+' || m.interval_seconds || ' seconds') <= datetime('now'))`,
	).all<MonitorRow>();

	await Promise.allSettled(
		results.map(async (monitor) => {
			const executionId = crypto.randomUUID();
			const result =
				monitor.type === 'tcp' ? await tcpCheck(monitor.scrape_url!) :
				monitor.type === 'dns' ? await dnsCheck(monitor.scrape_url!) :
				await httpCheck(monitor.scrape_url!, monitor.ssl_check === 1);
			const { newFailures, newSuccesses } = await storeResult(env, monitor, result, executionId, now);
			await evaluateAlerts(env, monitor, result, newFailures, newSuccesses, now);
		}),
	);

	const { results: staleHeartbeats } = await env.DB.prepare(
		`SELECT m.id, m.name, m.type, m.scrape_url, m.interval_seconds,
		        COALESCE(m.ssl_check, 1) AS ssl_check,
		        ms.status AS current_status, ms.last_check_at,
		        COALESCE(ms.consecutive_failures, 0) AS consecutive_failures,
		        COALESCE(ms.consecutive_successes, 0) AS consecutive_successes,
		        ms.active_incident_id
		 FROM monitors m
		 LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
		 WHERE m.enabled = 1 AND m.type = 'heartbeat'
		   AND (ms.last_success_at IS NULL
		        OR datetime(ms.last_success_at, '+' || m.interval_seconds || ' seconds') <= datetime('now'))`,
	).all<MonitorRow>();

	await Promise.allSettled(
		staleHeartbeats.map(async (monitor) => {
			const result = { status: 'down' as const, latency_ms: 0, error: 'Heartbeat missed' };
			const { newFailures, newSuccesses } = await storeResult(env, monitor, result, crypto.randomUUID(), now);
			await evaluateAlerts(env, monitor, result, newFailures, newSuccesses, now);
		}),
	);
}
