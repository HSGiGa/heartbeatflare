import type { AuthConfigDbRow, ResolvedAuthConfig, Session } from './types';

let cachedAuthConfig: ResolvedAuthConfig | null = null;
let cachedAuthConfigUntil = 0;
const AUTH_CONFIG_TTL_MS = 300_000;

export async function resolveAuthConfig(env: Env): Promise<ResolvedAuthConfig | null> {
	if (Date.now() < cachedAuthConfigUntil) return cachedAuthConfig;

	const row = await env.DB.prepare(
		`SELECT provider, team_domain, aud FROM auth_config WHERE id = 'default' AND enabled = 1`,
	).first<AuthConfigDbRow>();

	if (!row) {
		cachedAuthConfig = null;
		cachedAuthConfigUntil = Date.now() + AUTH_CONFIG_TTL_MS;
		return null;
	}

	const aud = resolveEnvRef(row.aud, env);
	if (!aud) {
		console.error('[auth] Cannot resolve aud ref:', row.aud);
		cachedAuthConfig = null;
		cachedAuthConfigUntil = Date.now() + AUTH_CONFIG_TTL_MS;
		return null;
	}

	cachedAuthConfig = { provider: 'cloudflare_access', team_domain: row.team_domain, aud };
	cachedAuthConfigUntil = Date.now() + AUTH_CONFIG_TTL_MS;
	return cachedAuthConfig;
}

function resolveEnvRef(ref: string, env: Env): string | null {
	const m = ref.match(/^\$\{([A-Z0-9_]+)\}$/);
	if (!m) return ref;
	const val = (env as unknown as Record<string, unknown>)[m[1]];
	return typeof val === 'string' ? val : null;
}

type JwkKey = { kid?: string; kty: string; n: string; e: string; alg?: string };

async function getVerifiedPayload(jwt: string, authConfig: ResolvedAuthConfig): Promise<Session | null> {
	const parts = jwt.split('.');
	if (parts.length !== 3) return null;

	try {
		const b64 = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/');
		const header = JSON.parse(atob(b64(parts[0]))) as { kid?: string; alg?: string };
		const payload = JSON.parse(atob(b64(parts[1]))) as {
			aud?: string | string[];
			exp?: number;
			sub?: string;
			email?: string;
			name?: string;
		};

		const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud ?? ''];
		if (!aud.includes(authConfig.aud)) return null;

		if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;

		const certsUrl = `https://${authConfig.team_domain}.cloudflareaccess.com/cdn-cgi/access/certs`;
		const cache = caches.default;
		let certsRes = await cache.match(certsUrl);
		if (!certsRes) {
			certsRes = await fetch(certsUrl);
			if (!certsRes.ok) throw new Error(`Failed to fetch CF certs: ${certsRes.status}`);
			const cached = new Response(certsRes.clone().body, certsRes);
			cached.headers.set('Cache-Control', 'public, max-age=3600');
			await cache.put(certsUrl, cached);
			certsRes = cached;
		}

		const { keys } = (await certsRes.clone().json()) as { keys: JwkKey[] };
		const jwk = (header.kid ? keys.find((k) => k.kid === header.kid) : undefined) ?? keys[0];
		if (!jwk) return null;

		const cryptoKey = await crypto.subtle.importKey('jwk', jwk as JsonWebKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
		const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
		const sig = Uint8Array.from(atob(b64(parts[2])), (c) => c.charCodeAt(0));
		const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sig, signingInput);
		if (!valid) return null;

		return {
			email: payload.email ?? payload.sub ?? '',
			name: payload.name ?? payload.email ?? payload.sub ?? '',
		};
	} catch {
		return null;
	}
}

export async function getAuth(request: Request, env: Env): Promise<{ session: Session | null; authEnabled: boolean }> {
	const authConfig = await resolveAuthConfig(env);
	if (!authConfig) return { session: null, authEnabled: false };

	const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
	if (!jwt) return { session: null, authEnabled: true };

	const session = await getVerifiedPayload(jwt, authConfig);
	return { session, authEnabled: true };
}

export function handleLogout(request: Request, _authConfig: ResolvedAuthConfig): Response {
	const origin = new URL(request.url).origin;
	return new Response(null, {
		status: 302,
		headers: {
			Location: origin + '/public',
			// Clear the CF Access cookie so subsequent requests are unauthenticated
			'Set-Cookie': 'CF_Authorization=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None',
		},
	});
}

export function _invalidateAuthCache(): void {
	cachedAuthConfig = null;
	cachedAuthConfigUntil = 0;
}
