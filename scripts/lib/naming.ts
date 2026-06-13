// Shared name → id → secret-name derivation. Single source of truth so import-config, sync-secrets
// and the docs cannot drift: a monitor's URL id and its Cloudflare secret name are both derived
// from the monitor name the same way everywhere.

// Monitor name → URL id: lowercase, non-alphanumerics collapsed to single hyphens, trimmed.
//   "Backup job" → "backup-job"
export function slug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

// Monitor id → heartbeat Worker-Secret name. The HEARTBEAT_ prefix guarantees a valid env var
// name even when the id starts with a digit; slug() never yields consecutive hyphens, so the
// uppercased form never yields consecutive underscores.
//   "backup-job" → "HEARTBEAT_BACKUP_JOB_TOKEN"
export function heartbeatSecretName(id: string): string {
	return `HEARTBEAT_${id.toUpperCase().replace(/-/g, '_')}_TOKEN`;
}
