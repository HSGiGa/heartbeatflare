// Push-heartbeat endpoint: POST /beat/<monitor-id>/<token>. A monitored job calls this on each
// successful run; the scheduler opens an incident when beats stop arriving (see scheduler.ts).
//
// The handler is fail-closed and write-minimised: it rate-limits before any D1 access, validates
// the token against a Cloudflare Worker Secret (D1 stores only the `secret:<NAME>` reference, never
// the value), and skips the D1 write entirely while the monitor is already healthy and was beaten
// recently. Unknown monitor / bad token / missing secret all return 404 so the endpoint never
// reveals whether a given monitor id exists.
import { CONNECTIVITY_CLASS, evaluateAlerts, storeResult } from './alerts';
import { log } from './log';
import type { ActiveIncident, AlertRuleDbRow, MonitorRow } from './types';

const MAX_ID_LEN = 128;
const MAX_TOKEN_LEN = 256;

// Constant-time string compare to avoid leaking the token via response timing. A length mismatch
// returns early (lengths are not secret); equal-length inputs are compared byte-for-byte.
function timingSafeEqual(a: string, b: string): boolean {
	const enc = new TextEncoder();
	const ab = enc.encode(a);
	const bb = enc.encode(b);
	if (ab.length !== bb.length) return false;
	let diff = 0;
	for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
	return diff === 0;
}

type HeartbeatMonitorRow = MonitorRow & { heartbeat_token: string | null };

const notFound = () => new Response(null, { status: 404 });

export async function handleBeat(request: Request, env: Env): Promise<Response> {
	// Path: /beat/<id>/<token> — exactly two non-empty segments after /beat/.
	const { pathname } = new URL(request.url);
	const rest = pathname.slice('/beat/'.length);
	const slash = rest.indexOf('/');
	if (slash <= 0 || slash === rest.length - 1) return notFound();
	let id: string;
	let token: string;
	try {
		id = decodeURIComponent(rest.slice(0, slash));
		token = decodeURIComponent(rest.slice(slash + 1));
	} catch {
		return notFound();
	}
	if (!id || id.length > MAX_ID_LEN || id.includes('/') || token.length === 0 || token.length > MAX_TOKEN_LEN) return notFound();

	// Rate limit before touching D1: per source IP and per monitor id (best-effort, per-colo).
	const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
	const [ipLimit, monLimit] = await Promise.all([
		env.BEAT_IP_RATE_LIMITER.limit({ key: `beat-ip:${ip}` }),
		env.BEAT_MONITOR_RATE_LIMITER.limit({ key: `beat-monitor:${id}` }),
	]);
	if (!ipLimit.success || !monLimit.success) return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });

	const monitor = await env.DB.prepare(
		`SELECT m.id, m.name, m.type, m.scrape_url, m.interval_seconds, m.heartbeat_token,
		        COALESCE(m.ssl_check, 0) AS ssl_check,
		        ms.status AS current_status, ms.last_check_at,
		        COALESCE(ms.consecutive_failures, 0) AS consecutive_failures,
		        COALESCE(ms.consecutive_successes, 0) AS consecutive_successes,
		        ms.active_incident_id, ms.ssl_not_after, ms.ssl_issuer
		 FROM monitors m LEFT JOIN monitor_state ms ON ms.monitor_id = m.id
		 WHERE m.id = ? AND m.type = 'heartbeat' AND m.enabled = 1 AND m.paused = 0`,
	)
		.bind(id)
		.first<HeartbeatMonitorRow>();
	if (!monitor) return notFound();

	// Resolve the expected token from the Worker Secret named in `secret:<NAME>`.
	const ref = monitor.heartbeat_token ?? '';
	if (!ref.startsWith('secret:')) return notFound();
	const secretName = ref.slice('secret:'.length);
	const expected = (env as unknown as Record<string, string | undefined>)[secretName];
	if (!expected) {
		// Misconfiguration, not an attack: the monitor exists but its secret was never set on the
		// Worker. Log the (non-sensitive) name; never log the token or the beat URL.
		log('warn', 'heartbeat.secret_missing', { monitorId: id, secretName });
		return notFound();
	}
	if (!timingSafeEqual(token, expected)) return notFound();

	const now = new Date().toISOString();

	// Write throttle: while the monitor is healthy (up, no open connectivity incident) and was last
	// recorded within minWriteInterval, accept the beat without a D1 write. minWriteInterval is at
	// most interval/4, so the recorded last_check_at never lags enough to trip a false miss.
	const minWriteInterval = Math.max(10, Math.floor(monitor.interval_seconds / 4));
	const healthy = monitor.current_status === 'up' && monitor.active_incident_id == null;
	if (healthy && monitor.last_check_at) {
		const sinceMs = Date.now() - new Date(monitor.last_check_at).getTime();
		if (sinceMs < minWriteInterval * 1000) return new Response(null, { status: 204 });
	}

	// Record the beat as an 'up' sample and run recovery evaluation (closes a connectivity incident
	// once recovery_count successive beats arrive). Heartbeat is push-based, so latency is 0/unused.
	const { results: rules } = await env.DB.prepare(
		`SELECT id, monitor_id, metric_name, condition, threshold, severity,
		        failure_count, recovery_count, cooldown_seconds, escalation_seconds, enabled
		 FROM alert_rules WHERE monitor_id = ? AND metric_name IS NULL AND enabled = 1`,
	)
		.bind(id)
		.all<AlertRuleDbRow>();

	const activeByClass = new Map<string, ActiveIncident>();
	if (monitor.active_incident_id) activeByClass.set(CONNECTIVITY_CLASS, { id: monitor.active_incident_id, severity: '' });

	const { newFailures, newSuccesses } = await storeResult(env, monitor, { status: 'up', latency_ms: 0 }, crypto.randomUUID(), now);
	await evaluateAlerts(env, monitor, { status: 'up', latency_ms: 0 }, newFailures, newSuccesses, now, rules, activeByClass);

	return new Response(null, { status: 204 });
}
