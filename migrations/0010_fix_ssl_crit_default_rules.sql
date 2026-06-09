-- Backfill missing ssl-crit rules for monitors that received ssl-warn in 0009 but not ssl-crit
-- (caused by the sequential NOT EXISTS bug in the original 0009 migration).

INSERT OR IGNORE INTO alert_rules (id, monitor_id, metric_name, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled)
SELECT m.id || '-ssl-crit', m.id, 'ssl_expiry', 'lt', 1, 'critical', 1, 1, 0, 1
FROM monitors m
WHERE m.enabled = 1
  AND m.type IN ('http', 'tcp')
  AND EXISTS (
    SELECT 1 FROM alert_rules ar WHERE ar.id = m.id || '-ssl-warn'
  )
  AND NOT EXISTS (
    SELECT 1 FROM alert_rules ar WHERE ar.id = m.id || '-ssl-crit'
  );
