// Generates wrangler.jsonc from wrangler.template.jsonc + config.yaml + env vars.
// Called automatically by dev, test, deploy, and related npm scripts.
//
// Modes:
//   --mode=local   (default) IDs may be empty; Wrangler uses local SQLite for D1.
//   --mode=deploy  CLOUDFLARE_ACCOUNT_ID and deploy.database_id are required.

import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { loadConfig } from './lib/deploy-config';

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
	observability: { enabled: boolean };
	vars: Record<string, string>;
	triggers: { crons: string[] };
	d1_databases: { binding: string; database_name: string; database_id: string; migrations_dir: string }[];
	queues: {
		producers: { queue: string; binding: string }[];
		consumers: { queue: string; max_batch_size: number; max_batch_timeout: number; max_retries: number }[];
	};
}

function main() {
	const config = loadConfig();
	const deploy = config.deploy;
	if (!deploy?.name) fail('deploy.name is required in config.yaml');

	const { name, domain, databaseName, queueName, databaseId } = {
		name: deploy.name,
		domain: deploy.domain,
		databaseName: deploy.database_name ?? `${deploy.name}-prod-db`,
		queueName: deploy.queue_name ?? `${deploy.name}-notifications`,
		databaseId: deploy.database_id ?? '',
	};

	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';

	if (isDeployMode) {
		if (!databaseId) fail('deploy.database_id is empty in config.yaml — run "npm run provision" first.');
		if (!accountId) fail('CLOUDFLARE_ACCOUNT_ID env var is required in deploy mode.');
	}

	const wrangler = parseJsonc(readFileSync('wrangler.template.jsonc', 'utf-8')) as WranglerTemplate;

	wrangler.name = name;
	wrangler.vars = { CLOUDFLARE_ACCOUNT_ID: accountId, D1_DATABASE_ID: databaseId };
	wrangler.d1_databases[0].database_name = databaseName;
	wrangler.d1_databases[0].database_id = databaseId;
	wrangler.queues.producers[0].queue = queueName;
	wrangler.queues.consumers[0].queue = queueName;

	if (domain) {
		wrangler.routes = [{ pattern: domain, custom_domain: true }];
	} else {
		delete wrangler.routes;
	}

	writeFileSync('wrangler.jsonc', JSON.stringify(wrangler, null, '\t') + '\n');
	console.log(`wrangler.jsonc generated (${isDeployMode ? 'deploy' : 'local'} mode)`);
}

main();
