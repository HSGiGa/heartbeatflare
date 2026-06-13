ALTER TABLE alert_rules ADD COLUMN escalation_seconds INTEGER;
ALTER TABLE incidents ADD COLUMN last_notified_at TEXT;

-- Backfill: treat started_at as the initial notification time for open incidents
UPDATE incidents SET last_notified_at = started_at WHERE status = 'open';
