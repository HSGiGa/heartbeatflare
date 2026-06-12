# heartbeatflare

[![Deploy to Cloudflare](https://github.com/HSGiGa/heartbeatflare/actions/workflows/deploy-cloudflare.yml/badge.svg)](https://github.com/HSGiGa/heartbeatflare/actions/workflows/deploy-cloudflare.yml)

Serverless uptime monitor and status page that runs entirely on the Cloudflare free tier. A single Worker probes your targets every minute, tracks incidents, sends notifications, and serves public/private status pages — no servers, no agents, no build step.

Live example: [status.modem.by](https://status.modem.by)

## Features

- **HTTP/HTTPS, TCP and DNS probes** with per-monitor intervals (60s minimum)
- **SSL certificate expiry tracking** (best-effort, via external cert APIs)
- **Incident management** — connectivity and SSL incidents tracked independently, with failure/recovery thresholds and cooldowns
- **Notifications** via Slack-compatible webhooks (e.g. Mattermost) and generic webhooks, delivered through Cloudflare Queues with retry
- **Public + private status pages** — 90-day uptime bars, latency sparklines, incident history; the private view is protected by Cloudflare Access
- **Configuration as code** — monitors, alerts, channels and access policy live in one `config.yaml`; CI provisions all Cloudflare resources automatically
- **Free-plan native** — designed around D1 write budgets, subrequest limits and edge caching (~30 monitors at 60s intervals)

## How it works

One Worker, three entry points:

- **`scheduled()`** — cron tick every minute: selects due monitors (oldest-checked first), probes them with bounded concurrency, stores results in D1, evaluates alert rules, opens/resolves incidents and enqueues notifications. Also runs hourly uptime rollups and daily cleanup.
- **`fetch()`** — serves `/public` and `/private` status pages plus a JSON API (`/api/status`, `/api/history`). Visibility is fail-closed: private monitors are only shown with a valid Cloudflare Access session. Public responses are edge-cached for 60s.
- **`queue()`** — consumes the notification queue and delivers incident open/resolve messages to the configured channels.

Storage is Cloudflare D1 (state, incidents, time series, uptime aggregates). See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design, data model and free-plan budgets.

## Quick start

Prerequisites:

- A Cloudflare account with the zone for your status domain
- A Zero Trust identity provider (for the private page), set up in the Cloudflare dashboard
- An API token with: Workers Scripts:Edit, D1:Edit, Queues:Edit, Access Apps & Policies:Edit, Access Organizations:Read

```sh
git clone https://github.com/HSGiGa/heartbeatflare.git && cd heartbeatflare
npm ci

cp .env.example .env   # fill in CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
set -a; . ./.env; set +a

# edit config.yaml (deploy name/domain, monitors, channels), then:
npm run deploy:prod
```

`deploy:prod` runs the whole pipeline: tests → migration lint → **provision** (creates the D1 database and queue, auto-fills `wrangler.jsonc` with their IDs) → D1 migrations → Cloudflare Access app → config import → `wrangler deploy`. No resource IDs need to be entered by hand. Details in [DEPLOYMENT.md](DEPLOYMENT.md).

Local development:

```sh
npm run dev    # local Worker at http://localhost:8787
npm test       # Vitest with the Workers runtime
```

## Configuration

Everything lives in [`config.yaml`](config.yaml) (validated by [`config.schema.json`](config.schema.json)):

```yaml
deploy:
  name: heartbeatflare # worker name; D1/queue names derive from it
  domain: status.example.com # custom domain; omit for workers.dev only

access: # Cloudflare Access app for the /private page
  app_name: heartbeatflare
  identity_provider: 'login.example.com'
  policy:
    name: Allow team
    emails: [you@example.com]

notification_channels:
  - name: Mattermost
    type: slack
    url: ${MATTERMOST_WEBHOOK_URL} # resolved from Worker env at send time
    is_default: true

monitors:
  - name: Example API
    type: http # http | tcp | dns
    mode: external
    visibility: public # public | private
    target: https://api.example.com/health
    interval: 60s
    alerts:
      - condition: 'status != 200'
        severity: critical
        failures: 2
        recovery: 2
        cooldown: 300s
```

Notes:

- Secrets never go into YAML or D1 — use `${VAR}` placeholders, resolved from the Worker's environment when a notification is sent.
- `auth.team_domain` and `auth.aud` are written back automatically by the deploy pipeline.
- [`wrangler.jsonc`](wrangler.jsonc) holds platform settings (compatibility date, cron, queue tuning); `npm run provision` patches the resource IDs into it — don't edit those by hand.
- The import is idempotent: removing a monitor from YAML soft-disables it, runtime history is preserved.

### Environment variables

Two kinds of variables, both templated in [`.env.example`](.env.example):

| Variable                       | Kind        | Purpose                                                                                                         |
| ------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`         | deploy-time | Used by the deploy scripts and CI (provision, Access app, config import). Never reaches the Worker.             |
| `CLOUDFLARE_ACCOUNT_ID`        | deploy-time | Same; also injected into `wrangler.jsonc` vars by `provision` for the usage block.                              |
| `CLOUDFLARE_GRAPHQL_API_TOKEN` | runtime     | Optional. Enables the Infrastructure Usage block on the private page (D1:Read + Account Analytics:Read).        |
| `MATTERMOST_WEBHOOK_URL`, …    | runtime     | Custom notification variables — one per `${VAR}` placeholder in `config.yaml` notification channels, same name. |

Deploy-time credentials live in `.env` locally and in CI secrets. **Runtime** secrets are read from `.env` by `wrangler dev` and the test runner; for production there are two equivalent ways to get them into the Worker:

1. **Automatic (CI)** — add each secret to GitHub repository secrets / GitLab CI variables under the same name. The `secrets:sync` pipeline step pushes them all to Cloudflare Worker secrets after each deploy and checks that every `${VAR}` referenced in `config.yaml` is covered: a name absent from CI is skipped if it already exists on the Worker (e.g. uploaded manually), and if it's missing in both places the step prints a warning — the deploy still succeeds, but notifications using that variable won't work until the secret is added. `npm run deploy:prod` does the same using your local `.env`.

2. **Manual** — upload each secret once by hand; it persists across deployments:

   ```sh
   npx wrangler secret put CLOUDFLARE_GRAPHQL_API_TOKEN
   npx wrangler secret put MATTERMOST_WEBHOOK_URL
   ```

Adding a new notification channel with `url: ${MY_NEW_HOOK}` means adding a `MY_NEW_HOOK` secret the same way (CI secret or `wrangler secret put`) — the Worker substitutes it at send time, so the value never appears in YAML, D1 or git.

## Deployment

| Script                    | What it does                                                                     |
| ------------------------- | -------------------------------------------------------------------------------- |
| `npm run provision`       | Create D1 + queue if missing, auto-fill `wrangler.jsonc` (`--dry-run` supported) |
| `npm run d1:migrate:prod` | Apply D1 migrations (additive-only, linted)                                      |
| `npm run deploy:access`   | Create/update the Cloudflare Access app for `/private`                           |
| `npm run config:import`   | Push `config.yaml` monitors/alerts/channels into D1                              |
| `npm run deploy`          | `wrangler deploy`                                                                |
| `npm run deploy:prod`     | All of the above, in order, with tests first                                     |

CI does the same on every push to `main` (GitHub Actions and GitLab CI), finishing with a smoke test of the deployed Worker. Required CI secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Project structure

| Path                             | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `src/index.ts`                   | Worker entry point — dispatches fetch / scheduled / queue        |
| `src/scheduler.ts`               | Cron tick: select due monitors, probe, rollup, cleanup           |
| `src/probes.ts`                  | HTTP, TCP, DNS and SSL-expiry probe implementations              |
| `src/alerts.ts`                  | Result store (write-budget aware) + alert evaluation + incidents |
| `src/queue.ts` / `src/notify.ts` | Notification delivery and channel resolution                     |
| `src/routes.ts`                  | HTTP routing, edge caching, JSON API                             |
| `src/status-page.ts`             | Server-rendered status page (uptime bars, sparklines)            |
| `src/auth.ts`                    | Cloudflare Access JWT verification (fail-closed)                 |
| `src/usage.ts`                   | Account usage block (Cloudflare GraphQL API)                     |
| `scripts/`                       | Provisioning, Access setup, config import (deploy-time, Node)    |
| `migrations/`                    | D1 schema migrations (additive-only)                             |

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — full system design, data model, free-plan budgets
- [DEPLOYMENT.md](DEPLOYMENT.md) — deployment paths, token scopes, CI setup
- [ROADMAP.md](ROADMAP.md) — planned features
