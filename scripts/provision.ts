import Cloudflare from 'cloudflare';
import {
	assertUserConfig,
	loadConfig,
	resolveDeploy,
	requireEnv,
	type DeployConfig,
} from './lib/deploy-config';
import { findDatabaseId } from './lib/d1';
import { collectEmailChannels, emailRecipients, type EmailChannelConfig } from './lib/email';

const API_BASE = 'https://api.cloudflare.com/client/v4';

interface EmailRoutingAddress {
	email: string;
	verified: string | null;
	status: string;
}

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

async function cloudflareRequest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			...(init.headers ?? {}),
		},
	});
	const data = (await res.json()) as { success: boolean; errors?: { message: string }[]; result: T };
	if (!res.ok || !data.success) {
		const message = data.errors?.map((e) => e.message).join(', ') || `HTTP ${res.status}`;
		throw new Error(`Cloudflare API error: ${message}`);
	}
	return data.result;
}

// Max page size accepted by the Email Routing addresses endpoint; paginate so accounts with many
// destination addresses don't drop an already-verified recipient and trigger a redundant create.
const ADDRESSES_PER_PAGE = 50;

async function listDestinationAddresses(token: string, accountId: string): Promise<EmailRoutingAddress[]> {
	const all: EmailRoutingAddress[] = [];
	for (let page = 1; ; page++) {
		const batch = await cloudflareRequest<EmailRoutingAddress[]>(
			token,
			`/accounts/${accountId}/email/routing/addresses?page=${page}&per_page=${ADDRESSES_PER_PAGE}`,
		);
		all.push(...batch);
		if (batch.length < ADDRESSES_PER_PAGE) break;
	}
	return all;
}

async function createDestinationAddress(token: string, accountId: string, email: string): Promise<void> {
	await cloudflareRequest<EmailRoutingAddress>(token, `/accounts/${accountId}/email/routing/addresses`, {
		method: 'POST',
		body: JSON.stringify({ email }),
	});
}

async function ensureEmailDestinations(token: string, accountId: string, channels: EmailChannelConfig[]): Promise<void> {
	if (channels.length === 0) return;

	const wanted = new Set<string>();
	for (const channel of channels) for (const recipient of emailRecipients(channel)) wanted.add(recipient);
	const addresses = new Map(
		(await listDestinationAddresses(token, accountId)).map((address) => [address.email.toLowerCase(), address]),
	);

	const unverified: string[] = [];
	for (const recipient of [...wanted].sort()) {
		const existing = addresses.get(recipient.toLowerCase());
		if (!existing) {
			console.log(`Creating Email Routing destination address: ${recipient}`);
			await createDestinationAddress(token, accountId, recipient);
			unverified.push(recipient);
			continue;
		}
		if (existing.status !== 'verified' || !existing.verified) unverified.push(recipient);
		else console.log(`Email Routing destination address verified: ${recipient}`);
	}

	if (unverified.length > 0) {
		console.warn(
			`Email destination address verification pending: ${unverified.join(', ')}. ` +
				'Deploy will continue; email deliveries to unverified recipients will be skipped until they confirm the Cloudflare verification email.',
		);
	}
}

async function main() {
	const dryRun = process.argv.includes('--dry-run');
	if (!dryRun) assertUserConfig();

	const config = loadConfig<{ deploy?: DeployConfig; notification_channels?: EmailChannelConfig[] }>();
	const deploy = resolveDeploy(config);
	const emailChannels = collectEmailChannels(config);

	if (dryRun) {
		console.log('Dry run — no API calls, no file writes.');
		console.log(`Worker name:   ${deploy.name}`);
		console.log(`Custom domain: ${deploy.domain ?? '(none — workers.dev only)'}`);
		console.log(`D1 database:   ${deploy.databaseName}`);
		console.log(`Queue:         ${deploy.queueName}`);
		if (emailChannels.length > 0) {
			const recipients = new Set(emailChannels.flatMap((channel) => emailRecipients(channel)));
			console.log(`Email recipients: ${[...recipients].sort().join(', ')}`);
		}
		return;
	}

	const token = requireEnv('CLOUDFLARE_API_TOKEN');
	const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
	const client = new Cloudflare({ apiToken: token });

	// Resources are identified by name; the D1 UUID is resolved on demand by the deploy/import steps,
	// so nothing is written back to config.yaml.
	await ensureDatabase(client, accountId, deploy.databaseName);
	await ensureQueue(client, accountId, deploy.queueName);
	await ensureEmailDestinations(token, accountId, emailChannels);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
