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
- A **GitHub repository** created from this template (recommended), or your own copy of the code.
- A **Cloudflare API token** — created in step 2.

## 1. Create your repository

For a real deployment, create your own repository first:

1. Open `https://github.com/HSGiGa/heartbeatflare`.
2. Click **Use this template**.
3. Create a new repository under your account or organization.
4. Clone your new repository:

```sh
git clone https://github.com/<you>/<your-status-repo>.git
cd <your-status-repo>
npm ci
```

If you're contributing to heartbeatflare itself, clone the upstream repository instead.

> **Your generated repo is independent.** `Use this template` copies the files but **not** the
> upstream commit history, Issues, or secrets. You'll add your own Cloudflare secrets (step 3), and
> you may want to point the README badge and the demo link at your own deployment. To pull later
> improvements, see [Updating from upstream](#updating-from-upstream).

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

## 4. Create your `config.yaml`

The repo ships a ready-to-edit `config.example.yaml`; your own `config.yaml` is user-owned (it isn't
tracked upstream, so it won't conflict when you pull updates). Copy it:

```sh
cp config.example.yaml config.yaml
```

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

## Updating from upstream

A repository created with `Use this template` does **not** receive heartbeatflare updates
automatically. To pull later improvements, add this repo as a remote and merge:

```sh
git remote add upstream https://github.com/HSGiGa/heartbeatflare.git
git fetch upstream
git merge upstream/main
```

Your `config.yaml` is user-owned and not tracked upstream (the repo ships `config.example.yaml`), so
your monitors won't conflict with upstream changes. Resolve any conflicts in shared files, then
redeploy.
