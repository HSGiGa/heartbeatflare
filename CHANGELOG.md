# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
