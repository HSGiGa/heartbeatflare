-- HeartbeatFlare baseline schema (v1). Single consolidated migration: the cumulative result of the
-- former 0001–0014 development migrations, plus schema hooks for already-planned features so the
-- production D1 stays stable without near-term migrations. Forward-proofed for the additive-only
-- migration policy: CHECK constraints are dropped from growable enum fields (validated instead at
-- config import via config.schema.json), and incidents.alert_rule_id is nullable.

-- Status-page grouping of monitors into components (API, Website, DB, …).
CREATE TABLE IF NOT EXISTS monitor_groups (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	display_order INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS monitors (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	type TEXT NOT NULL,                                 -- http | tcp | dns | heartbeat | openmetrics (validated at import)
	mode TEXT NOT NULL CHECK (mode IN ('external', 'internal')),
	visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
	scrape_url TEXT,
	interval_seconds INTEGER NOT NULL CHECK (interval_seconds > 0),
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
	ssl_check INTEGER NOT NULL DEFAULT 1 CHECK (ssl_check IN (0, 1)),
	group_id TEXT REFERENCES monitor_groups(id) ON DELETE SET NULL,   -- feature: components/groups
	heartbeat_token TEXT,                              -- feature: push heartbeat (secret; NULL unless type=heartbeat)
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alert_rules (
	id TEXT PRIMARY KEY,
	monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
	metric_name TEXT,                                  -- NULL = connectivity; e.g. 'ssl_expiry'
	condition TEXT NOT NULL,                            -- eq | gt | lt | gte | lte (validated at import)
	threshold REAL NOT NULL,
	severity TEXT NOT NULL,                             -- warning | critical | … (validated at import)
	failure_count INTEGER NOT NULL CHECK (failure_count > 0),
	recovery_count INTEGER NOT NULL CHECK (recovery_count > 0),
	cooldown_seconds INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_seconds >= 0),
	escalation_seconds INTEGER,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS monitor_state (
	monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('up', 'degraded', 'down', 'unknown')),
	last_check_at TEXT,
	last_success_at TEXT,
	consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
	consecutive_successes INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_successes >= 0),
	active_incident_id TEXT,
	ssl_not_after TEXT,
	ssl_issuer TEXT
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
	alert_rule_id TEXT REFERENCES alert_rules(id),     -- nullable: manual / maintenance incidents have no rule
	status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
	severity TEXT NOT NULL,                             -- validated by the rule / operator input
	started_at TEXT NOT NULL,
	resolved_at TEXT,
	reason TEXT,
	last_notified_at TEXT,
	acknowledged_at TEXT,                              -- feature: incident acknowledge
	acknowledged_by TEXT,                              -- feature: incident acknowledge
	created_by TEXT                                    -- feature: manual incidents (operator); NULL = system-generated
);

-- Incident timeline (investigating → identified → monitoring → resolved), feature: manual incidents.
CREATE TABLE IF NOT EXISTS incident_updates (
	id TEXT PRIMARY KEY,
	incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	status TEXT,
	message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_channels (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	type TEXT NOT NULL,                                 -- telegram | slack | email | webhook | … (validated at import)
	configuration TEXT NOT NULL DEFAULT '{}',
	secret_name TEXT NOT NULL DEFAULT '',
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

-- Raw time-series for built-in probes; written only for actionable samples (see src/alerts.ts).
CREATE TABLE IF NOT EXISTS metric_series (
	id TEXT PRIMARY KEY,
	monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
	recorded_at TEXT NOT NULL,
	availability INTEGER NOT NULL CHECK (availability IN (0, 1)),
	latency_ms INTEGER,
	response_time_ms INTEGER,
	tcp_connect_ms INTEGER
);

CREATE TABLE IF NOT EXISTS uptime_hourly (
	monitor_id TEXT NOT NULL,
	hour TEXT NOT NULL,                                 -- YYYY-MM-DDTHH UTC
	total_checks INTEGER NOT NULL DEFAULT 0,
	up_checks INTEGER NOT NULL DEFAULT 0,
	avg_latency_ms REAL,
	latency_count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (monitor_id, hour)
);

CREATE TABLE IF NOT EXISTS uptime_daily (
	monitor_id TEXT NOT NULL,
	day TEXT NOT NULL,                                  -- YYYY-MM-DD UTC
	total_checks INTEGER NOT NULL DEFAULT 0,
	up_checks INTEGER NOT NULL DEFAULT 0,
	avg_latency_ms REAL,
	latency_count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (monitor_id, day)
);

-- Feature: OpenMetrics / arbitrary named metrics. Raw key/value samples + hourly/daily aggregates
-- (count/sum/min/max → derive avg), mirroring the uptime_* rollup pattern.
CREATE TABLE IF NOT EXISTS metric_samples (
	id TEXT PRIMARY KEY,
	monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
	metric_name TEXT NOT NULL,
	value REAL NOT NULL,
	recorded_at TEXT NOT NULL,
	labels TEXT                                        -- JSON label set, NULL if none
);

CREATE TABLE IF NOT EXISTS metric_sample_hourly (
	monitor_id TEXT NOT NULL,
	metric_name TEXT NOT NULL,
	hour TEXT NOT NULL,
	sample_count INTEGER NOT NULL DEFAULT 0,
	sum_value REAL NOT NULL DEFAULT 0,
	min_value REAL,
	max_value REAL,
	PRIMARY KEY (monitor_id, metric_name, hour)
);

CREATE TABLE IF NOT EXISTS metric_sample_daily (
	monitor_id TEXT NOT NULL,
	metric_name TEXT NOT NULL,
	day TEXT NOT NULL,
	sample_count INTEGER NOT NULL DEFAULT 0,
	sum_value REAL NOT NULL DEFAULT 0,
	min_value REAL,
	max_value REAL,
	PRIMARY KEY (monitor_id, metric_name, day)
);

-- Planned maintenance windows (declared in config.yaml, imported to D1). A window with no rows in
-- maintenance_window_monitors is global (all monitors).
CREATE TABLE IF NOT EXISTS maintenance_windows (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	body TEXT,
	starts_at TEXT NOT NULL,
	ends_at TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS maintenance_window_monitors (
	window_id TEXT NOT NULL REFERENCES maintenance_windows(id) ON DELETE CASCADE,
	monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
	PRIMARY KEY (window_id, monitor_id)
);

CREATE TABLE IF NOT EXISTS auth_config (
	id TEXT PRIMARY KEY DEFAULT 'default',
	provider TEXT NOT NULL DEFAULT 'cloudflare_access',
	team_name TEXT NOT NULL,
	aud TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_monitors_enabled_interval ON monitors(enabled, interval_seconds);
CREATE INDEX IF NOT EXISTS idx_monitors_group ON monitors(group_id);
CREATE INDEX IF NOT EXISTS idx_alert_rules_monitor_enabled ON alert_rules(monitor_id, enabled);
CREATE INDEX IF NOT EXISTS idx_alert_rules_monitor ON alert_rules(monitor_id);
CREATE INDEX IF NOT EXISTS idx_monitor_state_status ON monitor_state(status);
CREATE INDEX IF NOT EXISTS idx_monitor_state_last_check ON monitor_state(last_check_at);
CREATE INDEX IF NOT EXISTS idx_monitor_executions_monitor_started ON monitor_executions(monitor_id, started_at);
CREATE INDEX IF NOT EXISTS idx_incidents_monitor_status ON incidents(monitor_id, status);
CREATE INDEX IF NOT EXISTS idx_incidents_status_started ON incidents(status, started_at);
CREATE INDEX IF NOT EXISTS idx_incidents_resolved_at ON incidents(resolved_at);
CREATE INDEX IF NOT EXISTS idx_incident_updates_incident ON incident_updates(incident_id);
CREATE INDEX IF NOT EXISTS idx_notification_channels_default_enabled ON notification_channels(is_default, enabled);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status_attempt ON notification_deliveries(status, last_attempt_at);
CREATE INDEX IF NOT EXISTS idx_metric_series_monitor_recorded ON metric_series(monitor_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_metric_series_recorded ON metric_series(recorded_at);
CREATE INDEX IF NOT EXISTS idx_metric_samples_monitor_name_recorded ON metric_samples(monitor_id, metric_name, recorded_at);
CREATE INDEX IF NOT EXISTS idx_metric_samples_recorded ON metric_samples(recorded_at);
CREATE INDEX IF NOT EXISTS idx_maintenance_windows_active ON maintenance_windows(enabled, starts_at, ends_at);
