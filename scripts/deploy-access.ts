import Cloudflare from 'cloudflare';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { requireEnv, resolveDeploy, type DeployConfig } from './lib/deploy-config';

interface AccessPolicyConfig {
	name: string;
	emails: string[];
}

interface AccessConfig {
	app_name: string;
	domain?: string;
	session_duration?: string;
	identity_provider: string;
	policy: AccessPolicyConfig;
}

const token = requireEnv('CLOUDFLARE_API_TOKEN');
const ACCOUNT_ID = requireEnv('CLOUDFLARE_ACCOUNT_ID');

const client = new Cloudflare({ apiToken: token });

async function findTeamDomain(): Promise<string> {
	const org = await client.zeroTrust.organizations.list({ account_id: ACCOUNT_ID });
	if (!org?.auth_domain) {
		throw new Error('Zero Trust organization not found. Set up Cloudflare Zero Trust for this account first.');
	}
	return org.auth_domain.replace(/\.cloudflareaccess\.com$/, '');
}

async function findIdP(name: string): Promise<string> {
	for await (const idp of client.zeroTrust.identityProviders.list({ account_id: ACCOUNT_ID })) {
		if (idp.name === name && idp.id) return idp.id;
	}
	throw new Error(`Identity provider "${name}" not found. Add it in Cloudflare Zero Trust → Settings → Authentication first.`);
}

async function findOrCreatePolicy(cfg: AccessPolicyConfig): Promise<string> {
	for await (const p of client.zeroTrust.access.policies.list({ account_id: ACCOUNT_ID })) {
		if (p.name === cfg.name && p.id) {
			console.log(`Updating policy: ${cfg.name} (${p.id})`);
			await client.zeroTrust.access.policies.update(p.id, {
				account_id: ACCOUNT_ID,
				name: cfg.name,
				decision: 'allow',
				include: cfg.emails.map((email) => ({ email: { email } })),
			});
			return p.id;
		}
	}
	console.log(`Creating policy: ${cfg.name}`);
	const created = await client.zeroTrust.access.policies.create({
		account_id: ACCOUNT_ID,
		name: cfg.name,
		decision: 'allow',
		include: cfg.emails.map((email) => ({ email: { email } })),
	});
	return created.id!;
}

async function findOrCreateApp(cfg: AccessConfig, domain: string, idpId: string, policyId: string): Promise<string> {
	const appParams = {
		account_id: ACCOUNT_ID,
		type: 'self_hosted' as const,
		name: cfg.app_name,
		domain,
		session_duration: cfg.session_duration ?? '24h',
		allowed_idps: [idpId],
		auto_redirect_to_identity: true,
		allow_authenticate_via_warp: false,
		policies: [{ id: policyId, precedence: 1 }],
	};

	for await (const app of client.zeroTrust.access.applications.list({ account_id: ACCOUNT_ID })) {
		if (app.name === cfg.app_name) {
			const appId = (app as { id?: string }).id!;
			console.log(`Updating application: ${cfg.app_name} (${appId})`);
			const updated = await client.zeroTrust.access.applications.update(appId, appParams);
			return (updated as { aud?: string }).aud!;
		}
	}

	console.log(`Creating application: ${cfg.app_name}`);
	const created = await client.zeroTrust.access.applications.create(appParams);
	return (created as { aud?: string }).aud!;
}

async function main() {
	const raw = readFileSync('config.yaml', 'utf-8');
	const doc = parseDocument(raw);
	const config = doc.toJS() as { deploy?: DeployConfig; access: AccessConfig };

	if (!config.access) throw new Error('Missing "access:" section in config.yaml');

	const { access } = config;
	const deploy = resolveDeploy(config);
	const accessDomain = access.domain ?? (deploy.domain ? `${deploy.domain}/private` : undefined);
	if (!accessDomain) throw new Error('Set access.domain or deploy.domain in config.yaml');

	const teamDomain = await findTeamDomain();
	console.log(`Team domain: ${teamDomain}`);

	const idpId = await findIdP(access.identity_provider);
	console.log(`IdP: ${access.identity_provider} (${idpId})`);

	const policyId = await findOrCreatePolicy(access.policy);
	console.log(`Policy: ${access.policy.name} (${policyId})`);

	const aud = await findOrCreateApp(access, accessDomain, idpId, policyId);
	console.log(`Application AUD: ${aud}`);

	doc.setIn(['auth', 'provider'], 'cloudflare_access');
	doc.setIn(['auth', 'team_domain'], teamDomain);
	doc.setIn(['auth', 'aud'], aud);
	writeFileSync('config.yaml', doc.toString());
	console.log('config.yaml updated with auth.aud — run config:import to push to D1');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
