-- A dispatcher lease prevents cron from enqueueing the same due monitor repeatedly while its
-- queue consumer job is pending or being retried. lint-ok: additive-only schema change.
ALTER TABLE monitor_state ADD COLUMN check_lease_until TEXT;
CREATE INDEX IF NOT EXISTS idx_monitor_state_check_lease ON monitor_state(check_lease_until);
