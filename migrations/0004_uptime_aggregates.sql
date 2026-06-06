-- Pre-aggregated uptime stats to avoid full metric_series table scans on status page.
-- Replaces per-page 90-day GROUP BY (648K rows) with a 900-row read.

CREATE TABLE uptime_daily (
	monitor_id     TEXT NOT NULL,
	day            TEXT NOT NULL,  -- YYYY-MM-DD UTC
	total_checks   INTEGER NOT NULL DEFAULT 0,
	up_checks      INTEGER NOT NULL DEFAULT 0,
	avg_latency_ms REAL,
	PRIMARY KEY (monitor_id, day)
);

CREATE TABLE uptime_hourly (
	monitor_id     TEXT NOT NULL,
	hour           TEXT NOT NULL,  -- YYYY-MM-DDTHH UTC
	total_checks   INTEGER NOT NULL DEFAULT 0,
	up_checks      INTEGER NOT NULL DEFAULT 0,
	avg_latency_ms REAL,
	PRIMARY KEY (monitor_id, hour)
);
