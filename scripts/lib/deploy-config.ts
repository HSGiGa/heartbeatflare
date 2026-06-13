import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export interface DeployConfig {
	name: string;
	domain?: string;
	database_name?: string;
	queue_name?: string;
	database_id?: string; // auto-populated by provision
}

export interface ResolvedDeploy {
	name: string;
	domain?: string;
	databaseName: string;
	queueName: string;
	databaseId: string;
}

export function loadConfig<T extends { deploy?: DeployConfig }>(): T {
	const raw = readFileSync('config.yaml', 'utf-8');
	return parseYaml(raw) as T;
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
		databaseId: deploy.database_id ?? '',
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
