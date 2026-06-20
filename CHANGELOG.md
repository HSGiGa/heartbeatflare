# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.2] - 2026-06-20

### Added

- **History tab: month navigation with day-grouped timeline** — the History tab now shows a month
  navigator (← previous month | current month | next month →) instead of page-by-page pagination.
  Incidents within each month are grouped under day-section headers so the date appears once per day
  rather than repeating on every card. ([#33](https://github.com/HSGiGa/heartbeatflare/issues/33))

## [1.2.1] - 2026-06-19

### Changed

- **Status page uptime bars are easier to read** — daily uptime bars are now taller, and warning/error
  segments have a larger minimum visible height so short degraded periods stand out more clearly.

### Fixed

- **Slack-compatible notification headers validate correctly** — `type: slack` channels now accept
  `headers` in `config.schema.json`, matching the runtime support used by Slack-compatible webhooks
  behind an authenticated proxy. ([#30](https://github.com/HSGiGa/heartbeatflare/issues/30))

## [1.2.0] - 2026-06-18

### Added

- **Email notifications via Cloudflare Email Service** — `type: email` is now a first-class
  notification channel, configured with `from`/`from_name`/`to` (plus optional `subject_prefix` and
  custom `templates`) instead of SMTP. `npm run provision` creates and verifies Email Routing
  destination addresses, `npm run wrangler:generate` emits a restricted `send_email` binding scoped to
  the configured senders and recipients, and delivery goes through `env.EMAIL.send()` with outcomes
  recorded in `notification_deliveries`. On the Cloudflare Free Plan every recipient must be a verified
  Email Routing destination address. ([#27](https://github.com/HSGiGa/heartbeatflare/issues/27))

### Changed

- **Email channel config replaces SMTP fields** — `server`/`port`/`username`/`password` are no longer
  accepted on `type: email` channels; existing SMTP-shaped email config must be migrated to the
  Cloudflare Email Service shape.

## [1.1.2] - 2026-06-18

### Changed

- **Uptime bars reflect daily proportion, not incidents** — each 90-day bar is now a vertical stack
  sized by the day's `avg_up`: a green base for the healthy portion plus an amber (degraded) or red
  (below 75% uptime) segment for the rest. Incidents no longer repaint the bar — they remain in the
  tooltip only — so a short warning on an otherwise healthy day no longer marks the whole day as
  degraded. The down segment is floored to a few pixels so a tiny outage (e.g. 99.9%) stays visible.
  No schema or query changes. ([#23](https://github.com/HSGiGa/heartbeatflare/issues/23))
- **Incident tooltip shows time range** — hovering a day's bar now shows each incident's start–end
  clock time (UTC), e.g. `3:45 PM – 6:15 PM UTC`, alongside the existing duration and reason.

## [1.1.1] - 2026-06-18

### Fixed

- **History scope on `/public`** — a logged-in user's History tab no longer loads private incidents on
  the public page. Scope is now a function of the route (`/public` requests `scope=public`, `/private`
  requests `scope=all`) instead of being inferred from the session cookie. `/api/history` still enforces
  the session fail-closed: `scope=all` returns private data only with a valid session, otherwise it
  degrades to public. ([#20](https://github.com/HSGiGa/heartbeatflare/issues/20))

## [1.1.0] - 2026-06-17

### Added

- **Internal monitors via Cloudflare Workers VPC (beta)** — `mode: internal` HTTP/TCP monitors probe
  **private** targets through a configured Workers VPC binding instead of the public internet.
  Declare bindings under `deploy.vpc` (tunnel-backed `networks[]` and scoped `services[]`, with
  resource ids supplied as `${VAR}` placeholders resolved at deploy time), and point a monitor at one
  via `vpc_binding`. External monitors are unaffected. An **Internal** badge marks these monitors on
  the status page.
- v1 limits, enforced at config import: internal monitors are `http`/`tcp` only (no `dns`), SSL-expiry
  checks are skipped (`ssl: true` rejected), and Cloudflare Mesh (`network_id: cf1:network`) is out of
  scope — tunnel-backed networks only. heartbeatflare consumes pre-existing VPC resources by
  id/binding and never provisions Networks, Services, or Tunnels.

## [1.0.0] - 2026-06-16

First stable release. A serverless uptime monitor and status page that runs entirely on the
Cloudflare free tier — a single Worker probes targets every minute, tracks incidents, sends
notifications, and serves public/private status pages.

### Added

- **Monitors** — HTTP/HTTPS, TCP, DNS, and heartbeat (push) checks with per-monitor intervals
  (60s minimum).
- **Custom HTTP probe headers** — `type: http` monitors can send custom request headers with
  `${VAR}` substitution from Worker secrets, resolved at probe time; a missing secret fails the
  check without leaking the placeholder. Every HTTP probe sends a fixed
  `User-Agent: heartbeatflare/1.0` for log identification (config cannot override it).
- **Status pages** — public and private views with 90-day uptime bars, latency sparklines, and
  incident history; the private view is gated by Cloudflare Access.
- **Incident management** — independent connectivity and SSL-expiry incidents, with
  failure/recovery thresholds, cooldowns, and escalation re-notifications.
- **Notifications** — Slack-compatible webhooks, generic webhooks, and Telegram, delivered through
  Cloudflare Queues with retry.
- **Maintenance windows**, an Atom feed (`/feed.xml`), and embeddable SVG status badges.
- **Configuration as code** — monitors, alerts, and channels in one `config.yaml`; CI provisions the
  D1 database and notification queue automatically.

[1.1.0]: https://github.com/HSGiGa/heartbeatflare/releases/tag/v1.1.0
[1.0.0]: https://github.com/HSGiGa/heartbeatflare/releases/tag/v1.0.0
