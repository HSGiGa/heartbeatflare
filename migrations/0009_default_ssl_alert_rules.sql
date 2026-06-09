-- Add default SSL expiry alert rules for http/tcp monitors that have no ssl_expiry rules yet.
-- threshold=7 → warning when cert expires in < 7 days
-- threshold=1 → critical when cert expires today (0 days) or is already expired
-- CTE determines eligible monitors once so both inserts use the same snapshot.

WITH eligible AS (
  SELECT m.id
  FROM monitors m
  WHERE m.enabled = 1
    AND m.type IN ('http', 'tcp')
    AND NOT EXISTS (
      SELECT 1 FROM alert_rules ar WHERE ar.monitor_id = m.id AND ar.metric_name = 'ssl_expiry'
    )
)
INSERT OR IGNORE INTO alert_rules (id, monitor_id, metric_name, condition, threshold, severity, failure_count, recovery_count, cooldown_seconds, enabled)
SELECT e.id || '-ssl-warn', e.id, 'ssl_expiry', 'lt', 7, 'warning', 1, 1, 0, 1 FROM eligible e
UNION ALL
SELECT e.id || '-ssl-crit', e.id, 'ssl_expiry', 'lt', 1, 'critical', 1, 1, 0, 1 FROM eligible e;
