ALTER TABLE uptime_hourly ADD COLUMN latency_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE uptime_daily  ADD COLUMN latency_count INTEGER NOT NULL DEFAULT 0;

-- Backfill: avg_latency_ms IS NOT NULL means at least one non-zero latency sample existed.
-- up_checks is the best available proxy (heartbeat monitors always have latency_ms=0 so
-- avg_latency_ms IS NULL for them → latency_count stays 0, which is correct).
UPDATE uptime_hourly SET latency_count = CASE WHEN avg_latency_ms IS NOT NULL THEN up_checks ELSE 0 END;
UPDATE uptime_daily  SET latency_count = CASE WHEN avg_latency_ms IS NOT NULL THEN up_checks ELSE 0 END;
