import Cloudflare from 'cloudflare';
import { readFileSync, writeFileSync } from 'node:fs';
import { applyEdits, modify, type JSONPath } from 'jsonc-parser';
import { loadConfig, resolveDeploy, readWranglerConfig, requireEnv, type ResolvedDeploy } from './lib/deploy-config';

// Tabs to match the existing wrangler.jsonc formatting (Prettier: tabs)
const MODIFY_OPTIONS = { formattingOptions: { insertSpaces: false, tabSize: 1, eol: '\n' } };

function patch(text: string, path: JSONPath, value: unknown): string {
	return applyEdits(text, modify(text, path, value, MODIFY_OPTIONS));
}

async function ensureDatabase(client: Cloudflare, accountId: string, name: string): Promise<string> {
	for await (const db of client.d1.database.list({ account_id: accountId, name })) {
		if (db.name === name && db.uuid) {
			console.log(`D1 database found: ${name} (${db.uuid})`);
			return db.uuid;
		}
	}
	console.log(`Creating D1 database: ${name}`);
	const created = await client.d1.database.create({ account_id: accountId, name });
	if (!created.uuid) throw new Error(`D1 create returned no uuid for ${name}`);
	console.log(`D1 database created: ${name} (${created.uuid})`);
	return created.uuid;
}

async function ensureQueue(client: Cloudflare, accountId: string, name: string): Promise<void> {
	for await (const queue of client.queues.list({ account_id: accountId })) {
		if (queue.queue_name === name) {
			console.log(`Queue found: ${name}`);
			return;
		}
	}
	console.log(`Creating queue: ${name}`);
	await client.queues.create({ account_id: accountId, queue_name: name });
}

function updateWranglerConfig(deploy: ResolvedDeploy, accountId: string, databaseId: string): void {
	const previous = readWranglerConfig();
	let text = readFileSync('wrangler.jsonc', 'utf-8');

	text = patch(text, ['name'], deploy.name);

	if (deploy.domain) {
		if (previous.routes?.length) {
			text = patch(text, ['routes', 0, 'pattern'], deploy.domain);
			text = patch(text, ['routes', 0, 'custom_domain'], true);
		} else {
			text = patch(text, ['routes'], [{ pattern: deploy.domain, custom_domain: true }]);
		}
	} else if (previous.routes) {
		text = patch(text, ['routes'], undefined);
	}

	text = patch(text, ['vars', 'CLOUDFLARE_ACCOUNT_ID'], accountId);
	text = patch(text, ['vars', 'D1_DATABASE_ID'], databaseId);
	text = patch(text, ['d1_databases', 0, 'database_name'], deploy.databaseName);
	text = patch(text, ['d1_databases', 0, 'database_id'], databaseId);
	text = patch(text, ['queues', 'producers', 0, 'queue'], deploy.queueName);
	text = patch(text, ['queues', 'consumers', 0, 'queue'], deploy.queueName);

	writeFileSync('wrangler.jsonc', text);
	console.log('wrangler.jsonc updated.');
}

async function main() {
	const config = loadConfig();
	const deploy = resolveDeploy(config);

	if (process.argv.includes('--dry-run')) {
		console.log('Dry run — no API calls, no file writes.');
		console.log(`Worker name:   ${deploy.name}`);
		console.log(`Custom domain: ${deploy.domain ?? '(none — workers.dev only)'}`);
		console.log(`D1 database:   ${deploy.databaseName}`);
		console.log(`Queue:         ${deploy.queueName}`);
		console.log(
			'Managed wrangler.jsonc fields: name, routes, vars.CLOUDFLARE_ACCOUNT_ID, vars.D1_DATABASE_ID, d1_databases[0], queues.*.queue',
		);
		return;
	}

	const token = requireEnv('CLOUDFLARE_API_TOKEN');
	const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
	const client = new Cloudflare({ apiToken: token });

	const previousDb = readWranglerConfig().d1_databases?.find((d) => d.binding === 'DB');
	if (previousDb && previousDb.database_name !== deploy.databaseName) {
		console.warn(
			`WARNING: D1 database name changes from "${previousDb.database_name}" to "${deploy.databaseName}". ` +
				'A new empty database will be provisioned; existing data is not migrated.',
		);
	}

	const databaseId = await ensureDatabase(client, accountId, deploy.databaseName);
	await ensureQueue(client, accountId, deploy.queueName);

	updateWranglerConfig(deploy, accountId, databaseId);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
