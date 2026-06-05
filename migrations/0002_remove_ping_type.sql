-- Finalize monitor types: remove ssl/ping, add dns/heartbeat
PRAGMA foreign_keys=OFF;

CREATE TABLE monitors_new (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	type TEXT NOT NULL CHECK (type IN ('http', 'tcp', 'dns', 'heartbeat', 'openmetrics')),
	mode TEXT NOT NULL CHECK (mode IN ('external', 'internal')),
	visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
	scrape_url TEXT,
	interval_seconds INTEGER NOT NULL CHECK (interval_seconds > 0),
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO monitors_new SELECT * FROM monitors;

DROP TABLE monitors; -- lint-ok: SQLite table recreation, only way to update a CHECK constraint

ALTER TABLE monitors_new RENAME TO monitors;

CREATE INDEX IF NOT EXISTS idx_monitors_enabled_interval ON monitors(enabled, interval_seconds);

PRAGMA foreign_keys=ON;
