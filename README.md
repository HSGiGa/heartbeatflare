# heartbeatflare

[![Deploy to Cloudflare](https://github.com/YOUR_USERNAME/heartbeatflare/actions/workflows/deploy-cloudflare.yml/badge.svg)](https://github.com/YOUR_USERNAME/heartbeatflare/actions/workflows/deploy-cloudflare.yml)

Serverless uptime monitor and status page that runs entirely on the Cloudflare free tier. A single Worker probes your targets every minute, tracks incidents, sends notifications, and serves public/private status pages — no servers, no agents, no build step.

Live example: [status.modem.by](https://status.modem.by)

## Features

- **HTTP/HTTPS, TCP and DNS probes** with per-monitor intervals (60s minimum)
- **Heartbeat (push) monitors** — a cron job / backup script `POST`s to a per-monitor URL; an incident opens when the beats stop arriving (dead-man's switch)
- **SSL certificate expiry tracking** (best-effort, via external cert APIs)
- **Incident management** — connectivity and SSL incidents tracked independently, with failure/recovery thresholds, cooldowns and optional escalation re-notifications
- **Notifications** via Slack-compatible webhooks (e.g. Mattermost) and generic webhooks, delivered through Cloudflare Queues with retry
- **Public + private status pages** — 90-day uptime bars, latency sparklines, incident history; the private view is protected by Cloudflare Access
- **Maintenance windows** — announce planned work in `config.yaml`; the status page shows a banner and affected monitors aren't probed (no false incidents, uptime unaffected) while a window is active
- **Atom feed** — `/feed.xml` publishes incidents and maintenance windows for any feed reader / Slack-RSS bridge; no email, no subscriber database
- **Status badges** — embeddable SVG (`/badge/<monitor>.svg`) showing a public monitor's state in a README, docs or dashboard
- **Configuration as code** — monitors, alerts, channels, maintenance and access policy live in one `config.yaml`; CI provisions all Cloudflare resources automatically
- **Free-plan native** — designed around D1 write budgets, subrequest limits and edge caching (~30 monitors at 60s intervals)

## How it works

One Worker, three entry points:

- **`scheduled()`** — cron tick every minute: selects due monitors (oldest-checked first), probes them with bounded concurrency, stores results in D1, evaluates alert rules, opens/resolves incidents and enqueues notifications. Also re-enqueues escalation notifications for incidents still open past their `escalation` interval, and runs hourly uptime rollups and daily cleanup.
- **`fetch()`** — serves `/public` and `/private` status pages, a JSON API (`/api/status`, `/api/history`), an Atom feed (`/feed.xml`) and SVG status badges (`/badge/<monitor>.svg`). Visibility is fail-closed: private monitors are only shown with a valid Cloudflare Access session, and feed/badges expose public monitors only. Public responses are edge-cached for 60s.
- **`queue()`** — consumes the notification queue and delivers incident open / resolve / escalation messages to the configured channels.

Storage is Cloudflare D1 (state, incidents, time series, uptime aggregates). See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design, data model and free-plan budgets.

## Quick start

Prerequisites:

- A Cloudflare account with the zone for your status domain
- A Zero Trust identity provider (for the private page), set up in the Cloudflare dashboard
- A deploy API token with the permissions listed in [Environment variables](#environment-variables)

```sh
git clone https://github.com/YOUR_USERNAME/heartbeatflare.git && cd heartbeatflare
npm ci

cp .env.example .env   # fill in CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
set -a; . ./.env; set +a

# edit config.yaml (deploy name/domain, monitors, channels), then:
npm run deploy:prod
```

`deploy:prod` runs the whole pipeline: tests → migration lint → **provision** (creates the D1 database and queue, writes the IDs back to `config.yaml`) → D1 migrations → Cloudflare Access app → config import → `wrangler deploy`. No resource IDs need to be entered by hand. Details in [DEPLOYMENT.md](docs/DEPLOYMENT.md).

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
    type: http # http | tcp | dns | heartbeat
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

### Alert parameters

Each entry under `alerts:` supports:

| Field        | Required | Description |
| ------------ | -------- | ----------- |
| `condition`  | yes      | What triggers the alert — see below |
| `severity`   | yes      | `critical` or `warning` |
| `failures`   | yes      | Consecutive failing checks before an incident opens |
| `recovery`   | yes      | Consecutive successful checks before the incident resolves |
| `cooldown`   | no       | Minimum pause between two incidents on the same monitor (e.g. `300s`, `5m`). Prevents notification spam from a flapping target. Measured from when the previous incident **closed**. Default: `0` (no cooldown) |
| `escalation` | no       | Re-send a "STILL DOWN" notification if the incident stays open longer than this interval (e.g. `15m`, `2h`). Repeats every interval until resolved. Default: disabled (one alert only) |

#### condition

| Condition | Monitor types | Meaning |
| --------- | ------------- | ------- |
| `status != 200` | http | HTTP response code is not 200 (any non-2xx is treated as down) |
| `connect != true` | tcp | TCP connection could not be established |
| `status != up` | dns, heartbeat | DNS query returned no records / timed out; for a heartbeat, an expected beat was missed |
| `latency >= 500` | http, tcp | Round-trip latency exceeded the threshold in milliseconds (`>`, `<`, `>=`, `<=` are all supported) |
| `ssl_expiry < 14` | http, tcp (with ssl) | Days until certificate expiry is below the threshold. Two default rules (`< 7` warning, `< 1` critical) are added automatically unless you configure your own |

A monitor can have multiple alert rules (e.g. one for connectivity, one for SSL expiry). Each rule tracks incidents independently — an SSL incident does not suppress a connectivity incident and vice versa.

Notes:

- Secrets never go into YAML or D1 — use `${VAR}` placeholders, resolved from the Worker's environment when a notification is sent.
- `auth.team_domain` and `auth.aud` are written back automatically by the deploy pipeline.
- `wrangler.jsonc` is generated from [`wrangler.template.jsonc`](wrangler.template.jsonc) — run any npm script (dev, test, deploy) and it's created automatically. Don't edit it directly.
- The import is idempotent: removing a monitor from YAML soft-disables it, runtime history is preserved.

### Maintenance windows

Announce planned work with an optional top-level `maintenance:` list. While a window is active the
affected monitors are **not probed** (so there's no false incident and uptime isn't dragged down),
and the status page shows a banner. Times are ISO 8601 UTC. Omit `monitors:` for a global window.

```yaml
maintenance:
  - title: 'Database migration'
    body: 'Upgrading the primary Postgres cluster.'
    starts_at: '2026-06-20T02:00:00Z'
    ends_at: '2026-06-20T04:00:00Z'
    monitors: [Example API] # omit for all monitors
```

Like everything else, windows are imported into D1 by `config:import` — declaring one is a config
change (git commit + deploy). Removing a window from YAML deletes it.

### Heartbeat (push) monitoring

A `heartbeat` monitor is a dead-man's switch: instead of the Worker probing a target, your job calls
the Worker. Each successful run sends `POST /beat/<monitor-id>/<token>`; if no beat arrives within
the monitor's `interval`, the scheduler records a miss, and after `failures` consecutive misses it
opens an incident — exactly like a failed probe. Use it for cron jobs, backups, queue workers and
anything that should "check in" on a schedule.

```yaml
monitors:
  - name: Backup job
    type: heartbeat
    mode: external
    visibility: private
    interval: 10m # the expected beat period (supports s / m / h / d)
    alerts:
      - condition: 'status != up'
        severity: critical
        failures: 1 # open an incident after this many missed intervals
        recovery: 1
```

`target` is omitted (and ignored) for heartbeat monitors. The monitor name maps to **two** derived
identifiers — you never type them in YAML, but you need both:

| Form | Example | Where it's used |
| ---- | ------- | --------------- |
| Monitor id (lowercase, hyphenated) | `backup-job` | the beat URL path |
| Worker Secret (uppercase, underscored) | `HEARTBEAT_BACKUP_JOB_TOKEN` | holds the token value |

The token is **not** stored in `config.yaml` or D1 — only the reference `secret:HEARTBEAT_…_TOKEN`
is imported. The value lives in a Cloudflare Worker Secret that is **generated automatically on
deploy**: the `secrets:sync` step (part of `npm run deploy:prod` and CI) creates a random token for
any heartbeat monitor that doesn't already have one, and **prints it once** in the deploy output —
copy it from there into your job:

```
=== New heartbeat tokens generated — SAVE THESE NOW (not shown again) ===
  Monitor:  Backup job
  Secret:   HEARTBEAT_BACKUP_JOB_TOKEN = 9f3a…c21
  Beat URL: curl -fsS -X POST "https://status.modem.by/beat/backup-job/9f3a…c21"
```

A secret's value is **not shown again** after creation. The secret's *name* is listed in the
dashboard under **Workers & Pages → heartbeatflare → production → Settings → Variables and Secrets**
([direct link for this instance](https://dash.cloudflare.com/0a8f78933036db3025075e950a307acd/workers/services/view/heartbeatflare/production/settings)).
Existing tokens are left untouched across deploys; to **rotate**, delete the secret there and redeploy
(a fresh token is generated and printed). You can also set your own value ahead of time via CI env or
`npx wrangler secret put HEARTBEAT_BACKUP_JOB_TOKEN`, and it will be used instead of a generated one.

Then have the job beat on each successful run:

```sh
curl -fsS -X POST "https://status.modem.by/beat/backup-job/$HEARTBEAT_BACKUP_JOB_TOKEN"
```

The endpoint is `POST`-only (other methods return `405`), never cached, and not behind Cloudflare
Access. It returns `204` on a valid beat and `404` for an unknown monitor, a wrong/missing token, or
a disabled monitor — so it never reveals whether a given monitor exists. Requests are rate-limited
per source IP and per monitor (`429` when exceeded), and repeated beats well inside the interval are
accepted without a D1 write to stay within the free-plan budget.

### Public endpoints

| Endpoint | Description |
| -------- | ----------- |
| `/public` | Public status page (public monitors only) |
| `/feed.xml` | Atom 1.0 feed of incidents + maintenance windows (public monitors only) |
| `/badge/<monitor>.svg` | SVG status badge for a public monitor; `?label=` overrides the left text. Private/unknown monitors return 404 |
| `POST /beat/<monitor-id>/<token>` | Heartbeat ingest for `heartbeat` monitors. `204` on success, `404`/`405`/`429` otherwise. Not cached, no Access (see [Heartbeat](#heartbeat-push-monitoring)) |

`<monitor>` is the slug of the monitor name (lowercased, non-alphanumerics → `-`). Embed a badge with:

```markdown
![status](https://status.example.com/badge/example-api.svg)
```

### Environment variables

Two kinds of variables, both templated in [`.env.example`](.env.example):

| Variable                       | Kind        | Purpose                                                                                                         |
| ------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`         | deploy-time | Used by the deploy scripts and CI (provision, Access app, config import). Never reaches the Worker.             |
| `CLOUDFLARE_ACCOUNT_ID`        | deploy-time | Same; also injected into the generated `wrangler.jsonc` vars for the usage block.                               |
| `CLOUDFLARE_GRAPHQL_API_TOKEN` | runtime     | Optional. Enables the Infrastructure Usage block on the private page (D1:Read + Account Analytics:Read).        |
| `MATTERMOST_WEBHOOK_URL`, …    | runtime     | Custom notification variables — one per `${VAR}` placeholder in `config.yaml` notification channels, same name. |

Recommended Cloudflare API token permissions:

| Token                          | Required permissions                                                                                                                                                               | Notes                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`         | Workers Scripts:Edit, D1:Edit, Queues:Edit, Access Apps and Policies:Edit, Access Organizations:Read, Access Identity Providers:Read                                               | Used only by deploy/provision scripts and CI. Add Workers Routes:Edit and Zone:Read if deploying a custom domain route.      |
| `CLOUDFLARE_GRAPHQL_API_TOKEN` | Account Analytics:Read, D1:Read                                                                                                                                                    | Optional runtime secret for the private Infrastructure Usage block. Add Account Billing:Read to detect Free vs Workers Paid. |
| Webhook secrets                | None in Cloudflare                                                                                                                                                                 | Values like `MATTERMOST_WEBHOOK_URL` are third-party webhook credentials, stored as Worker secrets and resolved at send time. |

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
| `npm run provision`       | Create D1 + queue if missing, write IDs to `config.yaml` (`--dry-run` supported) |
| `npm run d1:migrate:prod` | Apply D1 migrations (additive-only, linted)                                       |
| `npm run deploy:access`   | Create/update the Cloudflare Access app for `/private`                            |
| `npm run config:import`   | Push `config.yaml` monitors/alerts/channels into D1                               |
| `npm run deploy`          | Generate `wrangler.jsonc` then `wrangler deploy`                                  |
| `npm run deploy:prod`     | All of the above, in order, with tests first                                      |

CI does the same on every push to `main` (GitHub Actions and GitLab CI), finishing with a smoke test of the deployed Worker. Required CI secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Project structure

| Path                             | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `src/index.ts`                   | Worker entry point — dispatches fetch / scheduled / queue        |
| `src/scheduler.ts`               | Cron tick: select due monitors, probe, detect missed heartbeats, rollup, cleanup |
| `src/probes.ts`                  | HTTP, TCP, DNS and SSL-expiry probe implementations              |
| `src/heartbeat.ts`               | Heartbeat ingest endpoint (`POST /beat/<id>/<token>`)            |
| `src/alerts.ts`                  | Result store (write-budget aware) + alert evaluation + incidents |
| `src/queue.ts` / `src/notify.ts` | Notification delivery and channel resolution                     |
| `src/routes.ts`                  | HTTP routing, edge caching, JSON API, feed + badge endpoints     |
| `src/status-page.ts`             | Server-rendered status page (uptime bars, sparklines, maintenance) |
| `src/feed.ts`                    | Atom feed builder (`/feed.xml`)                                  |
| `src/badge.ts` / `src/status-meta.ts` | SVG status badge + shared status→label/colour mapping       |
| `src/auth.ts`                    | Cloudflare Access JWT verification (fail-closed)                 |
| `src/usage.ts`                   | Account usage block (Cloudflare GraphQL API)                     |
| `scripts/`                       | Provisioning, Access setup, config import (deploy-time, Node)    |
| `migrations/`                    | D1 schema migrations (additive-only)                             |

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — full system design, data model, free-plan budgets
- [DEPLOYMENT.md](docs/DEPLOYMENT.md) — deployment paths, token scopes, CI setup
- [ROADMAP.md](docs/ROADMAP.md) — planned features
