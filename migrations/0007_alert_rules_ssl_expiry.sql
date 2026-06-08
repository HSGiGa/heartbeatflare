-- ssl_expiry alerts use metric_name='ssl_expiry' + condition='lt' (existing columns).
-- No schema change needed; add a useful index instead.
CREATE INDEX IF NOT EXISTS idx_alert_rules_monitor ON alert_rules(monitor_id);
