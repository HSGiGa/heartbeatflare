// Workers VPC config helpers (Issue #18). Pure (no Node/SDK deps) so it runs in the Workers vitest
// pool alongside the source tests, mirroring scripts/lib/probe-headers.ts.
//
// heartbeatflare only *consumes* pre-existing Cloudflare Workers VPC resources by id/binding — it
// never provisions Networks, Services, or Tunnels. Cloudflare Mesh (network_id: cf1:network) is
// intentionally unsupported in v1: tunnel-backed networks only.
//
// VPC resource ids carry ${VAR} placeholders resolved at GENERATION time (baked into the gitignored
// wrangler.jsonc). This differs from PROBE_HEADERS, which preserves ${VAR} for runtime secret
// resolution — a wrangler *binding* needs a literal id at deploy time and cannot be populated from a
// Worker secret.

export interface VpcNetwork {
	binding: string;
	tunnel_id?: string;
	// network_id is typed only so it can be detected and rejected (Cloudflare Mesh, out of scope v1).
	network_id?: string;
	remote?: boolean;
}

export interface VpcService {
	binding: string;
	service_id?: string;
	remote?: boolean;
}

export interface VpcConfig {
	networks?: VpcNetwork[];
	services?: VpcService[];
}

// Wrangler binding output shapes (what lands in wrangler.jsonc).
export interface VpcNetworkBinding {
	binding: string;
	tunnel_id: string;
	remote: boolean;
}
export interface VpcServiceBinding {
	binding: string;
	service_id: string;
	remote: boolean;
}

const VAR_RE = /\$\{([A-Z0-9_]+)\}/g;

// Validates the shape of deploy.vpc, throwing a clear message on the first problem: every entry needs
// a binding; binding names must be unique across both arrays; networks require tunnel_id and must not
// use network_id (mesh); services require service_id.
export function validateVpcConfig(vpc: VpcConfig): void {
	const seen = new Set<string>();
	const claimBinding = (binding: string | undefined, where: string): void => {
		if (!binding) throw new Error(`deploy.vpc.${where} has an entry without a "binding".`);
		if (seen.has(binding)) {
			throw new Error(`deploy.vpc binding "${binding}" is declared more than once — binding names must be unique across networks and services.`);
		}
		seen.add(binding);
	};
	for (const n of vpc.networks ?? []) {
		claimBinding(n.binding, 'networks');
		if (n.network_id) {
			throw new Error(`deploy.vpc.networks "${n.binding}" sets network_id — Cloudflare Mesh / network_id is unsupported in v1. Use tunnel_id.`);
		}
		if (!n.tunnel_id) throw new Error(`deploy.vpc.networks "${n.binding}" requires "tunnel_id".`);
	}
	for (const s of vpc.services ?? []) {
		claimBinding(s.binding, 'services');
		if (!s.service_id) throw new Error(`deploy.vpc.services "${s.binding}" requires "service_id".`);
	}
}

// Enforces the mode: internal monitor contract (Issue #18). The JSON schema is editor-only, so these
// are the real hard rejects, run at config import. v1: internal monitors probe via a VPC binding, are
// http/tcp only, and skip SSL. External monitors must not carry a vpc_binding.
export function validateMonitorVpc(
	monitor: { name: string; type: string; mode: string; ssl?: boolean; vpc_binding?: string },
	vpcBindings: Set<string>,
): void {
	if (monitor.mode === 'external') {
		if (monitor.vpc_binding) throw new Error(`Monitor "${monitor.name}" is mode: external but sets vpc_binding — VPC bindings are only for mode: internal.`);
		return;
	}
	if (!['http', 'tcp'].includes(monitor.type)) {
		throw new Error(`Monitor "${monitor.name}" is mode: internal with type ${monitor.type} — only http and tcp are supported for internal monitors in v1.`);
	}
	if (monitor.ssl === true) {
		throw new Error(`Monitor "${monitor.name}" is mode: internal with ssl: true — internal SSL expiry checks are unsupported in v1; set ssl: false or omit it.`);
	}
	if (!monitor.vpc_binding) throw new Error(`Monitor "${monitor.name}" is mode: internal but has no vpc_binding — set it to a deploy.vpc network/service binding name.`);
	if (!vpcBindings.has(monitor.vpc_binding)) {
		const known = [...vpcBindings].join(', ') || '(none configured)';
		throw new Error(`Monitor "${monitor.name}" references vpc_binding "${monitor.vpc_binding}" which is not declared under deploy.vpc. Known bindings: ${known}.`);
	}
}

// The set of all binding names declared under deploy.vpc, for cross-validating monitor vpc_binding.
export function collectVpcBindingNames(vpc: VpcConfig | undefined): Set<string> {
	const names = new Set<string>();
	for (const n of vpc?.networks ?? []) if (n.binding) names.add(n.binding);
	for (const s of vpc?.services ?? []) if (s.binding) names.add(s.binding);
	return names;
}

// Resolves ${VAR} placeholders in a VPC id from env. Strict mode (deploy) throws if any referenced
// var is unset/empty; lenient mode (local) returns null so the caller omits the binding — local dev
// and tests must not fail just because private infrastructure ids are absent (mirrors how the D1 id
// is left empty locally).
export function resolveVpcId(raw: string, env: Record<string, string | undefined>, opts: { strict: boolean }): string | null {
	const missing: string[] = [];
	const value = raw.replace(VAR_RE, (_, name: string) => {
		const v = env[name];
		if (v === undefined || v === '') {
			missing.push(name);
			return '';
		}
		return v;
	});
	if (missing.length > 0) {
		if (opts.strict) throw new Error(`references unset env var(s): ${[...new Set(missing)].join(', ')}`);
		return null;
	}
	return value;
}

// Builds the vpc_networks / vpc_services wrangler binding arrays from deploy.vpc, resolving ${VAR}
// ids. In deploy mode an unset var fails generation; in local mode that binding is omitted (warnings
// are the caller's concern). Bindings default to remote:false because this flag controls Wrangler's
// local proxy, not the deployed Worker binding; opt in with remote:true when testing real VPC
// connectivity locally. Sections with no resolvable entries are omitted entirely.
export function buildVpcBindings(
	vpc: VpcConfig,
	env: Record<string, string | undefined>,
	opts: { isDeployMode: boolean },
): { vpc_networks?: VpcNetworkBinding[]; vpc_services?: VpcServiceBinding[] } {
	validateVpcConfig(vpc);
	const strict = opts.isDeployMode;

	const networks: VpcNetworkBinding[] = [];
	for (const n of vpc.networks ?? []) {
		let tunnel_id: string | null;
		try {
			tunnel_id = resolveVpcId(n.tunnel_id!, env, { strict });
		} catch (err) {
			throw new Error(`deploy.vpc.networks "${n.binding}" tunnel_id ${err instanceof Error ? err.message : String(err)}`);
		}
		if (tunnel_id === null) continue; // lenient: skip unresolved binding locally
		networks.push({ binding: n.binding, tunnel_id, remote: n.remote ?? false });
	}

	const services: VpcServiceBinding[] = [];
	for (const s of vpc.services ?? []) {
		let service_id: string | null;
		try {
			service_id = resolveVpcId(s.service_id!, env, { strict });
		} catch (err) {
			throw new Error(`deploy.vpc.services "${s.binding}" service_id ${err instanceof Error ? err.message : String(err)}`);
		}
		if (service_id === null) continue;
		services.push({ binding: s.binding, service_id, remote: s.remote ?? false });
	}

	const out: { vpc_networks?: VpcNetworkBinding[]; vpc_services?: VpcServiceBinding[] } = {};
	if (networks.length > 0) out.vpc_networks = networks;
	if (services.length > 0) out.vpc_services = services;
	return out;
}
