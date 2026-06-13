// Syncs runtime secrets to Cloudflare Worker secrets in one bulk call. Required names are
// discovered from ${VAR} placeholders in config.yaml (notification channels, auth.aud);
// optional names are a known list. A required secret may come from the environment or
// already exist on the Worker (manual `wrangler secret put`); when it is found in neither,
// a warning is printed and the deploy proceeds — the affected notification channel simply
// stays broken until the secret is added. Runs after `wrangler deploy` (script must exist).
//
// In GitHub Actions, repository secrets are not enumerable from a step, so the workflow passes
// them all as JSON in SECRETS_CONTEXT (`toJSON(secrets)`); plain env vars win when both exist.
// In GitLab CI, variables arrive as plain env vars and SECRETS_CONTEXT is not needed.
import Cloudflare from 'cloudflare';
import { readFileSync } from 'node:fs';
import { loadConfig, resolveDeploy, requireEnv, type DeployConfig } from './lib/deploy-config';
import { heartbeatSecretName, slug } from './lib/naming';

// Optional runtime secrets: warn-and-skip when absent instead of failing the deploy.
const OPTIONAL_SECRETS = ['CLOUDFLARE_GRAPHQL_API_TOKEN'];

// Required secret names: ${VAR} placeholders in config.yaml (notification channels, auth.aud) plus,
// for each heartbeat monitor, its derived HEARTBEAT_<ID>_TOKEN. Heartbeat secrets are usually set
// manually in the dashboard; when the value is also present in CI it gets synced, otherwise the
// existing Worker secret is kept (handled below like any other required secret).
function referencedVars(raw: string): string[] {
	const names = new Set<string>();
	for (const m of raw.matchAll(/\$\{([A-Z0-9_]+)\}/g)) names.add(m[1]);
	const config = loadConfig<{ deploy?: DeployConfig; monitors?: { name: string; type: string }[] }>();
	for (const monitor of config.monitors ?? []) {
		if (monitor.type === 'heartbeat') names.add(heartbeatSecretName(slug(monitor.name)));
	}
	return [...names].sort();
}

function secretsContext(): Record<string, string> {
	const raw = process.env.SECRETS_CONTEXT;
	if (!raw) return {};
	try {
		return JSON.parse(raw) as Record<string, string>;
	} catch {
		console.warn('SECRETS_CONTEXT is set but is not valid JSON — ignoring');
		return {};
	}
}

async function main() {
	const config = loadConfig();
	const deploy = resolveDeploy(config);
	const required = referencedVars(readFileSync('config.yaml', 'utf-8'));
	const dryRun = process.argv.includes('--dry-run');

	if (dryRun) {
		console.log('Dry run — no API calls.');
		console.log(`Worker:           ${deploy.name}`);
		console.log(`Required (from config.yaml \${VAR} refs): ${required.join(', ') || '(none)'}`);
		console.log(`Optional:         ${OPTIONAL_SECRETS.join(', ')}`);
		return;
	}

	const token = requireEnv('CLOUDFLARE_API_TOKEN');
	const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
	const client = new Cloudflare({ apiToken: token });
	const fallback = secretsContext();
	const lookup = (name: string): string | undefined => process.env[name] || fallback[name] || undefined;

	// A ${VAR} referenced in config.yaml but absent from the CI env is still fine if the
	// secret already exists on the Worker (uploaded manually via `wrangler secret put`) —
	// skip it, value stays unchanged. When it exists in neither place, warn (don't fail):
	// the deploy proceeds, but notifications using that variable will not work until it's added.
	const missing = required.filter((name) => !lookup(name));
	if (missing.length > 0) {
		const existing = new Set<string>();
		try {
			for await (const s of client.workers.scripts.secrets.list(deploy.name, { account_id: accountId })) {
				if (s.name) existing.add(s.name);
			}
		} catch (err) {
			console.warn(`Could not list existing Worker secrets: ${err instanceof Error ? err.message : String(err)}`);
		}
		for (const name of missing) {
			if (existing.has(name)) {
				console.log(`${name}: not in CI env, but already set on the Worker — keeping the existing value`);
			} else {
				console.warn(
					`WARNING: \${${name}} is referenced in config.yaml but the secret exists neither in the environment ` +
						'nor on the Worker. Notifications using it will fail — add it as a CI secret or run ' +
						`\`npx wrangler secret put ${name}\`.`,
				);
			}
		}
	}

	const secrets: Record<string, { name: string; text: string; type: 'secret_text' }> = {};
	for (const name of required) {
		const value = lookup(name);
		if (value) secrets[name] = { name, text: value, type: 'secret_text' };
	}
	for (const name of OPTIONAL_SECRETS) {
		const value = lookup(name);
		if (value) secrets[name] = { name, text: value, type: 'secret_text' };
		else console.warn(`Optional secret ${name} not set — skipping (related feature stays disabled)`);
	}

	if (Object.keys(secrets).length === 0) {
		console.log('No secrets to sync.');
		return;
	}

	await client.workers.scripts.secrets.bulkUpdate(deploy.name, { account_id: accountId, secrets });
	console.log(`Synced ${Object.keys(secrets).length} secret(s) to worker "${deploy.name}": ${Object.keys(secrets).join(', ')}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
