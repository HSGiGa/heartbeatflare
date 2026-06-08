import { connect } from 'cloudflare:sockets';
import type { ProbeResult } from './types';

export async function httpCheck(url: string, sslCheck: boolean): Promise<ProbeResult> {
	const start = Date.now();
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
		const latency_ms = Date.now() - start;
		if (res.ok) return { status: 'up', latency_ms };
		return { status: 'down', latency_ms, error: `HTTP ${res.status}` };
	} catch (err) {
		const latency_ms = Date.now() - start;
		const msg = err instanceof Error ? err.message : String(err);
		const isSsl = sslCheck && /ssl|certificate|tls/i.test(msg);
		return { status: 'down', latency_ms, ssl_error: isSsl || undefined, error: msg };
	}
}

// Checks the live TLS certificate via ssl-checker.io (port 443 by default).
// Falls back to crt.sh CT logs if ssl-checker.io fails.
// Both are cached in Workers Cache API for 6h.
export async function sslProbe(hostname: string): Promise<{ daysLeft: number; notAfter: string; issuer: string } | null> {
	return (await sslCheckerIo(hostname)) ?? (await crtSh(hostname));
}

async function sslCheckerIo(hostname: string): Promise<{ daysLeft: number; notAfter: string; issuer: string } | null> {
	try {
		const url = `https://ssl-checker.io/api/v1/check/${encodeURIComponent(hostname)}`;
		const cache = caches.default;
		let res = await cache.match(url);
		if (!res) {
			const fresh = await fetch(url, { signal: AbortSignal.timeout(8_000) });
			if (!fresh.ok) return null;
			res = new Response(fresh.clone().body, fresh);
			res.headers.set('Cache-Control', 'public, max-age=21600');
			await cache.put(url, res.clone());
		}
		const data = (await res.json()) as {
			status: string;
			result?: { days_left: number; valid_till: string; issuer_o: string | null; issuer_cn: string };
		};
		if (data.status !== 'ok' || !data.result) return null;
		const { days_left, valid_till, issuer_o, issuer_cn } = data.result;
		return {
			daysLeft: days_left,
			notAfter: new Date(valid_till).toISOString(),
			issuer: issuer_o ?? issuer_cn ?? 'Unknown',
		};
	} catch {
		return null;
	}
}

async function crtSh(hostname: string): Promise<{ daysLeft: number; notAfter: string; issuer: string } | null> {
	try {
		const url = `https://crt.sh/?q=${encodeURIComponent(hostname)}&output=json`;
		const cache = caches.default;
		let res = await cache.match(url);
		if (!res) {
			const fresh = await fetch(url, { signal: AbortSignal.timeout(8_000) });
			if (!fresh.ok) return null;
			const body = await fresh.text();
			if (!body.trim().startsWith('[')) return null;
			res = new Response(body, fresh);
			res.headers.set('Cache-Control', 'public, max-age=21600');
			await cache.put(url, res.clone());
		}
		const certs = (await res.json()) as Array<{ not_after: string; issuer_name: string; common_name: string }>;
		if (!Array.isArray(certs) || certs.length === 0) return null;
		const now = Date.now();
		const best = certs
			.filter((c) => new Date(c.not_after + 'Z').getTime() > now)
			.sort((a, b) => new Date(b.not_after + 'Z').getTime() - new Date(a.not_after + 'Z').getTime())[0];
		if (!best) return null;
		const notAfterMs = new Date(best.not_after + 'Z').getTime();
		const daysLeft = Math.floor((notAfterMs - now) / 86_400_000);
		const issuerMatch = best.issuer_name.match(/O=([^,]+)/);
		return { daysLeft, notAfter: new Date(best.not_after + 'Z').toISOString(), issuer: issuerMatch?.[1]?.trim() ?? 'Unknown' };
	} catch {
		return null;
	}
}

function parseTcpTarget(target: string): { hostname: string; port: number } {
	const normalized = target.startsWith('tcp://') ? target : `tcp://${target}`;
	const url = new URL(normalized);
	const port = Number(url.port);
	if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid TCP target: ${target}`);
	}
	return { hostname: url.hostname, port };
}

function parseDnsTarget(target: string): { hostname: string; recordType: string } {
	const [hostname, recordType = 'A'] = target.split('/');
	if (!hostname) throw new Error(`Invalid DNS target: ${target}`);
	return { hostname, recordType: recordType.toUpperCase() };
}

export async function dnsCheck(target: string): Promise<ProbeResult> {
	const start = Date.now();
	try {
		const { hostname, recordType } = parseDnsTarget(target);
		const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${recordType}`;
		const res = await fetch(url, {
			headers: { Accept: 'application/dns-json' },
			signal: AbortSignal.timeout(10_000),
		});
		const latency_ms = Date.now() - start;
		if (!res.ok) return { status: 'down', latency_ms, error: `DoH HTTP ${res.status}` };
		const body = (await res.json()) as { Status: number; Answer?: unknown[] };
		if (body.Status === 0 && body.Answer?.length) return { status: 'up', latency_ms };
		return { status: 'down', latency_ms, error: `DNS status ${body.Status}` };
	} catch (err) {
		return { status: 'down', latency_ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function tcpCheck(target: string): Promise<ProbeResult> {
	const start = Date.now();
	let socket: Socket | undefined;
	try {
		const { hostname, port } = parseTcpTarget(target);
		socket = connect({ hostname, port });
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			socket.opened,
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error('TCP connect timeout')), 10_000);
			}),
		]).finally(() => clearTimeout(timeoutId ?? null));
		const latency_ms = Date.now() - start;
		return { status: 'up', latency_ms, tcp_connect_ms: latency_ms };
	} catch (err) {
		const latency_ms = Date.now() - start;
		return {
			status: 'down',
			latency_ms,
			tcp_connect_ms: latency_ms,
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		socket?.close();
	}
}
