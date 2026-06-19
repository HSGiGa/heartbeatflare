# heartbeatflare

[![Deploy to Cloudflare](https://github.com/HSGiGa/heartbeatflare/actions/workflows/deploy-cloudflare.yml/badge.svg)](https://github.com/HSGiGa/heartbeatflare/actions/workflows/deploy-cloudflare.yml)

Serverless uptime monitor and status page that runs entirely on the Cloudflare free tier. A single Worker probes your targets every minute, tracks incidents, sends notifications, and serves public/private status pages — no servers, no agents, no build step.

Live demo: [status.hsgiga.workers.dev](https://status.hsgiga.workers.dev/)

## What it gives you

heartbeatflare is meant for teams that want a small, auditable status page without running a
monitoring server. You keep the desired state in `config.yaml`, deploy it to Cloudflare, and the
Worker does the boring work: probe services, track incidents, notify people, and render status
pages.

### Monitoring

- **HTTP/HTTPS checks** for health endpoints, public websites, APIs and internal services exposed
  through Cloudflare Workers VPC.
- **TCP checks** for ports such as SMTP, Redis, Postgres, load balancers or any service where "can I
  connect?" is the useful signal.
- **DNS checks** for public hostnames, useful when DNS availability is part of the service contract.
- **Heartbeat checks** for jobs that push their own success signal: backups, cron jobs, queue
  consumers, ETL runs and similar background work.

Each monitor has its own interval (60s minimum), visibility (`public` or `private`), network mode
(`external` or `internal`), alert rules and optional notification routing. Visibility controls where
the result is shown; mode controls how the Worker reaches the target.

### Status pages

- **Public page** for customer-facing service status at `/public`.
- **Private page** for operator-only monitors at `/private`, protected by Cloudflare Access when you
  turn it on.
- **90-day uptime bars, latency sparklines and incident history** for quick triage.
- **Atom feed and SVG badges** so you can embed service status in docs, dashboards or README files.

### Incidents and alerts

- **Failure and recovery thresholds** to avoid noise from one-off blips.
- **Cooldowns and escalation reminders** for targets that flap or stay down.
- **Separate connectivity and SSL-expiry incidents** so certificate problems do not hide real outage
  state.
- **Maintenance windows** that pause checks for planned work and show a banner on the status page.

### Notifications

- **Slack-compatible webhooks** including Mattermost and similar tools.
- **Generic JSON webhooks** for incident routers, automation platforms or custom receivers.
- **Telegram Bot API** for chat alerts.
- **Cloudflare Email Service** for email notifications without SMTP credentials.
- **Cloudflare Queues delivery** so notification sends can retry outside the probe request.

### Deployment model

- **Configuration as code:** monitors, alert rules, channels, Access settings and maintenance windows
  live in one `config.yaml`.
- **Automatic Cloudflare data-plane setup:** D1 and the notification queue are created by name during
  deployment.
- **Manual Cloudflare control-plane setup where it matters:** Access apps, API tokens, Email Routing
  verification, custom-domain zones and Workers VPC resources stay explicit and reviewable.
- **Free-plan aware:** designed around D1 write budgets and edge caching, with roughly 30 monitors at
  60-second intervals as a practical baseline.

## How it works

One Worker, three entry points: `scheduled()` runs every minute to probe due monitors, evaluate alert rules and open/resolve incidents; `fetch()` serves the `/public` and `/private` status pages, a JSON API, the Atom feed and SVG badges; `queue()` delivers notifications with retry. State lives in Cloudflare D1. See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design, data model and free-plan budgets.

## Quick start

1. **Create your repo:** click **Use this template** on GitHub, then clone your new repository and run `npm ci`.
2. **Add Cloudflare deploy credentials:** `cp .env.example .env`, then fill in `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (see [token scopes](docs/DEPLOYMENT.md#cloudflare-api-token-permissions)).
3. **Create your config:** `cp config.example.yaml config.yaml`, then set `deploy.name` and your monitors (full [configuration reference](docs/CONFIGURATION.md)).
4. **Deploy:** `set -a; . ./.env; set +a` then `npm run deploy:prod` — or push to `main` and let GitHub Actions deploy.
5. **Open `/public`** on the deployed Worker URL.

> The private page and Cloudflare Access are **optional** — `/public` deploys and works without any auth config. Set up Access when you want `/private` (see [Cloudflare Access for `/private`](docs/DEPLOYMENT.md#cloudflare-access-for-private)).

First time? Follow the step-by-step [Getting Started](docs/GETTING_STARTED.md) guide. For local development:

```sh
git clone https://github.com/HSGiGa/heartbeatflare.git && cd heartbeatflare
npm ci
npm run dev    # local Worker at http://localhost:8787
npm test       # Vitest with the Workers runtime
```

## Minimal config

```yaml
deploy:
  name: status            # worker name; D1/queue names derive from it

monitors:
  - name: Example API
    type: http            # http | tcp | dns | heartbeat
    mode: external
    visibility: public    # public | private
    target: https://api.example.com/health
    interval: 60s
    alerts:
      - condition: "status != 200"
        severity: critical
        failures: 2
        recovery: 2
```

The full field reference — every monitor type, alert condition, notification channel, maintenance windows and `${VAR}` secrets — is in [CONFIGURATION.md](docs/CONFIGURATION.md).

## Documentation

- [Getting Started](docs/GETTING_STARTED.md) — first successful deploy from zero
- [Configuration](docs/CONFIGURATION.md) — full `config.yaml` reference
- [Deployment](docs/DEPLOYMENT.md) — GitHub Actions, local CLI and GitLab CI; token scopes, manual Cloudflare resources, secrets, verification
- [Troubleshooting](docs/TROUBLESHOOTING.md) — common Cloudflare setup failures
- [Architecture](docs/ARCHITECTURE.md) — system design, data model, free-plan budgets

The docs are plain Markdown today. The structure is intentionally close to what an MkDocs site can
use later for Cloudflare Pages or GitHub Pages: overview first, task guides next, then reference
pages.

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and conventions. Security policy: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
