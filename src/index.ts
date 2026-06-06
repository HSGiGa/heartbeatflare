import { httpCheck, tcpCheck, dnsCheck } from './probes';
import { storeResult, evaluateAlerts } from './alerts';
import { fetchNotificationChannels, sendToChannel } from './notify';
import { fetchUsage, usageResetsIn } from './usage';
import { buildStatusPage } from './status-page';
import type {
	MonitorDbRow,
	MonitorRow,
	AlertRuleDbRow,
	UptimeDayRow,
	LatencyRow,
	IncidentRow,
	NotificationMessage,
	RuntimeEnv,
} from './types';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname } = new URL(request.url);
		const runtimeEnv = env as RuntimeEnv;

		if (request.method === 'POST' && pathname.startsWith('/beat/')) {
			const monitorId = pathname.slice(6);
			const monitor = await env.DB.prepare(
				`SELECT m.id, m.name, m.type, m.scrape_url, m.interval_seconds,
				        COALESCE(m.ssl_check, 1) AS ssl_check,
				        ms.status AS current_status, ms.last_check_at,
				        COALESCE(ms.consecutive_failures, 0) AS consecutive_failures,
				        COALESCE(ms.consecutive_successes, 0) AS consecutive_successes,
				        ms.active_incident_id
				 FROM monitors m
				 LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
				 WHERE m.id = ? AND m.type = 'heartbeat' AND m.enabled = 1`,
			).bind(monitorId).first<MonitorRow>();
			if (!monitor) return new Response(null, { status: 404 });
			const now = new Date().toISOString();
			const result = { status: 'up' as const, latency_ms: 0 };
			const { newFailures, newSuccesses } = await storeResult(env, monitor, result, crypto.randomUUID(), now);
			await evaluateAlerts(env, monitor, result, newFailures, newSuccesses, now);
			return new Response(null, { status: 200 });
		}

		if (request.method === 'GET' && pathname === '/api/status') {
			const [{ results: monitors }, { results: rules }] = await Promise.all([
				env.DB.prepare(
					`SELECT m.id, m.name, m.type, m.mode, m.visibility,
					        m.scrape_url, m.interval_seconds, m.enabled,
					        m.created_at, m.updated_at,
					        ms.status, ms.last_check_at, ms.last_success_at,
					        ms.consecutive_failures, ms.consecutive_successes,
					        ms.active_incident_id
					 FROM monitors m
					 LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
					 WHERE m.enabled = 1
					 ORDER BY m.name`,
				).all<MonitorDbRow>(),
				env.DB.prepare(
					`SELECT id, monitor_id, condition, threshold, severity,
					        failure_count, recovery_count, cooldown_seconds, enabled
					 FROM alert_rules
					 ORDER BY monitor_id`,
				).all<AlertRuleDbRow>(),
			]);
			const snapshot = await fetchUsage(runtimeEnv);
			const rulesByMonitor = new Map<string, AlertRuleDbRow[]>();
			for (const rule of rules) {
				const list = rulesByMonitor.get(rule.monitor_id) ?? [];
				list.push(rule);
				rulesByMonitor.set(rule.monitor_id, list);
			}
			return Response.json({
				d1: snapshot.d1,
				d1Percent: snapshot.d1Percent,
				workers: snapshot.workers,
				usageResetsIn: usageResetsIn(Date.now()),
				monitors: monitors.map((m) => ({
					id: m.id,
					name: m.name,
					type: m.type,
					mode: m.mode,
					visibility: m.visibility,
					target: m.scrape_url,
					interval_seconds: m.interval_seconds,
					enabled: m.enabled === 1,
					created_at: m.created_at,
					updated_at: m.updated_at,
					state: {
						status: m.status ?? 'unknown',
						last_check_at: m.last_check_at,
						last_success_at: m.last_success_at,
						consecutive_failures: m.consecutive_failures ?? 0,
						consecutive_successes: m.consecutive_successes ?? 0,
						active_incident_id: m.active_incident_id,
					},
					alert_rules: (rulesByMonitor.get(m.id) ?? []).map((r) => ({
						id: r.id,
						condition: r.condition,
						threshold: r.threshold,
						severity: r.severity,
						failure_count: r.failure_count,
						recovery_count: r.recovery_count,
						cooldown_seconds: r.cooldown_seconds,
						enabled: r.enabled === 1,
					})),
				})),
			}, { headers: { 'Cache-Control': 'no-store' } });
		}

		if (request.method !== 'GET' || pathname !== '/') {
			return new Response(null, { status: 404 });
		}

		const nowMs = Date.now();
		const [
			{ results: monitors },
			{ results: uptimeDays },
			{ results: latencyPoints },
			{ results: activeIncidents },
			{ results: recentIncidents },
			d1Usage,
		] = await Promise.all([
			env.DB.prepare(
				`SELECT m.id, m.name, m.type, m.mode, m.visibility,
				        m.scrape_url, m.interval_seconds, m.enabled,
				        m.created_at, m.updated_at,
				        ms.status, ms.last_check_at, ms.last_success_at,
				        ms.consecutive_failures, ms.consecutive_successes,
				        ms.active_incident_id
				 FROM monitors m
				 LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
				 WHERE m.enabled = 1
				 ORDER BY m.name`,
			).all<MonitorDbRow>(),
			env.DB.prepare(
				`SELECT monitor_id, date(recorded_at) AS day, AVG(availability) AS avg_up
				 FROM metric_series
				 WHERE recorded_at >= date('now', '-90 days')
				 GROUP BY monitor_id, day
				 ORDER BY monitor_id, day`,
			).all<UptimeDayRow>(),
			env.DB.prepare(
				`SELECT monitor_id, latency_ms
				 FROM metric_series
				 WHERE recorded_at >= datetime('now', '-24 hours') AND latency_ms IS NOT NULL
				 ORDER BY monitor_id, recorded_at`,
			).all<LatencyRow>(),
			env.DB.prepare(
				`SELECT id, monitor_id, severity, started_at, reason
				 FROM incidents WHERE status = 'open'
				 ORDER BY started_at DESC`,
			).all<IncidentRow>(),
			env.DB.prepare(
				`SELECT i.id, i.monitor_id, i.severity, i.started_at, i.resolved_at, i.reason, m.name AS monitor_name
				 FROM incidents i JOIN monitors m ON m.id = i.monitor_id
				 WHERE i.status = 'resolved'
				 ORDER BY i.resolved_at DESC LIMIT 5`,
			).all<IncidentRow>(),
			fetchUsage(runtimeEnv),
		]);

		return new Response(
			buildStatusPage({ nowMs, monitors, uptimeDays, latencyPoints, activeIncidents, recentIncidents, d1Usage }),
			{ headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
		);
	},

	async scheduled(event, env, ctx): Promise<void> {
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
	},

	async queue(batch: MessageBatch<NotificationMessage>, env: Env): Promise<void> {
		const now = new Date().toISOString();
		await Promise.allSettled(
			batch.messages.map(async (msg) => {
				const { incidentId, monitorId, monitorName, eventType, count, error } = msg.body;
				const channels = await fetchNotificationChannels(env, monitorId);
				const text =
					eventType === 'down'
						? `🔴 **${monitorName} is DOWN** — ${count} consecutive failure${count !== 1 ? 's' : ''}${error ? `: ${error}` : ''}`
						: `🟢 **${monitorName} recovered** — back up after ${count} successful check${count !== 1 ? 's' : ''}`;
				await Promise.allSettled(channels.map((ch) => sendToChannel(env, ch, incidentId, text, now)));
				msg.ack();
			}),
		);
	},
} satisfies ExportedHandler<Env>;
