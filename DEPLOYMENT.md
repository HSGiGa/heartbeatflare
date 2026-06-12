# Cloudflare Deployment

This project supports three production deployment paths:

- local CLI
- GitHub Actions
- GitLab CI

All deployable resources (D1 database, notification queue, Cloudflare Access application) are provisioned automatically from `config.yaml`. You provide only API credentials and the deployment inputs below — `wrangler.jsonc` is auto-populated with the IDs of the created resources by `npm run provision`.

## Required Cloudflare Variables

Create a Cloudflare API token with these permissions, then provide it together with your account ID:

- Workers Scripts: Edit
- D1: Edit
- Queues: Edit
- Access: Apps and Policies: Edit
- Access: Organizations, Identity Providers, and Groups: Read

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

The variables above are deploy-time only and never reach the Worker. Values the Worker needs at request time — the optional `CLOUDFLARE_GRAPHQL_API_TOKEN` for the usage block, and one variable per `${VAR}` placeholder used in `config.yaml` notification channels (e.g. `MATTERMOST_WEBHOOK_URL`) — are read from `.env` in local dev and tests. For production, both paths work and can be mixed:

**Automatic (recommended):** add each secret to GitHub repository secrets / GitLab CI variables under the same name. The `secrets:sync` step (`scripts/sync-secrets.ts`) runs after every deploy: it discovers required names from `${VAR}` references in `config.yaml` and pushes them all to Cloudflare Worker secrets in one bulk call. A referenced name absent from CI is skipped (value kept) when the secret already exists on the Worker — so manually uploaded secrets don't have to be duplicated into CI. When a referenced secret exists in neither place, the step prints a warning and the deploy proceeds; the affected notification channel stays broken until the secret is added. On GitHub the workflow passes all repository secrets to the step via `SECRETS_CONTEXT: ${{ toJSON(secrets) }}` (repository secrets are not individually enumerable from a step); on GitLab CI variables are plain env vars and need no extra wiring. `npm run deploy:prod` runs the same sync using your local `.env`. Optional secrets (`CLOUDFLARE_GRAPHQL_API_TOKEN`) produce a warning instead of a failure when absent.

**Manual:** upload each secret once by hand; it persists across deployments and the sync step simply overwrites it with the same value on the next CI run:

```sh
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
  domain: status.modem.by # custom domain route; omit to serve on workers.dev only
  # database_name: ... # default: ${name}-prod-db
  # queue_name: ...    # default: ${name}-notifications
```

`npm run provision` then:

1. Creates the D1 database and the notification queue if they do not exist (find-by-name, idempotent).
2. Patches `wrangler.jsonc` in place: worker name, custom domain route, `vars.CLOUDFLARE_ACCOUNT_ID`, `vars.D1_DATABASE_ID`, D1 binding name/ID, queue names. Re-running with unchanged resources produces a zero git diff; committing the patched file is optional but recommended.

`npm run deploy:access` creates/updates the Cloudflare Access application from the `access:` section (the protected path defaults to `<deploy.domain>/private`), auto-discovers the Zero Trust team domain, and writes `auth.team_domain` and `auth.aud` back into `config.yaml`. In CI this write-back stays in the job workspace — the committed values are informational.

Prerequisites that cannot be automated:

- the zone for `deploy.domain` must already exist in the Cloudflare account
- the OIDC identity provider named in `access.identity_provider` must already exist in Zero Trust

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

It runs: tests → migration lint → provision → D1 migrations → Access app → config import → `wrangler deploy` → secrets sync. Individual steps are available as separate scripts (`npm run provision`, `npm run d1:migrate:prod`, `npm run deploy:access`, `npm run config:import`, `npm run deploy`, `npm run secrets:sync`).

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
npm run deploy:access
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
