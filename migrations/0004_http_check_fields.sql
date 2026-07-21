-- Feature: richer HTTP checks. Additive-only:
--   expected_status — per-monitor healthy status spec ("200", "200-204", "2xx", or a JSON list
--                     "[200,301]"). NULL = default 200-399 (2xx and 3xx are healthy).
--   body_match      — optional substring required in the first ~8 KB of the response body; a
--                     missing substring marks the check down. NULL = no body assertion.
-- Both apply to type: http only. lint-ok: ALTER TABLE ADD COLUMN is non-destructive.
ALTER TABLE monitors ADD COLUMN expected_status TEXT;
ALTER TABLE monitors ADD COLUMN body_match TEXT;
