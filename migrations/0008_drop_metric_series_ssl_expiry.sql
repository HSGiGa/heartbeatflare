-- ssl_expiry_seconds is write-only and redundant with monitor_state.ssl_not_after.
-- Deploy updated Worker code before applying this migration.
ALTER TABLE metric_series DROP COLUMN ssl_expiry_seconds;
