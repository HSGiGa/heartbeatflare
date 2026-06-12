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

It runs: tests → migration lint → provision → D1 migrations → Access app → config import → `wrangler deploy`. Individual steps are available as separate scripts (`npm run provision`, `npm run d1:migrate:prod`, `npm run deploy:access`, `npm run config:import`, `npm run deploy`).

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
