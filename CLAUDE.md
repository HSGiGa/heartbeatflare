# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**heartbeatflare** is a serverless uptime monitor and status page that runs entirely on the
Cloudflare free tier. It is a **single Cloudflare Worker** (TypeScript) with three entry points:

- `fetch()` — public/private status pages and a JSON API
- `scheduled()` — a cron trigger (every minute) that probes targets, evaluates alerts, rolls up
  uptime aggregates and runs retention cleanup
- `queue()` — a Cloudflare Queue consumer that delivers incident notifications

It probes external targets (HTTP/HTTPS, TCP, DNS) plus best-effort SSL-certificate expiry, tracks
incidents, sends Slack/webhook notifications, and serves 90-day status pages — no servers, no
agents, no build step. Live example: `status.modem.by`.

> **The detailed system design lives in `ARCHITECTURE.md`** — read it before non-trivial changes.
> It is kept current with the code. `current-plan.md` tracks open work.

## Common Commands

### Development
- `npm run dev` — local dev server at http://localhost:8787 (generates a local `wrangler.jsonc` first)
- `npm run test` — Vitest suite under the Workers runtime (applies the full migration chain first)
- `npm run test -- --watch` — watch mode
- `npm run cf-typegen` — regenerate the `Env` type after binding changes

### Configuration & Deployment
- **Config is code.** `config.yaml` (validated by `config.schema.json`) is the source of truth for
  monitors, alert rules and notification channels. The Worker **never reads YAML** — config is
  imported into D1.
- `wrangler.jsonc` is **generated** from `config.yaml` by `scripts/generate-wrangler.ts` — do not
  hand-edit it; change `config.yaml` (or the generator) instead.
- `npm run config:import` — import `config.yaml` into D1 (idempotent: `ON CONFLICT DO UPDATE`,
  preserves runtime state; removed monitors are soft-deleted via `enabled = 0`)
- `npm run d1:migrate:prod` — apply D1 migrations (`wrangler d1 migrations apply DB --remote`)
- `npm run deploy` — generate wrangler config + `wrangler deploy`
- `npm run deploy:prod` — full pipeline: `test → migration:lint → provision → d1:migrate:prod →
  deploy:access → config:import → deploy → secrets:sync`
- `npm run provision` / `deploy:access` / `secrets:sync` — create D1+queue, configure Cloudflare
  Access, sync secrets

### Debugging
- `npm run dev`, then hit `/public`, `/private`, `/api/status`, `/api/history`
- `console.log()` output appears in the terminal and the Cloudflare dashboard (observability is on)

## Architecture & Code Structure

### Entry point: `src/index.ts`
Dispatches the three Workers handlers to their modules: `fetch → routes.ts`,
`scheduled → scheduler.ts`, `queue → queue.ts`.

### Module map (`src/`)
- `routes.ts` — HTTP routing, JSON API, **fail-closed** visibility (private data needs a valid
  session, enforced in SQL `WHERE` clauses), edge caching of public responses
- `status-page.ts` — server-rendered HTML/CSS/SVG for the status pages (no build step, no assets)
- `scheduler.ts` — cron tick: select due monitors (oldest-checked-first, bounded concurrency),
  probe, store, evaluate alerts, escalation re-notifications, hourly rollup, daily cleanup
- `probes.ts` — `httpCheck` / `tcpCheck` (`cloudflare:sockets`) / `dnsCheck` (DoH) / `sslProbe`
  (external cert API, cached)
- `alerts.ts` — `storeResult()` (write-minimised persistence) and `evaluateAlerts()` (per-class
  incidents: connectivity vs `ssl_expiry`)
- `queue.ts` / `notify.ts` — notification delivery + channel resolution; retry on total failure
- `auth.ts` — Cloudflare Access JWT verification; `usage.ts` — Cloudflare GraphQL usage metrics
- `types.ts` — shared D1 row types, probe results, queue messages

### Data layer: D1 (binding `DB`)
Raw parameterised SQL (no ORM), batched via `DB.batch()`. Tables: `monitors` + `monitor_state`,
`alert_rules`, `incidents`, `notification_channels` + `monitor_notification_channels` +
`notification_deliveries`, `metric_series` (raw, actionable-only), `uptime_hourly`/`uptime_daily`
(pre-aggregated), `auth_config`. See `ARCHITECTURE.md` for the full schema and the **Free Plan
write budget** (~2 writes/check; ~30 monitors at 60s).

## Writing D1 Migrations

- Migrations live in `migrations/` and run via `npm run d1:migrate:prod`. Each file runs exactly
  once; **there is no rollback** — design schemas to be additive.
- **Migrations are additive-only.** `npm run migration:lint` fails the build on
  `DROP TABLE/COLUMN` or `RENAME TABLE/COLUMN`. A genuine table rebuild (the only way to change a
  `CHECK` constraint or drop `NOT NULL` in SQLite) must be done with the
  `CREATE …_new` → `INSERT … SELECT` → `DROP TABLE` → `RENAME` pattern under
  `PRAGMA foreign_keys=OFF`, with a `-- lint-ok:` comment on the destructive line (see
  `0002_remove_ping_type.sql`). Avoid this: prefer not baking growable enums into `CHECK`.
- **Always include a backfill when adding a derived/aggregate table** so existing rows are
  populated immediately (e.g. `INSERT INTO uptime_daily … SELECT … FROM metric_series`).
- The test suite (`test/index.spec.ts`) applies the full migration chain so test schema matches
  production — a broken migration fails tests.

## Adding Features

### Adding a monitor / alert / channel
Edit `config.yaml` (conform to `config.schema.json`), then `npm run config:import`. Probe logic
for new monitor types goes in `src/probes.ts` and is dispatched in `src/scheduler.ts`.

### Adding bindings / env vars / secrets
Bindings derive from `config.yaml` via `scripts/generate-wrangler.ts`; run `npm run cf-typegen`
after changes. Secrets are referenced as `${VAR}` placeholders in config/D1 and resolved from the
Worker env at send time — never write credential literals to `config.yaml` or D1.

## Code Quality & Style
- Prettier (140 char width, single quotes, tabs, semicolons); EditorConfig: tabs, LF, UTF-8
- TypeScript strict mode; `noEmit` (Wrangler bundles)

## Project Philosophy
- **Free-Plan native**: stay within Workers/D1/Queues free limits; introduce new Cloudflare
  services only for a demonstrated scaling problem.
- **Config as code**: `config.yaml` is the single source of truth; the Worker only touches D1.
- **Write-minimised & incident-based**: ~2 D1 writes/check; alerting is incident-based, tracked
  per metric class, with the `incidents` table as the source of truth.
- **Fail-closed**: private data requires a valid session, enforced independently of Cloudflare Access.

## Resources
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Wrangler CLI Docs](https://developers.cloudflare.com/workers/wrangler/)
- [Vitest Documentation](https://vitest.dev/)
