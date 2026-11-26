# Supabase keep-alive

The GitHub Actions workflow is scheduled daily at 12:23 UTC and supports manual runs through **Actions → Supabase keep-alive → Run workflow**. It posts to the production Vercel endpoint, which opens a TLS-verified PostgreSQL connection using a dedicated login and runs only `SELECT 1 AS ok`. The workflow reports success only when that query returns the expected row. It does not access student tables or write student activity.

## Current diagnosis (2026-11-25)

- Production is `https://satzivo.vercel.app`.
- The reported production response is HTTP 503 `database_unavailable`; GitHub-to-Vercel bearer authentication succeeds. The user also verified that the same least-privilege pooler role and connection work from PowerShell `psql`, including `SELECT current_user, 1 AS ok`.
- The Vercel handler used Node's default CA set with `rejectUnauthorized: true`, while the successful local `psql` connection uses Supabase's database root CA. That difference is the leading cause of the Node-only failure. The new handler supplies the project CA and keeps certificate-chain and hostname verification enabled. The public certificate in `supabase/supabase-root-2021.crt` is the `Supabase Root 2021 CA` certificate (self-signed CA, expires 2031-04-26), copied from the CA already used by the successful local connection. This is a strong diagnosis, but production remains unverified until a real workflow run succeeds.
- The endpoint connects directly to PostgreSQL via `pg`; it does not call Supabase REST or Edge Functions. It keeps `SELECT 1 AS ok` and does not read or write user tables. New safe failure categories are `tls`, `authentication`, `network`, `permission`, `sql`, and `unknown`; logs include only a phase and an allow-listed error code, never the exception message or connection URL.
- The repository has no Vercel Cron declaration. GitHub Actions is the configured scheduler and sends `Authorization: Bearer <KEEPALIVE_TOKEN>`. Vercel's `CRON_SECRET` convention is not involved. New API keys such as `sb_*` are not used as PostgreSQL or endpoint bearer credentials.
- Project state/log inspection through the connected Supabase integration was denied, and this session has no `gh` CLI or GitHub Actions dispatch capability. I could not inspect Production environment values or trigger/verify a live GitHub run from this session.

The workflow validates the canonical production URL and prints the fixed safe category returned by Vercel for database failures. Unit and security tests cover bearer header construction, scheduler identification, CA injection, strict TLS, safe categorization, and credential redaction. Local tests do not substitute for a successful run against PostgreSQL.

## Dedicated database role

Review `supabase/keepalive-role.sql` using a PostgreSQL administrator, create the `satzora_keepalive` login if it has not already been created, and set a strong password interactively with `psql`'s `\password satzora_keepalive`. Do not put the password into SQL files, commits, screenshots, or messages. The role has only database `CONNECT`, read-only transaction defaults, and a five-second statement timeout; `SELECT 1` needs no table or student-data grants. The SQL is setup guidance, not an application migration, and is not idempotent. Do not execute `CREATE ROLE` again if the role already exists.

Use the Supabase Session pooler connection string for this dedicated role. Encode special password characters as required by a URL. Do not append `ssl*` query parameters: the endpoint supplies the Supabase CA and configures TLS certificate and hostname verification itself. Do not use a Supabase `service_role` key or an `sb_*` API key.

The versioned CA file must match the root certificate shown in the Supabase Dashboard under **Database Settings → SSL Configuration**. Supabase documents downloading the database root certificate and using it for verified database connections in [Connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres) and [Postgres SSL Enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement). Replace the committed CA before its expiry or if Supabase rotates the project's database CA; then redeploy.

## Required configuration

In **Vercel → Project Settings → Environment Variables**, set these for **Production**, then redeploy:

- `KEEPALIVE_DATABASE_URL`: PostgreSQL URL for `satzora_keepalive` (server-side only).
- `KEEPALIVE_TOKEN`: a separate random token, at least 32 characters.

In **GitHub → Settings → Secrets and variables → Actions → New repository secret**, set:

- `KEEPALIVE_URL`: exactly `https://satzivo.vercel.app/api/keepalive`.
- `KEEPALIVE_TOKEN`: the same random token as the Vercel variable.

Do not add either value to a `VITE_` variable, Git, or browser code. The token belongs in GitHub **Secrets**, not Variables. After configuration and Vercel redeployment, run the workflow manually. A successful run must end with `PostgreSQL read-only check succeeded.`; this message is emitted only for the expected result from the real database query.

## Failure checks and paused projects

The workflow deliberately fails on incorrect configuration, redirects, authentication errors, endpoint failures, timeouts, invalid responses, and unsuccessful PostgreSQL checks. A failed workflow alone does not prove that Supabase is paused. Check the project status in the [Supabase Dashboard](https://supabase.com/dashboard); if it is paused, use **Resume project**, wait for it to become available, and rerun the workflow.

Keep-alive is **not yet verified as fixed in production**. After deploying, run **Actions → Supabase keep-alive → Run workflow**. Confirm the endpoint returns `{"ok":true,"check":"postgres"}` and Actions prints `PostgreSQL read-only check succeeded.` The workflow can only establish success from that real PostgreSQL query. Keep-alive does not guarantee that a free Supabase project will avoid an inactivity pause; GitHub scheduled runs may be delayed and Supabase controls its pause policy.
