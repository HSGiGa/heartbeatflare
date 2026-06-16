# Troubleshooting

Common failures when first deploying heartbeatflare, by symptom. Most break on Cloudflare
permissions, secrets, or the Access path scope.

## Deploy fails with a Cloudflare permission error

The `provision`, `deploy` or migration step returns 403 / "Authentication error" / "not authorized".

- Your `CLOUDFLARE_API_TOKEN` is missing a scope. It needs **Workers Scripts: Edit**, **D1: Edit**
  and **Queues: Edit**. For a custom domain route add **Workers Routes: Edit** and **Zone: Read**.
  See [token permissions](DEPLOYMENT.md#cloudflare-api-token-permissions).
- `CLOUDFLARE_ACCOUNT_ID` is wrong or unset. Confirm with `npm run cf:whoami`.
- In CI, double-check the secret **names** match exactly (`CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`).

## D1 database or queue can't be created / "already exists"

`provision` is find-by-name and idempotent, so it should be a no-op when resources exist. If it
errors:

- A resource with the derived name exists but in a different account/region, or was created by hand
  with mismatched settings. Either delete it, or set `deploy.database_name` / `deploy.queue_name` to
  the exact existing name.
- Preview the names the tooling expects without making API calls:
  `npm run provision -- --dry-run`.

## Custom domain route fails

`wrangler deploy` errors on the route, or the domain serves nothing.

- The **zone for `deploy.domain` must already exist** in the Cloudflare account — provisioning does
  not create zones.
- The token needs **Workers Routes: Edit** and **Zone: Read**.
- To rule the route out, remove `deploy.domain` and redeploy; the Worker is then served on
  `<name>.<subdomain>.workers.dev`.

## `/public` returns an error

- If the deploy's smoke test failed, the Worker may not have deployed — check the deploy log for the
  earlier failing step.
- A 5xx usually means `config:import` didn't run or D1 migrations weren't applied. Re-run
  `npm run deploy:prod` (or the individual `d1:migrate:prod` + `config:import` steps) and check
  [migrations](DEPLOYMENT.md#verification).

## `/private` is public, or Access walls off the whole site

This is almost always the Access **path scope**.

- **Whole site asks for login** (public page included): your Access application is scoped to the bare
  hostname. Re-scope its Destination to `<your-host>/private`.
- **`/private` is reachable without login:** Access isn't applied to that path, or the `auth` block
  /secrets are missing. See [Cloudflare Access for `/private`](DEPLOYMENT.md#cloudflare-access-for-private).

## Access JWT verification fails (`/private` returns 503)

- `CLOUDFLARE_ACCESS_TEAM_NAME` or `CLOUDFLARE_ACCESS_AUD` is missing or wrong as a **runtime** Worker
  secret. Verify with `npm run secrets:sync -- --dry-run` and re-sync.
- The `aud` must match the **Application Audience (AUD) tag** of the exact Access application gating
  `/private`.

## A notification never arrives / secret is missing

- The `${VAR}` in `config.yaml` has no matching Worker secret. `secrets:sync` prints a **warning**
  (not a failure) for any referenced `${VAR}` absent from both CI and the Worker — search the deploy
  log for `WARNING`. Add the secret as a CI variable or via `wrangler secret put`, then redeploy.
- Confirm the channel is reachable independently (post to the webhook URL with `curl`).
- See [Secrets and `${VAR}` placeholders](CONFIGURATION.md#secrets-and-var-placeholders).

## Heartbeat token was lost

Token values are shown **once** at creation and never again.

- Don't have it saved? Rotate: delete the `HEARTBEAT_<ID>_TOKEN` secret in the dashboard
  (**Workers & Pages → your worker → Settings → Variables and Secrets**) and redeploy — `secrets:sync`
  generates and prints a fresh one.
- Or pre-set your own value with `npx wrangler secret put HEARTBEAT_<ID>_TOKEN` and use that.

## Heartbeat endpoint returns 404

`POST /beat/<monitor-id>/<token>` returns 404 deliberately for an unknown monitor, a wrong/missing
token, **or a disabled monitor** — it never reveals which. Check:

- the monitor id slug (lowercase, hyphenated name) in the URL path;
- the token matches the `HEARTBEAT_<ID>_TOKEN` secret;
- the monitor is `enabled` and was imported (it must exist in `config.yaml` and be deployed).

A `405` means you used a method other than `POST`; a `429` means you're rate-limited.

## Smoke test "Could not parse Worker URL from deploy output"

The deploy step greps `wrangler deploy` output for the `*.workers.dev` URL. If `wrangler` printed no
such URL — e.g. a custom-domain-only deploy with no workers.dev route — the parse fails. Ensure the
Worker keeps its `workers.dev` route enabled, or adjust the smoke-test URL extraction in
`.github/workflows/deploy-cloudflare.yml`.

## A monitor stays "Unknown"

- It hasn't been probed yet. The scheduler runs once a minute and probes due monitors oldest-first;
  give it a cron tick.
- The monitor may be `enabled: false` (or was removed from `config.yaml`, which soft-disables it).
- For heartbeat monitors, "Unknown" persists until the first beat arrives.

## Generated `wrangler.jsonc` looks wrong

`wrangler.jsonc` is generated (and gitignored) from `wrangler.template.jsonc` + `config.yaml` on
every npm script — don't edit it by hand. If it looks stale, regenerate with `npm run wrangler:generate`
(or just run `npm run dev` / `npm test`). If bindings are missing, check `provision` actually created
the D1/queue and that `deploy.name` matches.
