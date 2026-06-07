CREATE TABLE IF NOT EXISTS auth_config (
	id          TEXT PRIMARY KEY DEFAULT 'default',
	provider    TEXT NOT NULL DEFAULT 'cloudflare_access',
	team_domain TEXT NOT NULL,
	aud         TEXT NOT NULL,
	enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
