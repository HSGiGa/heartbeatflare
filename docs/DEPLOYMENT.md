# Deployment

heartbeatflare deploys the same way through three paths — pick one:

- **[GitHub Actions](#github-actions-recommended)** — recommended; deploys on every push to `main`.
- **[Local CLI](#local-cli)** — one command from your machine.
- **[GitLab CI](#gitlab-ci)** — equivalent pipeline on GitLab.

All paths run the same pipeline: tests → migration lint → **provision** (create D1 + queue by name)
→ D1 migrations → config import → `wrangler deploy` → secrets sync → smoke test. Data-plane resources
(D1 database, notification queue) are provisioned automatically from `config.yaml` and resolved by
name into the generated `wrangler.jsonc`, so no resource IDs are ever stored in the repo.

You only need to supply credentials (below) and edit [`config.yaml`](CONFIGURATION.md).

## What is automated, and what is manual

heartbeatflare automates the Cloudflare resources that are safe to create by name on every deploy,
and leaves account/security resources for you to create explicitly. This keeps deploys repeatable
without hiding sensitive Cloudflare control-plane choices in application code.

### Created or reconciled by the deploy pipeline

- **Worker script:** `wrangler deploy`, using `deploy.name`.
- **D1 database:** `npm run provision`, created by name. Default: `${deploy.name}-prod-db`;
  override with `deploy.database_name`.
- **Notification queue:** `npm run provision`, created by name. Default:
  `${deploy.name}-notifications`; override with `deploy.queue_name`.
- **D1 schema:** `npm run d1:migrate:prod`, using tracked migrations.
- **Config rows in D1:** `npm run config:import`, including monitors, alert rules, notification
  channels, auth config and maintenance windows.
- **Worker secrets referenced by `${VAR}`:** `npm run secrets:sync`, uploaded from `.env`, CI
  variables or GitHub `secrets` context when available.
- **Heartbeat tokens:** `npm run secrets:sync`, auto-generated when missing and printed once.
- **Email send binding:** `npm run deploy`, generated in `wrangler.jsonc` when `type: email`
  channels exist.

### Must be prepared manually in Cloudflare

- **Cloudflare account and `CLOUDFLARE_ACCOUNT_ID`:** the project cannot choose the account for you.
  Copy the id from the Cloudflare dashboard account overview and store it in `.env` or CI secrets.
- **Deploy API token:** token scope is a security decision and depends on enabled features. Create it
  under Cloudflare dashboard → My Profile → API Tokens; see
  [token permissions](#cloudflare-api-token-permissions).
- **GitHub/GitLab secrets or local `.env`:** CI credentials and third-party secrets must be supplied
  outside the repo.
- **Custom-domain zone:** Cloudflare must already host the zone before a Worker route can use it.
- **Cloudflare Access application for `/private`:** Access policy, identity provider and allowed
  users are security policy. Configure it in Zero Trust → Access → Applications and scope it to
  `<host>/private`.
- **Email Routing destination verification:** recipients must confirm Cloudflare's verification email
  before delivery is allowed.
- **Workers VPC Networks, Services, Tunnels and policies:** private-network reachability and egress
  policy are infrastructure decisions. Manage them in Cloudflare, Wrangler, Terraform or your
  infrastructure repo.
- **Third-party notification receivers:** Slack, Mattermost, Telegram and webhook endpoints are owned
  outside Cloudflare. Put resulting tokens and URLs in secrets.

A good first deploy order is: create the API token, add CI secrets, create `config.yaml`, deploy once,
verify `/public`, then add optional pieces such as Access, Email and Workers VPC.

## GitHub Actions (recommended)

The workflow `.github/workflows/deploy-cloudflare.yml` deploys on push to `main` and on manual
`workflow_dispatch`.

1. **Add repository secrets** (Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (required — see
     [token permissions](#cloudflare-api-token-permissions))
   - any [runtime secrets](#runtime-worker-secrets) your `config.yaml` references
     (`CLOUDFLARE_ACCESS_TEAM_NAME`, `MATTERMOST_WEBHOOK_URL`, …)
2. **Edit `config.yaml`** and commit.
3. **Deploy** — push to `main`, or trigger the workflow manually
   (`gh workflow run deploy-cloudflare.yml`).
4. **Verify** — the workflow ends with a [smoke test](#verification) that fails the run if `/public`
   doesn't return HTTP 200.

> Add your Cloudflare secrets **before** the first push. The workflow runs the full deploy on every
> push to `main`; without credentials it fails at the provision/secrets step.

Instead of adding each secret by hand in the UI, bulk-import a filled-in local `.env` with the
[`gh` CLI](https://cli.github.com/) — it creates or updates one repository secret per line:

```sh
gh secret set --env-file .env
```

Fill in (or delete) every placeholder first: blank entries from `.env.example` would otherwise create
empty secrets, and `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` are deploy credentials you don't
want unset. Lines beginning with `#` are ignored. Add `--repo <owner>/<repo>` to target a specific
repository, or `--env <name>` to write environment-scoped secrets instead of repository ones.

GitHub repository secrets can't be enumerated individually from a workflow step, so the workflow
passes them all to the secrets-sync step via `SECRETS_CONTEXT: ${{ toJSON(secrets) }}`.

## Local CLI

```sh
npm ci
npm run cf:whoami          # verify Cloudflare authentication
```

Provide credentials by copying `.env.example` to `.env` and loading it (the file is gitignored):

```sh
cp .env.example .env       # fill in CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
set -a; . ./.env; set +a
```

Create your `config.yaml` from the tracked example, then edit and **commit** it (upstream ships only
`config.example.yaml`; a production deploy without your own `config.yaml` fails fast rather than
silently shipping the demo — local dev and tests still fall back to the example):

```sh
cp config.example.yaml config.yaml
```

Run the combined production flow:

```sh
npm run deploy:prod
```

It runs: tests → migration lint → provision → D1 migrations → config import → `wrangler deploy` →
secrets sync, reading runtime secrets from `.env`. Individual steps are available as separate
scripts:

| Script | What it does |
| --- | --- |
| `npm run provision` | Create D1 + queue if missing, by name (`--dry-run` supported). |
| `npm run d1:migrate:prod` | Apply D1 migrations (additive-only, linted). |
| `npm run config:import` | Push `config.yaml` monitors/alerts/channels into D1. |
| `npm run deploy` | Generate `wrangler.jsonc` then `wrangler deploy`. |
| `npm run secrets:sync` | Push `${VAR}` runtime secrets to the Worker (`--dry-run` supported). |
| `npm run deploy:prod` | All of the above, in order, with tests first. |

## GitLab CI

GitLab CI deploys on the default-branch pipeline and on a manual web pipeline. It runs the same
sequence as the other paths:

```sh
npm ci
npm run test
npm run migration:lint
npm run provision
npm run d1:migrate:prod
npm run config:import
npm run deploy
npm run secrets:sync
```

followed by the smoke test. Add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and any runtime
secrets as **protected, masked** CI/CD variables. GitLab CI variables are plain env vars, so the
secrets-sync step picks them up with no extra wiring.

## Cloudflare API token permissions

Create a Cloudflare API token with the scopes for what you deploy:

### Deploy token: `CLOUDFLARE_API_TOKEN`

Required permissions:

- Workers Scripts: Edit
- D1: Edit
- Queues: Edit

Add these when needed:

- Workers Routes: Edit and Zone: Read, when deploying a custom domain route.
- Email Routing Addresses: Read/Write and Email Sending: Write, when using `type: email` channels.

This token is used only by deploy/provision scripts and CI. It never reaches the Worker.

### Runtime token: `CLOUDFLARE_RUNTIME_API_TOKEN`

Optional runtime secret for the authenticated `/usage` Infrastructure Usage page. Base permissions:

- Account Analytics: Read
- D1: Read

Add these when needed:

- Account Billing: Read, to detect Free vs Workers Paid.
- Email Routing Addresses: Read, when using runtime email-recipient verification.
- Cloudflare Tunnel: Read, to show account tunnels and their live connection state on `/usage`.

### Notification secrets

Values like `MATTERMOST_WEBHOOK_URL` or `TELEGRAM_BOT_TOKEN` are third-party credentials. They do
not require Cloudflare token scopes; they are stored as Worker secrets and resolved at send time.

Email notifications use the Cloudflare Email Workers `send_email` binding, not SMTP. On the
Cloudflare Free Plan,
heartbeatflare sends only to verified Email Routing destination addresses. `npm run provision`
creates missing destination addresses and logs a warning until they are verified; deploy continues,
and runtime delivery skips unverified recipients with a warning until verification is complete.

For `mode: internal` monitors using **Cloudflare Workers VPC** (beta), the deploy token also needs
Workers VPC / Connectivity Directory permissions on the same account as the referenced Tunnel or VPC
Service:

| VPC use | Additional permissions |
| --- | --- |
| `vpc_services` with existing `service_id` | Connectivity Directory: Read, Connectivity Directory: Bind |
| `vpc_networks` with `tunnel_id` | Connectivity Directory: Read, Connectivity Directory: Admin |
| Wrangler local smoke tests / `wrangler tail` | Workers Tail: Read |

In the Cloudflare API token UI these may appear as permission groups such as **Connectivity Directory
Read**, **Connectivity Directory Bind**, and **Connectivity Directory Admin**. A token that only has
Cloudflare One Networks read/write permissions can still fail Workers VPC binding deploys with
`code: 10196` (`not authorized for the requested VPC resource`). The token must be scoped to the
account that owns the VPC Service / Tunnel.

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are **deploy-time** credentials — they live in
`.env` locally and in CI secrets, and never reach the Worker.

## Runtime Worker secrets

Values the Worker needs at **request time**:

- `CLOUDFLARE_ACCESS_TEAM_NAME` and `CLOUDFLARE_ACCESS_AUD` for Access verification.
- Optional `CLOUDFLARE_RUNTIME_API_TOKEN` for the usage block and email-recipient verification.
- One variable per `${VAR}` placeholder in `config.yaml` notification channels, for example
  `MATTERMOST_WEBHOOK_URL`.

In local dev and tests these are read from `.env`. For production, both paths below work and can be
mixed:

**Automatic (recommended).** Add each secret to GitHub repository secrets / GitLab CI variables under
the same name. The `secrets:sync` step (`scripts/sync-secrets.ts`) runs after every deploy: it
discovers required names from `${VAR}` references in `config.yaml` and pushes them all to Cloudflare
Worker secrets in one bulk call. A referenced name absent from CI is skipped (value kept) when the
secret already exists on the Worker. When a referenced secret exists in neither place, the step
prints a warning and the deploy proceeds — the affected feature stays broken until the secret is
added. Optional secrets (`CLOUDFLARE_RUNTIME_API_TOKEN`) warn instead of failing. `npm run deploy:prod`
runs the same sync using your local `.env`.

**Manual.** Upload each secret once by hand; it persists across deployments and the sync step simply
overwrites it with the same value on the next run:

```sh
npx wrangler secret put CLOUDFLARE_ACCESS_TEAM_NAME
npx wrangler secret put CLOUDFLARE_ACCESS_AUD
npx wrangler secret put CLOUDFLARE_RUNTIME_API_TOKEN
npx wrangler secret put MATTERMOST_WEBHOOK_URL
```

Or upload a file at once with `npx wrangler secret bulk <file>` (JSON or KEY=VALUE). Don't point it
at the full `.env` — that would push deploy-time credentials into the Worker, which it doesn't need;
pass a file containing only the runtime secrets.

Preview the required/optional secret list without credentials:

```sh
npm run secrets:sync -- --dry-run
```

Heartbeat-token secrets (`HEARTBEAT_<ID>_TOKEN`) are generated automatically by this step — see
[Heartbeat monitors](CONFIGURATION.md#heartbeat-push-monitors).

## Cloudflare Access for `/private` and `/usage`

The private status page is **optional** — `/public` deploys and works without any auth config. Set
up Access when you want `/private` or `/usage`.

Create a Cloudflare Access **self-hosted application** manually in the dashboard.

> **Scope the application to the `/private` and `/usage` paths, not the bare host.** Access gates by URL
> (hostname **+ path**). Create Access applications for `<your-host>/private` and
> `<your-host>/usage` (e.g. `status.example.com/private` and `status.example.com/usage`). If you point either at the
> bare hostname, Access walls off the **entire** site — the public status page (`/`, `/public`,
> `/feed.xml`, `/badge/*`) included. With the `/private` path scope, only `/private` is gated at the
> edge; the Worker then verifies the injected Access JWT and everything else stays public. The Worker
> independently returns `403` from `/usage` without a verified session.

Add the `auth` block to `config.yaml` as runtime placeholders:

```yaml
auth:
  provider: cloudflare_access
  team_name: "${CLOUDFLARE_ACCESS_TEAM_NAME}"
  aud: "${CLOUDFLARE_ACCESS_AUD}"
```

Then set `CLOUDFLARE_ACCESS_TEAM_NAME` and `CLOUDFLARE_ACCESS_AUD` as
[runtime Worker secrets](#runtime-worker-secrets) (CI variables, `.env` + `secrets:sync`, or
`wrangler secret put`).

## Provisioned resources

`npm run provision` creates the D1 database and notification queue if they don't exist
(find-by-name, idempotent). It writes nothing back to `config.yaml`. The deploy step generates
`wrangler.jsonc` (gitignored) from [`wrangler.template.jsonc`](../wrangler.template.jsonc) +
`config.yaml`, resolving the D1 id by name — so no resource IDs are stored in the repo. Don't edit
`wrangler.jsonc` directly; it is recreated by any npm script (dev, test, deploy).

Names default to `${deploy.name}-prod-db` and `${deploy.name}-notifications`, overridable via
`deploy.database_name` / `deploy.queue_name`. Preview names without credentials or API calls:

```sh
npm run provision -- --dry-run
```

One prerequisite that can't be automated: the zone for `deploy.domain` must already exist in the
Cloudflare account.

`npm run provision` does not create Cloudflare Access applications, API tokens, zones, Workers VPC
resources, Cloudflare Tunnels, Email Routing policies or third-party webhooks. Those resources are
security/infrastructure boundaries and should be reviewed where they are owned.

## Verification

After a deploy, `/public` on the deployed URL must return HTTP 200 (this is the CI smoke test), and
`/private` must redirect to the Access login page (when Access is configured).

```sh
npx wrangler d1 migrations list DB --remote        # binding DB resolves via wrangler.jsonc
npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```

If something fails, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Updating an existing deployment

Re-running any deploy path applies your latest `config.yaml` and code. The pipeline is idempotent:
provision and migrations are no-ops when nothing changed, `config:import` reconciles monitors/
channels (removed entries are soft-disabled), and `secrets:sync` only uploads new or changed
secrets. For GitHub Actions, just push to `main`.
