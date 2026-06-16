import Cloudflare from 'cloudflare';
import { assertUserConfig, loadConfig, resolveDeploy, requireEnv } from './lib/deploy-config';
import { findDatabaseId } from './lib/d1';

async function ensureDatabase(client: Cloudflare, accountId: string, name: string): Promise<string> {
	const existing = await findDatabaseId(client, accountId, name);
	if (existing) {
		console.log(`D1 database found: ${name} (${existing})`);
		return existing;
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

async function main() {
	const dryRun = process.argv.includes('--dry-run');
	if (!dryRun) assertUserConfig();

	const config = loadConfig();
	const deploy = resolveDeploy(config);

	if (dryRun) {
		console.log('Dry run — no API calls, no file writes.');
		console.log(`Worker name:   ${deploy.name}`);
		console.log(`Custom domain: ${deploy.domain ?? '(none — workers.dev only)'}`);
		console.log(`D1 database:   ${deploy.databaseName}`);
		console.log(`Queue:         ${deploy.queueName}`);
		return;
	}

	const token = requireEnv('CLOUDFLARE_API_TOKEN');
	const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
	const client = new Cloudflare({ apiToken: token });

	// Resources are identified by name; the D1 UUID is resolved on demand by the deploy/import steps,
	// so nothing is written back to config.yaml.
	await ensureDatabase(client, accountId, deploy.databaseName);
	await ensureQueue(client, accountId, deploy.queueName);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
