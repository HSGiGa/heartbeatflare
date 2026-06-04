CREATE TABLE IF NOT EXISTS monitors (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	type TEXT NOT NULL CHECK (type IN ('http', 'tcp', 'ssl', 'ping', 'openmetrics')),
	mode TEXT NOT NULL CHECK (mode IN ('external', 'internal')),
	visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
	scrape_url TEXT,
	interval_seconds INTEGER NOT NULL CHECK (interval_seconds > 0),
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alert_rules (
	id TEXT PRIMARY KEY,
	monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
	metric_name TEXT,
	condition TEXT NOT NULL CHECK (condition IN ('eq', 'gt', 'lt', 'gte', 'lte')),
	threshold REAL NOT NULL,
	severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
	failure_count INTEGER NOT NULL CHECK (failure_count > 0),
	recovery_count INTEGER NOT NULL CHECK (recovery_count > 0),
	cooldown_seconds INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_seconds >= 0),
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS monitor_state (
	monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('up', 'degraded', 'down', 'unknown')),
	last_check_at TEXT,
	last_success_at TEXT,
	consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
	consecutive_successes INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_successes >= 0),
	active_incident_id TEXT
);

CREATE TABLE IF NOT EXISTS monitor_executions (
	id TEXT PRIMARY KEY,
	monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
	started_at TEXT NOT NULL,
	completed_at TEXT,
	status TEXT NOT NULL CHECK (status IN ('up', 'degraded', 'down')),
	latency_ms INTEGER,
	error TEXT,
	worker_region TEXT
);

CREATE TABLE IF NOT EXISTS incidents (
	id TEXT PRIMARY KEY,
	monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
	alert_rule_id TEXT NOT NULL REFERENCES alert_rules(id),
	status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
	severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
	started_at TEXT NOT NULL,
	resolved_at TEXT,
	reason TEXT
);

CREATE TABLE IF NOT EXISTS notification_channels (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	type TEXT NOT NULL CHECK (type IN ('telegram', 'slack', 'email', 'webhook')),
	configuration TEXT NOT NULL DEFAULT '{}',
	secret_name TEXT NOT NULL,
	is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS monitor_notification_channels (
	monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
	channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
	notify_on TEXT NOT NULL DEFAULT '["incident_open","incident_resolved"]',
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	PRIMARY KEY (monitor_id, channel_id)
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
	id TEXT PRIMARY KEY,
	incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
	channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	last_attempt_at TEXT,
	error TEXT
);

CREATE TABLE IF NOT EXISTS metric_series (
	id TEXT PRIMARY KEY,
	monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
	recorded_at TEXT NOT NULL,
	availability INTEGER NOT NULL CHECK (availability IN (0, 1)),
	latency_ms INTEGER,
	response_time_ms INTEGER,
	ssl_expiry_seconds INTEGER,
	tcp_connect_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_monitors_enabled_interval ON monitors(enabled, interval_seconds);
CREATE INDEX IF NOT EXISTS idx_alert_rules_monitor_enabled ON alert_rules(monitor_id, enabled);
CREATE INDEX IF NOT EXISTS idx_monitor_state_status ON monitor_state(status);
CREATE INDEX IF NOT EXISTS idx_monitor_state_last_check ON monitor_state(last_check_at);
CREATE INDEX IF NOT EXISTS idx_monitor_executions_monitor_started ON monitor_executions(monitor_id, started_at);
CREATE INDEX IF NOT EXISTS idx_incidents_monitor_status ON incidents(monitor_id, status);
CREATE INDEX IF NOT EXISTS idx_incidents_status_started ON incidents(status, started_at);
CREATE INDEX IF NOT EXISTS idx_incidents_resolved_at ON incidents(resolved_at);
CREATE INDEX IF NOT EXISTS idx_notification_channels_default_enabled ON notification_channels(is_default, enabled);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status_attempt ON notification_deliveries(status, last_attempt_at);
CREATE INDEX IF NOT EXISTS idx_metric_series_monitor_recorded ON metric_series(monitor_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_metric_series_recorded ON metric_series(recorded_at);
