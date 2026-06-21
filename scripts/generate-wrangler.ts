// Generates wrangler.jsonc from wrangler.template.jsonc + config.yaml + env vars.
// Called automatically by dev, test, deploy, and related npm scripts.
//
// Modes:
//   --mode=local   (default) IDs may be empty; Wrangler uses local SQLite for D1.
//   --mode=deploy  CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required; the D1 id is
//                  resolved by name (<name>-prod-db) via the API — provision must have run first.

import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import Cloudflare from 'cloudflare';
import { loadConfig, resolveDeploy, resolveEnv, type DeployConfig } from './lib/deploy-config';
import { findDatabaseId } from './lib/d1';
import { buildEmailBinding, collectEmailChannels, type EmailBindingConfig, type EmailChannelConfig } from './lib/email';
import { buildProbeHeadersMap, type MonitorHeaders } from './lib/probe-headers';
import { buildVpcBindings, type VpcNetworkBinding, type VpcServiceBinding } from './lib/vpc';

const isDeployMode = process.argv.includes('--mode=deploy');

function fail(msg: string): never {
	console.error(`generate-wrangler: ${msg}`);
	process.exit(1);
}

interface WranglerTemplate {
	name: string;
	main: string;
	compatibility_date: string;
	compatibility_flags: string[];
	workers_dev: boolean;
	routes?: { pattern: string; custom_domain: boolean }[];
	observability: { enabled: boolean; head_sampling_rate?: number };
	vars: Record<string, string>;
	triggers: { crons: string[] };
	d1_databases: { binding: string; database_name: string; database_id: string; migrations_dir: string }[];
	queues: {
		producers: { queue: string; binding: string }[];
		consumers: { queue: string; max_batch_size: number; max_batch_timeout: number; max_retries: number }[];
	};
	send_email?: EmailBindingConfig[];
	vpc_networks?: VpcNetworkBinding[];
	vpc_services?: VpcServiceBinding[];
	// Preserved as-is from the template (heartbeat endpoint rate limiters); not generated.
	ratelimits?: { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
}

async function main() {
	const config = loadConfig<{ deploy?: DeployConfig; site?: { title?: string }; monitors?: MonitorHeaders[]; notification_channels?: EmailChannelConfig[] }>();
	const { name, domain, databaseName, queueName } = resolveDeploy(config);

	// Generated PROBE_HEADERS var (feature: WAF-safe monitoring). buildProbeHeadersMap throws if a
	// non-http monitor carries headers — surface that as a generation failure.
	let probeHeaders: string;
	try {
		probeHeaders = JSON.stringify(buildProbeHeadersMap(config.monitors ?? []));
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}

	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';

	// Local mode leaves the D1 id empty (Wrangler uses local SQLite). Deploy mode resolves it by
	// name via the API — the database must already exist (run "npm run provision" first).
	let databaseId = '';
	if (isDeployMode) {
		if (!accountId) fail('CLOUDFLARE_ACCOUNT_ID env var is required in deploy mode.');
		const token = process.env.CLOUDFLARE_API_TOKEN;
		if (!token) fail('CLOUDFLARE_API_TOKEN env var is required in deploy mode.');
		const found = await findDatabaseId(new Cloudflare({ apiToken: token }), accountId, databaseName);
		if (!found) fail(`D1 database "${databaseName}" not found — run "npm run provision" first.`);
		databaseId = found;
	}

	const wrangler = parseJsonc(readFileSync('wrangler.template.jsonc', 'utf-8')) as WranglerTemplate;

	// Baked into the bundle so the status page footer can show the deployed version. Read from
	// package.json at generation time — stays in lockstep with the release commit.
	const appVersion = (JSON.parse(readFileSync('package.json', 'utf-8')) as { version?: string }).version ?? '';

	wrangler.name = name;
	// Preserve template vars (e.g. LOG_LEVEL) and overwrite only the generated ones.
	wrangler.vars = {
		...wrangler.vars,
		CLOUDFLARE_ACCOUNT_ID: accountId,
		D1_DATABASE_ID: databaseId,
		WORKER_NAME: name,
		APP_VERSION: appVersion,
		SITE_TITLE: config.site?.title ?? '',
		PROBE_HEADERS: probeHeaders,
	};
	wrangler.d1_databases[0].database_name = databaseName;
	wrangler.d1_databases[0].database_id = databaseId;
	wrangler.queues.producers[0].queue = queueName;
	wrangler.queues.consumers[0].queue = queueName;

	const emailBinding = buildEmailBinding(collectEmailChannels(config));
	if (emailBinding) wrangler.send_email = [emailBinding];
	else delete wrangler.send_email;

	if (domain) {
		wrangler.routes = [{ pattern: domain, custom_domain: true }];
	} else {
		delete wrangler.routes;
	}

	// Workers VPC bindings (Issue #18): vpc_networks (tunnel-backed) and vpc_services. ${VAR} ids are
	// resolved here at generation time. Deploy mode fails fast on an unset var; local mode omits the
	// unresolved binding so dev/test never fail on absent private infrastructure ids.
	delete wrangler.vpc_networks;
	delete wrangler.vpc_services;
	if (config.deploy?.vpc) {
		let bindings: ReturnType<typeof buildVpcBindings>;
		try {
			// resolveEnv merges SECRETS_CONTEXT (GitHub Actions repo secrets) under process.env so VPC
			// ${VAR} ids resolve in CI, where individual secrets aren't exposed as discrete env vars.
			bindings = buildVpcBindings(config.deploy.vpc, resolveEnv(), { isDeployMode });
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err));
		}
		if (bindings.vpc_networks) {
			wrangler.vpc_networks = bindings.vpc_networks;
			// Emit tunnel IDs as vars so the runtime can query CF API for tunnel health status.
			wrangler.vars.VPC_NETWORK_IDS = JSON.stringify(
				bindings.vpc_networks.map((n) => ({ binding: n.binding, tunnel_id: n.tunnel_id })),
			);
		}
		if (bindings.vpc_services) {
			wrangler.vpc_services = bindings.vpc_services;
			// Emit service IDs as vars so the runtime can query CF API for VPC service health status.
			wrangler.vars.VPC_SERVICE_IDS = JSON.stringify(
				bindings.vpc_services.map((s) => ({ binding: s.binding, service_id: s.service_id })),
			);
		}
	}

	writeFileSync('wrangler.jsonc', JSON.stringify(wrangler, null, '\t') + '\n');
	console.log(`wrangler.jsonc generated (${isDeployMode ? 'deploy' : 'local'} mode)`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
