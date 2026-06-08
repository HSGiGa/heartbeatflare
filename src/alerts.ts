import type { MonitorRow, ProbeResult, AlertRuleDbRow, NotificationMessage } from './types';

const upsertDailySql = `
	INSERT INTO uptime_daily (monitor_id, day, total_checks, up_checks, avg_latency_ms)
	VALUES (?, ?, 1, ?, ?)
	ON CONFLICT(monitor_id, day) DO UPDATE SET
	  total_checks   = total_checks + 1,
	  up_checks      = up_checks + excluded.up_checks,
	  avg_latency_ms = CASE WHEN excluded.avg_latency_ms IS NULL THEN avg_latency_ms
	                        WHEN avg_latency_ms IS NULL THEN excluded.avg_latency_ms
	                        ELSE (avg_latency_ms * total_checks + excluded.avg_latency_ms) / (total_checks + 1)
	                   END`;

const upsertHourlySql = `
	INSERT INTO uptime_hourly (monitor_id, hour, total_checks, up_checks, avg_latency_ms)
	VALUES (?, ?, 1, ?, ?)
	ON CONFLICT(monitor_id, hour) DO UPDATE SET
	  total_checks   = total_checks + 1,
	  up_checks      = up_checks + excluded.up_checks,
	  avg_latency_ms = CASE WHEN excluded.avg_latency_ms IS NULL THEN avg_latency_ms
	                        WHEN avg_latency_ms IS NULL THEN excluded.avg_latency_ms
	                        ELSE (avg_latency_ms * total_checks + excluded.avg_latency_ms) / (total_checks + 1)
	                   END`;

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
	const upVal = result.status === 'up' ? 1 : 0;
	const lat = result.latency_ms > 0 ? result.latency_ms : null;
	const day = now.slice(0, 10);   // YYYY-MM-DD
	const hour = now.slice(0, 13);  // YYYY-MM-DDTHH

	const statements: D1PreparedStatement[] = [
		env.DB.prepare(
			`INSERT INTO monitor_state (monitor_id, status, last_check_at, last_success_at, consecutive_failures, consecutive_successes, ssl_not_after, ssl_issuer)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(monitor_id) DO UPDATE SET
			   status = excluded.status,
			   last_check_at = excluded.last_check_at,
			   last_success_at = CASE WHEN excluded.status = 'up' THEN excluded.last_check_at ELSE last_success_at END,
			   consecutive_failures = excluded.consecutive_failures,
			   consecutive_successes = excluded.consecutive_successes,
			   ssl_not_after = COALESCE(excluded.ssl_not_after, ssl_not_after),
			   ssl_issuer    = COALESCE(excluded.ssl_issuer, ssl_issuer)`,
		).bind(monitor.id, result.status, now, result.status === 'up' ? now : null, failures, successes, result.ssl_not_after ?? null, result.ssl_issuer ?? null),
		env.DB.prepare(
			`INSERT INTO metric_series (id, monitor_id, recorded_at, availability, latency_ms, tcp_connect_ms, ssl_expiry_seconds)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(executionId, monitor.id, now, upVal, result.latency_ms, result.tcp_connect_ms ?? null, result.ssl_days_left != null ? result.ssl_days_left * 86_400 : null),
		env.DB.prepare(upsertDailySql).bind(monitor.id, day, upVal, lat),
		env.DB.prepare(upsertHourlySql).bind(monitor.id, hour, upVal, lat),
	];

	if (result.status !== prevStatus || result.status === 'down') {
		statements.push(
			env.DB.prepare(
				`INSERT INTO monitor_executions (id, monitor_id, started_at, completed_at, status, latency_ms, error)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).bind(executionId, monitor.id, now, now, result.status, result.latency_ms, result.error ?? null),
		);
	}

	await env.DB.batch(statements);

	return { newFailures: failures, newSuccesses: successes };
}

export async function evaluateAlerts(
	env: Env,
	monitor: MonitorRow,
	result: ProbeResult,
	newFailures: number,
	newSuccesses: number,
	now: string,
	preloadedRules?: AlertRuleDbRow[],
): Promise<void> {
	const rules = preloadedRules ?? (await env.DB.prepare(
		`SELECT id, monitor_id, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled
		 FROM alert_rules
		 WHERE monitor_id = ? AND enabled = 1
		 ORDER BY failure_count ASC`,
	).bind(monitor.id).all<AlertRuleDbRow>()).results;

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

	if (result.ssl_days_left !== undefined && !monitor.active_incident_id) {
		for (const rule of rules) {
			if (rule.condition === 'ssl_expiry' && result.ssl_days_left < rule.threshold) {
				const incidentId = crypto.randomUUID();
				await env.DB.prepare(
					`INSERT INTO incidents (id, monitor_id, alert_rule_id, status, severity, started_at, reason)
					 VALUES (?, ?, ?, 'open', ?, ?, ?)`,
				).bind(incidentId, monitor.id, rule.id, rule.severity, now, `SSL cert expires in ${result.ssl_days_left} day(s)`).run();
				await env.DB.prepare(
					`UPDATE monitor_state SET active_incident_id = ? WHERE monitor_id = ?`,
				).bind(incidentId, monitor.id).run();
				await (env.NOTIFICATION_QUEUE as Queue<NotificationMessage>).send({
					incidentId,
					monitorId: monitor.id,
					monitorName: monitor.name,
					eventType: 'down',
					count: 1,
					error: `SSL cert expires in ${result.ssl_days_left} day(s)`,
				});
				break;
			}
		}
	}
}
