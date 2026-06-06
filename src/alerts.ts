import type { MonitorRow, ProbeResult, AlertRuleDbRow, NotificationMessage } from './types';

export async function storeResult(
	env: Env,
	monitor: MonitorRow,
	result: ProbeResult,
	executionId: string,
	now: string,
): Promise<{ newFailures: number; newSuccesses: number }> {
	const prevStatus = monitor.current_status ?? 'unknown';
	const failures = result.status === 'down' ? monitor.consecutive_failures + 1 : 0;
	const successes = result.status === 'up' ? monitor.consecutive_successes + 1 : 0;

	await env.DB.prepare(
		`INSERT INTO monitor_state (monitor_id, status, last_check_at, last_success_at, consecutive_failures, consecutive_successes)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(monitor_id) DO UPDATE SET
		   status = excluded.status,
		   last_check_at = excluded.last_check_at,
		   last_success_at = CASE WHEN excluded.status = 'up' THEN excluded.last_check_at ELSE last_success_at END,
		   consecutive_failures = excluded.consecutive_failures,
		   consecutive_successes = excluded.consecutive_successes`,
	)
		.bind(monitor.id, result.status, now, result.status === 'up' ? now : null, failures, successes)
		.run();

	await env.DB.prepare(
		`INSERT INTO metric_series (id, monitor_id, recorded_at, availability, latency_ms, tcp_connect_ms)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(executionId, monitor.id, now, result.status === 'up' ? 1 : 0, result.latency_ms, result.tcp_connect_ms ?? null)
		.run();

	if (result.status !== prevStatus || result.status === 'down') {
		await env.DB.prepare(
			`INSERT INTO monitor_executions (id, monitor_id, started_at, completed_at, status, latency_ms, error)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(executionId, monitor.id, now, now, result.status, result.latency_ms, result.error ?? null)
			.run();
	}

	return { newFailures: failures, newSuccesses: successes };
}

export async function evaluateAlerts(
	env: Env,
	monitor: MonitorRow,
	result: ProbeResult,
	newFailures: number,
	newSuccesses: number,
	now: string,
): Promise<void> {
	const { results: rules } = await env.DB.prepare(
		`SELECT id, monitor_id, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled
		 FROM alert_rules
		 WHERE monitor_id = ? AND enabled = 1
		 ORDER BY failure_count ASC`,
	).bind(monitor.id).all<AlertRuleDbRow>();

	for (const rule of rules) {
		if (result.status === 'down' && newFailures >= rule.failure_count && !monitor.active_incident_id) {
			if (rule.cooldown_seconds > 0) {
				const last = await env.DB.prepare(
					`SELECT resolved_at FROM incidents WHERE monitor_id = ? AND status = 'resolved' ORDER BY resolved_at DESC LIMIT 1`,
				).bind(monitor.id).first<{ resolved_at: string }>();
				if (last?.resolved_at) {
					const elapsed = (new Date(now).getTime() - new Date(last.resolved_at).getTime()) / 1000;
					if (elapsed < rule.cooldown_seconds) break;
				}
			}
			const incidentId = crypto.randomUUID();
			await env.DB.prepare(
				`INSERT INTO incidents (id, monitor_id, alert_rule_id, status, severity, started_at, reason)
				 VALUES (?, ?, ?, 'open', ?, ?, ?)`,
			).bind(incidentId, monitor.id, rule.id, rule.severity, now, result.error ?? null).run();
			await env.DB.prepare(
				`UPDATE monitor_state SET active_incident_id = ? WHERE monitor_id = ?`,
			).bind(incidentId, monitor.id).run();
			await (env.NOTIFICATION_QUEUE as Queue<NotificationMessage>).send({
				incidentId,
				monitorId: monitor.id,
				monitorName: monitor.name,
				eventType: 'down',
				count: newFailures,
				error: result.error,
			});
			break;
		}

		if (result.status === 'up' && newSuccesses >= rule.recovery_count && monitor.active_incident_id) {
			const incidentId = monitor.active_incident_id;
			await env.DB.prepare(
				`UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?`,
			).bind(now, incidentId).run();
			await env.DB.prepare(
				`UPDATE monitor_state SET active_incident_id = NULL WHERE monitor_id = ?`,
			).bind(monitor.id).run();
			await (env.NOTIFICATION_QUEUE as Queue<NotificationMessage>).send({
				incidentId,
				monitorId: monitor.id,
				monitorName: monitor.name,
				eventType: 'recovered',
				count: newSuccesses,
			});
			break;
		}
	}
}
