// Structured JSON logging for Cloudflare Workers Logs (the primary runtime log sink — runtime
// logs are NOT written to D1, to preserve the Free Plan write budget). Each call emits one JSON
// line that Workers Logs indexes by field. Level is set once per invocation via configureLogging()
// from the LOG_LEVEL var (default 'info'); debug events (successful checks, probe timings) are
// suppressed unless LOG_LEVEL=debug.
//
// Policy — always log: scheduler.tick, check.failed/check.error, incident.*, notification failures,
// auth/config errors. Never log: per-request public traffic, secrets or full webhook URLs.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Module-scoped threshold. Isolates are single-threaded and reused, so setting this at each
// entry point (configureLogging) is safe and avoids threading a logger through every call.
let minLevel = ORDER.info;

export function configureLogging(env: Env): void {
	const raw = (env as unknown as Record<string, unknown>).LOG_LEVEL;
	const lvl = typeof raw === 'string' ? (raw.toLowerCase() as LogLevel) : undefined;
	minLevel = lvl && lvl in ORDER ? ORDER[lvl] : ORDER.info;
}

export function log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
	if (ORDER[level] < minLevel) return;
	const line = JSON.stringify({ level, event, ...fields });
	if (level === 'error') console.error(line);
	else if (level === 'warn') console.warn(line);
	else console.log(line);
}

// Test-only: restore the default threshold between cases.
export function _resetLogLevel(): void {
	minLevel = ORDER.info;
}
