# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/HSGiGa/heartbeatflare/releases/tag/v1.0.0
