import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { parse as parseJsonc } from 'jsonc-parser';

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

export interface WranglerD1Database {
	binding: string;
	database_name: string;
	database_id: string;
	migrations_dir?: string;
}

export interface WranglerConfig {
	name?: string;
	routes?: { pattern: string; custom_domain?: boolean }[];
	vars?: Record<string, string>;
	d1_databases?: WranglerD1Database[];
	queues?: {
		producers?: { queue: string; binding: string }[];
		consumers?: { queue: string; [key: string]: unknown }[];
	};
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

export function readWranglerConfig(): WranglerConfig {
	const raw = readFileSync('wrangler.jsonc', 'utf-8');
	return parseJsonc(raw) as WranglerConfig;
}
