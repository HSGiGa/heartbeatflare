// Result store + alert evaluator. storeResult() persists each check within the D1 Free Plan
// write budget (~2 writes/check steady-state); evaluateAlerts() turns results into incidents
// and enqueues notifications.
import { log } from './log';
import type { MonitorRow, ProbeResult, AlertRuleDbRow, NotificationMessage, ActiveIncident } from './types';

// Metric-class sentinel for connectivity rules (alert_rules.metric_name IS NULL).
export const CONNECTIVITY_CLASS = '__connectivity__';

const upsertHourlySql = `
	INSERT INTO uptime_hourly (monitor_id, hour, total_checks, up_checks, avg_latency_ms, latency_count)
	VALUES (?, ?, 1, ?, ?, ?)
	ON CONFLICT(monitor_id, hour) DO UPDATE SET
	  total_checks   = total_checks + 1,
	  up_checks      = up_checks + excluded.up_checks,
	  latency_count  = latency_count + excluded.latency_count,
	  avg_latency_ms = CASE WHEN excluded.avg_latency_ms IS NULL THEN avg_latency_ms
	                        WHEN avg_latency_ms IS NULL THEN excluded.avg_latency_ms
	                        ELSE (avg_latency_ms * latency_count + excluded.avg_latency_ms) / (latency_count + excluded.latency_count)
	                   END`;

/**
 * Persists one check result in a single D1 batch, minimising writes (Free Plan: 100k/day):
 * always 2 (monitor_state upsert + uptime_hourly upsert); metric_series only when actionable
 * (failure, status transition, or first sample of the hour); monitor_executions only on
 * status change or failure. Returns the updated consecutive counters for alert evaluation.
 */
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
	const hour = now.slice(0, 13);  // YYYY-MM-DDTHH

	// Only update SSL columns when values actually changed — certs renew a few times per year at most
	const bindSslNotAfter = result.ssl_not_after != null && result.ssl_not_after !== monitor.ssl_not_after
		? result.ssl_not_after
		: null;
	const bindSslIssuer = result.ssl_issuer != null && result.ssl_issuer !== monitor.ssl_issuer
		? result.ssl_issuer
		: null;

	// Only write a raw metric_series row when actionable: failure, transition, or first sample of the hour
	const writeMetric =
		result.status === 'down' ||
		result.status !== prevStatus ||
		now.slice(0, 13) !== (monitor.last_check_at ?? '').slice(0, 13);

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
		).bind(monitor.id, result.status, now, result.status === 'up' ? now : null, failures, successes, bindSslNotAfter, bindSslIssuer),
		env.DB.prepare(upsertHourlySql).bind(monitor.id, hour, upVal, lat, lat !== null ? 1 : 0),
	];

	if (writeMetric) {
		statements.push(
			env.DB.prepare(
				`INSERT INTO metric_series (id, monitor_id, recorded_at, availability, latency_ms, tcp_connect_ms)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).bind(executionId, monitor.id, now, upVal, result.latency_ms, result.tcp_connect_ms ?? null),
		);
	}

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

/**
 * Records a missed-heartbeat sample (push monitors). Unlike storeResult it deliberately does NOT
 * update last_check_at: for a heartbeat that column holds the time of the last beat *received* —
 * the reference point the scheduler uses to detect the next miss — and the cron evaluation must not
 * move it. `missed` is the number of elapsed intervals with no beat and becomes consecutive_failures
 * directly (the scheduler only calls this once per newly-missed interval, see scheduler.ts).
 */
export async function storeHeartbeatMiss(env: Env, monitor: MonitorRow, missed: number, executionId: string, now: string): Promise<void> {
	const hour = now.slice(0, 13);
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO monitor_state (monitor_id, status, consecutive_failures, consecutive_successes)
			 VALUES (?, 'down', ?, 0)
			 ON CONFLICT(monitor_id) DO UPDATE SET
			   status = 'down',
			   consecutive_failures = excluded.consecutive_failures,
			   consecutive_successes = 0`,
		).bind(monitor.id, missed),
		env.DB.prepare(upsertHourlySql).bind(monitor.id, hour, 0, null, 0),
		env.DB.prepare(
			`INSERT INTO metric_series (id, monitor_id, recorded_at, availability, latency_ms, tcp_connect_ms)
			 VALUES (?, ?, ?, 0, 0, NULL)`,
		).bind(executionId, monitor.id, now),
		env.DB.prepare(
			`INSERT INTO monitor_executions (id, monitor_id, started_at, completed_at, status, latency_ms, error)
			 VALUES (?, ?, ?, ?, 'down', 0, 'Heartbeat missed')`,
		).bind(executionId, monitor.id, now, now),
	]);
}

/**
 * Evaluates alert rules against a check result. Connectivity (metric_name IS NULL) and
 * metric-class incidents (e.g. ssl_expiry) are tracked independently: an open SSL incident
 * no longer suppresses a connectivity down-incident, and vice versa.
 *
 * `activeByClass` maps a metric class → its open incident, derived once per scheduler tick
 * from the incidents table (single source of truth). The connectivity class uses the
 * CONNECTIVITY_CLASS sentinel. `monitor_state.active_incident_id` is kept updated as a
 * denormalised hint for the active *connectivity* incident only; SSL incidents do not touch it.
 *
 * Writers: the scheduler (one evaluation per monitor per tick) and — for `heartbeat` monitors only —
 * the beat endpoint in heartbeat.ts (recovery on an incoming beat). The two never act on the same
 * monitor in the same instant in practice; the only shared-state hazard is `consecutive_successes`
 * for heartbeat recovery_count > 1 under concurrent beats, which may under/over-count by one — an
 * accepted trade-off for a push monitor. Probe-based monitors remain single-writer (scheduler only).
 */
export async function evaluateAlerts(
	env: Env,
	monitor: MonitorRow,
	result: ProbeResult,
	newFailures: number,
	newSuccesses: number,
	now: string,
	rules: AlertRuleDbRow[],
	activeByClass: Map<string, ActiveIncident>,
): Promise<void> {
	const connInc = activeByClass.get(CONNECTIVITY_CLASS);
	const sslInc = activeByClass.get('ssl_expiry');

	// --- Connectivity incidents (metric_name IS NULL) ---
	for (const rule of rules) {
		if (rule.metric_name) continue; // metric-specific rules handled separately below

		if (result.status === 'down' && newFailures >= rule.failure_count && !connInc) {
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
			// Atomic: incident row + state hint in one batch, notification only after it commits
			await env.DB.batch([
				env.DB.prepare(
					`INSERT INTO incidents (id, monitor_id, alert_rule_id, status, severity, started_at, last_notified_at, reason)
					 VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`,
				).bind(incidentId, monitor.id, rule.id, rule.severity, now, now, result.error ?? null),
				env.DB.prepare(`UPDATE monitor_state SET active_incident_id = ? WHERE monitor_id = ?`).bind(incidentId, monitor.id),
			]);
			log('info', 'incident.open', { monitorId: monitor.id, incidentId, severity: rule.severity, class: CONNECTIVITY_CLASS });
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

		if (result.status === 'up' && newSuccesses >= rule.recovery_count && connInc) {
			const incidentId = connInc.id;
			await env.DB.batch([
				env.DB.prepare(`UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?`).bind(now, incidentId),
				env.DB.prepare(`UPDATE monitor_state SET active_incident_id = NULL WHERE monitor_id = ?`).bind(monitor.id),
			]);
			log('info', 'incident.resolved', { monitorId: monitor.id, incidentId, class: CONNECTIVITY_CLASS });
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

	// --- SSL-expiry incidents (metric_name = 'ssl_expiry'), fully independent of connectivity ---
	if (result.ssl_days_left !== undefined) {
		const sslRules = rules
			.filter((r) => r.metric_name === 'ssl_expiry' && r.condition === 'lt')
			.sort((a, b) => a.threshold - b.threshold); // ascending: smallest threshold (critical) matches first

		if (sslInc) {
			// Recovery: close the SSL incident once the cert no longer triggers any rule
			const stillTriggered = sslRules.some((r) => result.ssl_days_left! < r.threshold);
			if (!stillTriggered) {
				await env.DB.prepare(`UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?`).bind(now, sslInc.id).run();
				log('info', 'incident.resolved', { monitorId: monitor.id, incidentId: sslInc.id, class: 'ssl_expiry' });
				await (env.NOTIFICATION_QUEUE as Queue<NotificationMessage>).send({
					incidentId: sslInc.id,
					monitorId: monitor.id,
					monitorName: monitor.name,
					eventType: 'recovered',
					count: newSuccesses,
				});
			}
		} else {
			// Creation: open an SSL incident at the highest matching severity
			for (const rule of sslRules) {
				if (result.ssl_days_left < rule.threshold) {
					const reason =
						result.ssl_days_left <= 0
							? 'SSL certificate has expired'
							: `SSL cert expires in ${result.ssl_days_left} day(s)`;
					const incidentId = crypto.randomUUID();
					await env.DB.prepare(
						`INSERT INTO incidents (id, monitor_id, alert_rule_id, status, severity, started_at, reason)
						 VALUES (?, ?, ?, 'open', ?, ?, ?)`,
					).bind(incidentId, monitor.id, rule.id, rule.severity, now, reason).run();
					log('info', 'incident.open', { monitorId: monitor.id, incidentId, severity: rule.severity, class: 'ssl_expiry' });
					await (env.NOTIFICATION_QUEUE as Queue<NotificationMessage>).send({
						incidentId,
						monitorId: monitor.id,
						monitorName: monitor.name,
						eventType: 'down',
						count: 1,
						error: reason,
					});
					break;
				}
			}
		}
	}
}
