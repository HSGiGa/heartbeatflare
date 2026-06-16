# Getting Started

This guide walks you from an empty Cloudflare account to a live status page, the happy path, in a
few minutes. It uses **GitHub Actions** for deployment; for the local CLI or GitLab CI, and for the
full reference on every option, see [DEPLOYMENT.md](DEPLOYMENT.md).

## What you'll deploy

One Cloudflare Worker, one D1 database and one notification queue — all on the free tier, all
provisioned for you from `config.yaml`. The Worker probes your targets every minute and serves a
public status page at `/public`. A private page (`/private`) behind Cloudflare Access is optional and
covered at the end.

## Prerequisites

- A **Cloudflare account** (free tier is enough).
- **Node.js 24** and **git** locally.
- A **GitHub repository** with this code (clone it, or fork/push your own copy).
- A **Cloudflare API token** — created in step 2.

## 1. Get the code

```sh
git clone https://github.com/HSGiGa/heartbeatflare.git
cd heartbeatflare
npm ci
```

## 2. Create a Cloudflare API token

In the Cloudflare dashboard, create an API token with these permissions:

- **Workers Scripts: Edit**
- **D1: Edit**
- **Queues: Edit**

(Add **Workers Routes: Edit** and **Zone: Read** only if you'll deploy to a custom domain.) Note the
token value and your **Account ID** (shown on the dashboard right sidebar). Full scope details:
[Cloudflare API token permissions](DEPLOYMENT.md#cloudflare-api-token-permissions).

## 3. Add GitHub secrets

In your repository: **Settings → Secrets and variables → Actions → New repository secret**.

**Required:**

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

**Optional (add later when you need them):**

- `CLOUDFLARE_ACCESS_TEAM_NAME`, `CLOUDFLARE_ACCESS_AUD` — for the private page (step 7)
- notification secrets referenced in `config.yaml`, e.g. `MATTERMOST_WEBHOOK_URL`,
  `TELEGRAM_BOT_TOKEN`

> Add the required secrets **before** your first push — the deploy workflow runs on every push to
> `main` and will fail without them.

## 4. Edit `config.yaml`

Set `deploy.name` and define at least one monitor. A minimal public HTTP monitor:

```yaml
deploy:
  name: status

monitors:
  - name: Example API
    type: http
    mode: external
    visibility: public
    target: https://api.example.com/health
    interval: 60s
    alerts:
      - condition: "status != 200"
        severity: critical
        failures: 2
        recovery: 2
```

See [CONFIGURATION.md](CONFIGURATION.md) for every monitor type, alert condition and notification
channel.

## 5. Deploy

Commit and push to `main`:

```sh
git add config.yaml
git commit -m "Configure my monitors"
git push origin main
```

GitHub Actions runs the full pipeline — tests, provision (creates your D1 database and queue),
migrations, config import, `wrangler deploy`, secrets sync — and finishes with a smoke test. Watch
it under the repository **Actions** tab. (You can also deploy locally with `npm run deploy:prod`; see
[Local CLI](DEPLOYMENT.md#local-cli).)

## 6. Verify

The deploy log prints the Worker URL. Open `/public`:

```
https://status.<your-subdomain>.workers.dev/public
```

It should return HTTP 200 and render your monitor. The workflow's smoke test checks this
automatically and fails the run if `/public` isn't healthy. If anything went wrong, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## 7. Next steps

- **Add notifications** — define a Slack/webhook/Telegram channel and the matching `${VAR}` secret
  ([Notification channels](CONFIGURATION.md#notification_channels)).
- **Configure the private page** — create a Cloudflare Access application scoped to `/private` and
  add the `auth` block ([Cloudflare Access for `/private`](DEPLOYMENT.md#cloudflare-access-for-private)).
- **Add heartbeat monitors** — a dead-man's switch for cron jobs and backups
  ([Heartbeat monitors](CONFIGURATION.md#heartbeat-push-monitors)).
- **Hit a snag?** — [TROUBLESHOOTING.md](TROUBLESHOOTING.md) covers the common Cloudflare setup
  failures.
