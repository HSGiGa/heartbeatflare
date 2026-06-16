import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

const CONFIG_FILE = 'config.yaml';
const CONFIG_EXAMPLE = 'config.example.yaml';
let fallbackWarned = false;

export interface DeployConfig {
	name: string;
	domain?: string;
	database_name?: string;
	queue_name?: string;
}

export interface ResolvedDeploy {
	name: string;
	domain?: string;
	databaseName: string;
	queueName: string;
}

// Resolves the active config file: your own `config.yaml` if present, otherwise the tracked
// `config.example.yaml` (so a freshly templated/cloned repo still deploys the demo). Treating
// config.yaml as user-owned keeps it out of upstream merge conflicts — it is intentionally NOT
// gitignored, so generated repos can commit their own.
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
