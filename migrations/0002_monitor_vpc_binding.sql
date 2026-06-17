-- Feature: internal monitors via Cloudflare Workers VPC (Issue #18). Additive-only: a mode: internal
-- monitor records the name of the deploy.vpc network/service binding it is probed through. NULL for
-- external monitors. lint-ok: ALTER TABLE ADD COLUMN is non-destructive.
ALTER TABLE monitors ADD COLUMN vpc_binding TEXT;
