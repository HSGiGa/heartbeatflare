# Cloudflare Deployment

This project supports three production deployment paths:

- local CLI
- GitHub Actions
- GitLab CI

Deployable data-plane resources (D1 database and notification queue) are provisioned automatically from `config.yaml`. You provide only API credentials and the deployment inputs below — resources are identified by name (`<name>-prod-db`, `<name>-notifications`) and their IDs are resolved by name at deploy time into the generated `wrangler.jsonc`, so no IDs are stored in `config.yaml`. Cloudflare Access is configured manually in the Cloudflare dashboard; the Worker only verifies the resulting JWT at runtime.

## Required Cloudflare Variables

Create a Cloudflare API token with these permissions, then provide it together with your account ID:

- Workers Scripts: Edit
- D1: Edit
- Queues: Edit

```sh
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
```

For local CLI usage, either export the variables in your shell or copy `.env.example` to `.env` and load it before running npm scripts:

```sh
set -a
. ./.env
set +a
```

`.env` is ignored by git.

For GitHub Actions, add repository secrets; for GitLab CI, add protected and masked CI/CD variables:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

## Runtime Worker Secrets

The variables above are deploy-time only and never reach the Worker. Values the Worker needs at request time — `CLOUDFLARE_ACCESS_TEAM_NAME` / `CLOUDFLARE_ACCESS_AUD` for Cloudflare Access JWT verification, the optional `CLOUDFLARE_GRAPHQL_API_TOKEN` for the usage block, and one variable per `${VAR}` placeholder used in `config.yaml` notification channels (e.g. `MATTERMOST_WEBHOOK_URL`) — are read from `.env` in local dev and tests. For production, both paths work and can be mixed:

**Automatic (recommended):** add each secret to GitHub repository secrets / GitLab CI variables under the same name. The `secrets:sync` step (`scripts/sync-secrets.ts`) runs after every deploy: it discovers required names from `${VAR}` references in `config.yaml` and pushes them all to Cloudflare Worker secrets in one bulk call. A referenced name absent from CI is skipped (value kept) when the secret already exists on the Worker — so manually uploaded secrets don't have to be duplicated into CI. When a referenced secret exists in neither place, the step prints a warning and the deploy proceeds; the affected feature stays broken until the secret is added. On GitHub the workflow passes all repository secrets to the step via `SECRETS_CONTEXT: ${{ toJSON(secrets) }}` (repository secrets are not individually enumerable from a step); on GitLab CI variables are plain env vars and need no extra wiring. `npm run deploy:prod` runs the same sync using your local `.env`. Optional secrets (`CLOUDFLARE_GRAPHQL_API_TOKEN`) produce a warning instead of a failure when absent.

**Heartbeat tokens (auto-generated):** each `heartbeat` monitor needs a `HEARTBEAT_<ID>_TOKEN` secret (NAME derived from the monitor id). `secrets:sync` generates a random token for any heartbeat monitor that has none on the Worker, uploads it, and **prints it once** in the deploy output — copy it into the job's beat `curl`. Cloudflare never shows a secret value again, so save it then; existing tokens are kept across deploys. To rotate, delete the secret in the dashboard and redeploy. You can also pre-set your own value (CI env or `wrangler secret put`) and it will be used instead of a generated one.

**Manual:** upload each secret once by hand; it persists across deployments and the sync step simply overwrites it with the same value on the next CI run:

```sh
npx wrangler secret put CLOUDFLARE_ACCESS_TEAM_NAME
npx wrangler secret put CLOUDFLARE_ACCESS_AUD
npx wrangler secret put CLOUDFLARE_GRAPHQL_API_TOKEN
npx wrangler secret put MATTERMOST_WEBHOOK_URL
```

Or upload a whole file at once with `npx wrangler secret bulk <file>` (JSON or KEY=VALUE format). Don't point it at the full `.env` — that would also push the deploy-time credentials (`CLOUDFLARE_API_TOKEN` etc.) into the Worker, which it doesn't need; pass a file containing only the runtime secrets.

Preview the required/optional secret list without credentials:

```sh
npm run secrets:sync -- --dry-run
```

See the section comments in `.env.example` for the full list and required token scopes.

## Deployment Inputs (`config.yaml`)

The `deploy:` section is the single place to configure deployment:

```yaml
deploy:
  name: heartbeatflare # worker name; D1/queue names derive from it
  domain: status.example.com # custom domain route; omit to serve on workers.dev only
  # database_name: ... # default: ${name}-prod-db
  # queue_name: ...    # default: ${name}-notifications
```

`npm run provision` creates the D1 database and the notification queue if they do not exist (find-by-name, idempotent). It writes nothing back to `config.yaml`. The deploy step generates `wrangler.jsonc` (gitignored) from `wrangler.template.jsonc` + `config.yaml`, resolving the D1 id by name — so no resource IDs are ever stored in the repo.

For the private page, create a Cloudflare Access self-hosted application manually in the dashboard.

> **Important — scope the application to the `/private` path, not the bare host.** Access gates by URL (hostname **+ path**). Set the application Destination to `<your-host>/private` (e.g. `status.example.com/private` or `status.<subdomain>.workers.dev/private`). If you point it at the bare hostname, Access walls off the **entire** site — the public status page (`/`, `/public`, `/feed.xml`, `/badge/*`) included. With the `/private` path scope, only `/private` is gated at the edge (and the Worker then verifies the injected Access JWT); everything else stays public.

Put the team subdomain and application AUD in `config.yaml` as runtime placeholders:

```yaml
auth:
  provider: cloudflare_access
  team_name: "${CLOUDFLARE_ACCESS_TEAM_NAME}"
  aud: "${CLOUDFLARE_ACCESS_AUD}"
```

Then set `CLOUDFLARE_ACCESS_TEAM_NAME` and `CLOUDFLARE_ACCESS_AUD` as Worker secrets via CI variables, `.env` + `npm run secrets:sync`, or `wrangler secret put`.

Prerequisites that cannot be automated:

- the zone for `deploy.domain` must already exist in the Cloudflare account

Use `npm run provision -- --dry-run` to preview resource names without credentials, API calls, or file writes.

## CLI Deployment

Install dependencies:

```sh
npm ci
```

Verify Cloudflare authentication:

```sh
npm run cf:whoami
```

Run the combined production flow:

```sh
npm run deploy:prod
```

It runs: tests → migration lint → provision → D1 migrations → config import → `wrangler deploy` → secrets sync. Individual steps are available as separate scripts (`npm run provision`, `npm run d1:migrate:prod`, `npm run config:import`, `npm run deploy`, `npm run secrets:sync`).

## CI Deployment

GitHub Actions deploys on:

- push to `main`
- manual `workflow_dispatch`

GitLab CI deploys on:

- default branch pipeline
- manual web pipeline

Both CI paths run:

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

followed by a smoke test of the deployed Worker.

## Verification

List D1 migrations (the binding name `DB` resolves via `wrangler.jsonc`):

```sh
npx wrangler d1 migrations list DB --remote
```

List D1 tables:

```sh
npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```

After deploy, `/public` on the deployed URL must return HTTP 200 (this is the CI smoke test), and `/private` must redirect to the Access login page.
