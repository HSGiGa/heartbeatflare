import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { VpcConfig } from './vpc';

const CONFIG_FILE = 'config.yaml';
const CONFIG_EXAMPLE = 'config.example.yaml';
let fallbackWarned = false;

export interface DeployConfig {
	name: string;
	domain?: string;
	database_name?: string;
	queue_name?: string;
	vpc?: VpcConfig;
}

export interface ResolvedDeploy {
	name: string;
	domain?: string;
	databaseName: string;
	queueName: string;
}

// Resolves the active config file (lenient): your own `config.yaml` if present, otherwise the
// tracked `config.example.yaml`. Used by read/dev tooling — wrangler generation, tests, dry-runs —
// so a freshly templated/cloned repo still works locally without a `cp`. Production-writing commands
// must call `assertUserConfig()` first so the example can't be deployed by accident.
//
// `config.yaml` is user-owned: tracking the example instead keeps user configs out of upstream merge
// conflicts. It is intentionally NOT gitignored — a generated repo commits its own `config.yaml` so
// CI can deploy it.
export function configPath(): string {
	if (existsSync(CONFIG_FILE)) return CONFIG_FILE;
	if (existsSync(CONFIG_EXAMPLE)) {
		if (!fallbackWarned) {
			console.warn(
				`${CONFIG_FILE} not found — using ${CONFIG_EXAMPLE}. ` +
					`Copy it to ${CONFIG_FILE} and edit for your own deployment.`,
			);
			fallbackWarned = true;
		}
		return CONFIG_EXAMPLE;
	}
	console.error(`No ${CONFIG_FILE} or ${CONFIG_EXAMPLE} found in the working directory`);
	process.exit(1);
}

export function loadConfigRaw(): string {
	return readFileSync(configPath(), 'utf-8');
}

// Fail-fast guard for production-writing commands (provision, config import, secrets sync). A
// missing `config.yaml` means the user forgot `cp config.example.yaml config.yaml` — without this
// guard the example demo would be deployed silently. The `ALLOW_EXAMPLE_CONFIG` escape hatch lets a
// deploy use the example on purpose (the upstream demo sets it as a repo Actions variable; template
// repos don't inherit variables, so generated repos fail fast).
export function assertUserConfig(): void {
	if (existsSync(CONFIG_FILE)) return;
	const allow = (process.env.ALLOW_EXAMPLE_CONFIG ?? '').toLowerCase();
	if (allow === '1' || allow === 'true' || allow === 'yes') {
		console.warn(`${CONFIG_FILE} not found — deploying ${CONFIG_EXAMPLE} (ALLOW_EXAMPLE_CONFIG set).`);
		return;
	}
	console.error(
		`${CONFIG_FILE} not found. Copy the example, edit it, and commit it in your repo so CI can deploy it:\n` +
			`  cp ${CONFIG_EXAMPLE} ${CONFIG_FILE}\n` +
			`(To deploy the example on purpose, set ALLOW_EXAMPLE_CONFIG=1.)`,
	);
	process.exit(1);
}

export function loadConfig<T extends { deploy?: DeployConfig }>(): T {
	return parseYaml(loadConfigRaw()) as T;
}

export function resolveDeploy(config: { deploy?: DeployConfig }): ResolvedDeploy {
	const deploy = config.deploy;
	if (!deploy?.name) {
		console.error('Missing "deploy.name" in config.yaml');
		process.exit(1);
	}
	return {
		name: deploy.name,
		domain: deploy.domain,
		databaseName: deploy.database_name ?? `${deploy.name}-prod-db`,
		queueName: deploy.queue_name ?? `${deploy.name}-notifications`,
	};
}

export function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		console.error(`${name} is required`);
		process.exit(1);
	}
	return value;
}
