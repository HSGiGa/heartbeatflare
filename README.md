# heartbeatflare

[![Deploy to Cloudflare](https://github.com/HSGiGa/heartbeatflare/actions/workflows/deploy-cloudflare.yml/badge.svg)](https://github.com/HSGiGa/heartbeatflare/actions/workflows/deploy-cloudflare.yml)

Serverless uptime monitor and status page that runs entirely on the Cloudflare free tier. A single Worker probes your targets every minute, tracks incidents, sends notifications, and serves public/private status pages — no servers, no agents, no build step.

Live demo: [status.hsgiga.workers.dev](https://status.hsgiga.workers.dev/)

## Features

- **HTTP/HTTPS, TCP, DNS and heartbeat (push) monitors** with per-monitor intervals (60s minimum)
- **Public + private status pages** — 90-day uptime bars, latency sparklines, incident history; the private view is gated by Cloudflare Access
- **Incident management** — connectivity and SSL-expiry incidents tracked independently, with failure/recovery thresholds, cooldowns and escalation re-notifications
- **Notifications** via Slack-compatible webhooks (e.g. Mattermost), generic webhooks and Telegram, delivered through Cloudflare Queues with retry
- **Maintenance windows, Atom feed (`/feed.xml`) and embeddable SVG status badges**
- **Configuration as code** — monitors, alerts and channels live in one `config.yaml`; CI provisions the D1 database and notification queue automatically
- **Free-plan native** — designed around D1 write budgets and edge caching (~30 monitors at 60s intervals)

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
- [Deployment](docs/DEPLOYMENT.md) — GitHub Actions, local CLI and GitLab CI; token scopes, secrets, verification
- [Troubleshooting](docs/TROUBLESHOOTING.md) — common Cloudflare setup failures
- [Architecture](docs/ARCHITECTURE.md) — system design, data model, free-plan budgets

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and conventions. Security policy: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
