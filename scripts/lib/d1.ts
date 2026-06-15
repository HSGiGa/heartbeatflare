import Cloudflare from 'cloudflare';

// Resolve a D1 database UUID by name. Returns null if no database with that name exists.
// The database name (<worker>-prod-db) is the stable identifier; the UUID is looked up on demand,
// so it never has to be stored in config.yaml or .env.
export async function findDatabaseId(client: Cloudflare, accountId: string, name: string): Promise<string | null> {
	for await (const db of client.d1.database.list({ account_id: accountId, name })) {
		if (db.name === name && db.uuid) return db.uuid;
	}
	return null;
}
