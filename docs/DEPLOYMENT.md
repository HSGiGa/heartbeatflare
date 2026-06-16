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

| Token | Required permissions | Notes |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Workers Scripts: Edit, D1: Edit, Queues: Edit | Used only by deploy/provision scripts and CI; never reaches the Worker. Add **Workers Routes: Edit** and **Zone: Read** if deploying a custom domain route. |
| `CLOUDFLARE_GRAPHQL_API_TOKEN` | Account Analytics: Read, D1: Read | Optional runtime secret for the private Infrastructure Usage block. Add **Account Billing: Read** to detect Free vs Workers Paid. |
| Notification secrets | None in Cloudflare | Values like `MATTERMOST_WEBHOOK_URL` or `TELEGRAM_BOT_TOKEN` are third-party credentials, stored as Worker secrets and resolved at send time. |

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are **deploy-time** credentials — they live in
`.env` locally and in CI secrets, and never reach the Worker.

## Runtime Worker secrets

Values the Worker needs at **request time** — `CLOUDFLARE_ACCESS_TEAM_NAME` /
`CLOUDFLARE_ACCESS_AUD` for Access verification, the optional `CLOUDFLARE_GRAPHQL_API_TOKEN` for the
usage block, and one variable per `${VAR}` placeholder in `config.yaml` notification channels
(e.g. `MATTERMOST_WEBHOOK_URL`). In local dev and tests these are read from `.env`. For production,
both paths below work and can be mixed:

**Automatic (recommended).** Add each secret to GitHub repository secrets / GitLab CI variables under
the same name. The `secrets:sync` step (`scripts/sync-secrets.ts`) runs after every deploy: it
discovers required names from `${VAR}` references in `config.yaml` and pushes them all to Cloudflare
Worker secrets in one bulk call. A referenced name absent from CI is skipped (value kept) when the
secret already exists on the Worker. When a referenced secret exists in neither place, the step
prints a warning and the deploy proceeds — the affected feature stays broken until the secret is
added. Optional secrets (`CLOUDFLARE_GRAPHQL_API_TOKEN`) warn instead of failing. `npm run deploy:prod`
runs the same sync using your local `.env`.

**Manual.** Upload each secret once by hand; it persists across deployments and the sync step simply
overwrites it with the same value on the next run:

```sh
npx wrangler secret put CLOUDFLARE_ACCESS_TEAM_NAME
npx wrangler secret put CLOUDFLARE_ACCESS_AUD
npx wrangler secret put CLOUDFLARE_GRAPHQL_API_TOKEN
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

## Cloudflare Access for `/private`

The private status page is **optional** — `/public` deploys and works without any auth config. Set
up Access when you want `/private`.

Create a Cloudflare Access **self-hosted application** manually in the dashboard.

> **Scope the application to the `/private` path, not the bare host.** Access gates by URL
> (hostname **+ path**). Set the application Destination to `<your-host>/private` (e.g.
> `status.example.com/private` or `status.<subdomain>.workers.dev/private`). If you point it at the
> bare hostname, Access walls off the **entire** site — the public status page (`/`, `/public`,
> `/feed.xml`, `/badge/*`) included. With the `/private` path scope, only `/private` is gated at the
> edge; the Worker then verifies the injected Access JWT and everything else stays public.

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
