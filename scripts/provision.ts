import Cloudflare from 'cloudflare';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { loadConfig, resolveDeploy, requireEnv } from './lib/deploy-config';

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

function updateConfigYaml(databaseId: string, previousDatabaseId: string): void {
	const raw = readFileSync('config.yaml', 'utf-8');
	const doc = parseDocument(raw);
	if (previousDatabaseId && previousDatabaseId !== databaseId) {
		console.warn(
			`WARNING: A new D1 database was provisioned (previous ID: ${previousDatabaseId}). Existing data is not migrated.`,
		);
	}
	doc.setIn(['deploy', 'database_id'], databaseId);
	writeFileSync('config.yaml', doc.toString());
	console.log('config.yaml updated with deploy.database_id');
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
		console.log('Managed config.yaml fields: deploy.database_id');
		return;
	}

	const token = requireEnv('CLOUDFLARE_API_TOKEN');
	const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
	const client = new Cloudflare({ apiToken: token });

	const databaseId = await ensureDatabase(client, accountId, deploy.databaseName);
	await ensureQueue(client, accountId, deploy.queueName);

	updateConfigYaml(databaseId, deploy.databaseId);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
