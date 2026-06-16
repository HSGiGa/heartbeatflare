// Syncs runtime secrets to Cloudflare Worker secrets in one bulk call. Two sources of names:
//   • ${VAR} placeholders in config.yaml — required; a missing one
//     is fine if it already exists on the Worker, otherwise a warning is printed and the deploy
//     proceeds (the affected feature just stays broken until the secret is added).
//   • heartbeat monitors — each needs a HEARTBEAT_<ID>_TOKEN. These are auto-managed: if the secret
//     isn't supplied (CI env) and isn't already on the Worker, a random token is generated, uploaded,
//     and printed ONCE in this output so you can wire it into the job. Existing tokens are left as-is.
// Runs after `wrangler deploy` (the script must exist).
//
// In GitHub Actions, repository secrets are not enumerable from a step, so the workflow passes
// them all as JSON in SECRETS_CONTEXT (`toJSON(secrets)`); plain env vars win when both exist.
// In GitLab CI, variables arrive as plain env vars and SECRETS_CONTEXT is not needed.
import Cloudflare from 'cloudflare';
import { randomBytes } from 'node:crypto';
import { assertUserConfig, loadConfig, loadConfigRaw, resolveDeploy, requireEnv, type DeployConfig } from './lib/deploy-config';
import { heartbeatSecretName, slug } from './lib/naming';

// Optional runtime secrets: warn-and-skip when absent instead of failing the deploy.
const OPTIONAL_SECRETS = ['CLOUDFLARE_GRAPHQL_API_TOKEN'];

type HeartbeatMonitor = { name: string; id: string; secretName: string };

// ${VAR} placeholders referenced in config.yaml.
function referencedVars(raw: string): string[] {
	const names = new Set<string>();
	for (const m of raw.matchAll(/\$\{([A-Z0-9_]+)\}/g)) names.add(m[1]);
	return [...names].sort();
}

// Heartbeat monitors and their derived secret names (one Worker Secret per heartbeat monitor).
function heartbeatMonitors(): HeartbeatMonitor[] {
	const config = loadConfig<{ deploy?: DeployConfig; monitors?: { name: string; type: string }[] }>();
	return (config.monitors ?? [])
		.filter((m) => m.type === 'heartbeat')
		.map((m) => {
			const id = slug(m.name);
			return { name: m.name, id, secretName: heartbeatSecretName(id) };
		});
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
	const dryRun = process.argv.includes('--dry-run');
	if (!dryRun) assertUserConfig();

	const config = loadConfig<{ deploy?: DeployConfig }>();
	const deploy = resolveDeploy(config);
	const required = referencedVars(loadConfigRaw());
	const heartbeats = heartbeatMonitors();

	if (dryRun) {
		console.log('Dry run — no API calls.');
		console.log(`Worker:           ${deploy.name}`);
		console.log(`Required (from config.yaml \${VAR} refs): ${required.join(', ') || '(none)'}`);
		console.log(`Optional:         ${OPTIONAL_SECRETS.join(', ')}`);
		console.log(`Heartbeat tokens (auto-generated if missing on the Worker): ${heartbeats.map((h) => h.secretName).join(', ') || '(none)'}`);
		return;
	}

	const token = requireEnv('CLOUDFLARE_API_TOKEN');
	const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
	const client = new Cloudflare({ apiToken: token });
	const fallback = secretsContext();
	const lookup = (name: string): string | undefined => process.env[name] || fallback[name] || undefined;

	// List existing Worker secrets once: needed both to decide whether a missing ${VAR} is already
	// set and whether each heartbeat token needs generating.
	const existing = new Set<string>();
	const needExistingList = heartbeats.length > 0 || required.some((name) => !lookup(name));
	if (needExistingList) {
		try {
			for await (const s of client.workers.scripts.secrets.list(deploy.name, { account_id: accountId })) {
				if (s.name) existing.add(s.name);
			}
		} catch (err) {
			console.warn(`Could not list existing Worker secrets: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const secrets: Record<string, { name: string; text: string; type: 'secret_text' }> = {};
	const add = (name: string, text: string) => {
		secrets[name] = { name, text, type: 'secret_text' };
	};

	// ${VAR} secrets: upload from env when present; otherwise keep an existing Worker value or warn.
	for (const name of required) {
		const value = lookup(name);
		if (value) add(name, value);
		else if (existing.has(name)) console.log(`${name}: not in CI env, but already set on the Worker — keeping the existing value`);
		else
			console.warn(
				`WARNING: \${${name}} is referenced in config.yaml but the secret exists neither in the environment ` +
					`nor on the Worker. Features using it may fail — add it as a CI secret or run \`npx wrangler secret put ${name}\`.`,
			);
	}
	for (const name of OPTIONAL_SECRETS) {
		const value = lookup(name);
		if (value) add(name, value);
		else console.warn(`Optional secret ${name} not set — skipping (related feature stays disabled)`);
	}

	// Heartbeat tokens: env override > existing Worker secret (kept) > generate a new random token.
	const generated: Array<HeartbeatMonitor & { value: string }> = [];
	for (const hb of heartbeats) {
		const provided = lookup(hb.secretName);
		if (provided) {
			add(hb.secretName, provided);
		} else if (existing.has(hb.secretName)) {
			console.log(`${hb.secretName}: already set on the Worker — keeping the existing token`);
		} else {
			const value = randomBytes(32).toString('hex');
			add(hb.secretName, value);
			generated.push({ ...hb, value });
		}
	}

	if (Object.keys(secrets).length === 0) {
		console.log('No secrets to sync.');
		return;
	}

	await client.workers.scripts.secrets.bulkUpdate(deploy.name, { account_id: accountId, secrets });
	console.log(`Synced ${Object.keys(secrets).length} secret(s) to worker "${deploy.name}": ${Object.keys(secrets).join(', ')}`);

	// Print freshly-generated heartbeat tokens ONCE — Cloudflare never shows a secret value again.
	if (generated.length > 0) {
		const base = deploy.domain ? `https://${deploy.domain}` : `https://<your-worker-domain>`;
		console.log('\n=== New heartbeat tokens generated — SAVE THESE NOW (not shown again) ===');
		for (const g of generated) {
			console.log(`\n  Monitor:  ${g.name}`);
			console.log(`  Secret:   ${g.secretName} = ${g.value}`);
			console.log(`  Beat URL: curl -fsS -X POST "${base}/beat/${g.id}/${g.value}"`);
		}
		console.log('\nTo rotate a token, delete the secret in the Cloudflare dashboard and redeploy.\n');
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
