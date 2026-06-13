-- Maintenance windows: planned work announced ahead of time. Declared in config.yaml and
-- imported into D1 (like monitors/channels). During an active window the scheduler skips the
-- affected monitors (no probe → no incident → uptime not dragged down), and the status page
-- shows a maintenance banner. A window with no rows in maintenance_window_monitors is global.
CREATE TABLE IF NOT EXISTS maintenance_windows (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	body TEXT,
	starts_at TEXT NOT NULL,           -- ISO 8601 UTC
	ends_at TEXT NOT NULL,             -- ISO 8601 UTC
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS maintenance_window_monitors (
	window_id  TEXT NOT NULL REFERENCES maintenance_windows(id) ON DELETE CASCADE,
	monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
	PRIMARY KEY (window_id, monitor_id)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_windows_active ON maintenance_windows(enabled, starts_at, ends_at);
