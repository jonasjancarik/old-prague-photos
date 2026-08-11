# Releasing the community web app

Read when: provisioning staging, changing Pages/D1 bindings or secrets,
deploying the community app, or recovering D1.

The Pages+D1 deployment is the canonical community system. Preview deployments
must use `old-prague-photos-staging`; the production contribution database must
never be attached to a preview URL.

## One-time staging setup

1. Authenticate Wrangler and create `old-prague-photos-staging` in Western
   Europe. Replace the all-zero `env.preview` UUID in `wrangler.toml` with the
   returned UUID. Confirm it differs from the production UUID.
2. Give staging a stable hostname. Use separate staging Turnstile keys, restrict
   the widget to that hostname, and set `TURNSTILE_ALLOWED_HOSTNAMES` to the same
   host. Do not set `TURNSTILE_BYPASS` remotely.
3. Use a separate Mapy.cz browser key restricted to the staging hostname. The
   key is delivered to the browser and must be protected by provider-side
   hostname restrictions, not treated as a server secret.
4. Set a unique high-entropy `ADMIN_API_TOKEN`, `TURNSTILE_SESSION_SECRET`, and
   `API_RATE_LIMIT_SECRET` for staging. Do not reuse production values.
5. Put the whole staging hostname behind Cloudflare Access. In production,
   protect `/admin*` and `/api/admin/*`. Access is an additional edge check;
   `ADMIN_API_TOKEN` remains required by the application.
6. Create a Cloudflare Access service token allowed by those policies. Store its
   client ID and secret in the release environment as
   `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.

Recommended Pages variables for both environments, with different values where
appropriate:

- `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_SESSION_SECRET`
- `TURNSTILE_ALLOWED_HOSTNAMES`
- `MAPY_CZ_API_KEY`
- `ADMIN_API_TOKEN`, `API_RATE_LIMIT_SECRET`
- optional `ADMIN_SESSION_TTL_SECONDS` (defaults to eight hours)
- optional rate limits, archive/R2 URLs, and fallback switches documented in
  `docs/web-app.md`

Turnstile secret rotation accepts the old and new secret for a short overlap.
Rotate staging first, exercise all contribution flows, then rotate production.

## The ignored cache baseline must verify before deployment

Before either staging or production release, verify that the expensive ignored
caches still match the preserved baseline:

```bash
uv run python scripts/release_baseline_inventory.py verify \
  data-snapshots/release-baseline-2026-08-11.json
```

This is a local read-only check and is separate from the private D1 checkpoint.
The manifest contains file paths, byte counts, and SHA-256 digests, but no cache
payloads, `.wrangler/` contents, D1 rows, secrets, or local contribution logs.
An empty top-level `absent_paths` means every selected baseline input was
present when the manifest was written.

If verification fails, stop the release. Preserve the current bytes before
investigating; do not rerun collection, downloads, stitching, or model review to
make the mismatch disappear. A deliberately accepted cache change requires a
new dated manifest reviewed alongside the reason for the change.

When a release includes a newly derived data snapshot, validate it separately
before publication:

```bash
uv run cli run validate runs/<run-id>
uv run cli run publish runs/<run-id>
```

`validate` is read-only, and `publish` enforces the same checks. Publication
merges raw records, geolocation, Gemini batch files, and viewer features by
stable identity, preserving existing entries omitted from the run. Matching
record objects retain published fields that the run omits; matching Gemini
request/result filenames must be byte-identical or publication stops. See the
[Pipeline Contract](./pipeline-contract.md) for the append-only failure ledger,
raw-metadata export overlay, and interruption-safe Gemini submission rules.

## Staging release

Run from a clean, reviewed commit:

```bash
PAGES_STAGING_URL=https://staging.example.com \
D1_BACKUP_DIR=/secure/retained/old-prague-photos \
ADMIN_API_TOKEN=... \
CF_ACCESS_CLIENT_ID=... \
CF_ACCESS_CLIENT_SECRET=... \
CONFIRM_STAGING_DEPLOY=old-prague-photos-staging \
npm run deploy:pages:staging
```

The command requires an explicit staging confirmation, a clean worktree, a
retained checkpoint directory, the protected staging URL, and every credential
needed by the smoke check before it does remote work. It refuses production-like
branch names and an absent, all-zero, or production-equal staging D1 UUID. It
verifies the full local test/build gate, captures a private SQL export and Time
Travel bookmark, migrates the preview database, deploys a Pages preview, then
checks secure configuration, candidate delivery, Access enforcement, the signed
HttpOnly curator session, and current operational diagnostics.

After the automated check, use a fresh browser session to submit one location
correction, duplicate decision with undo, and group-split vote. Use a second
anonymous session for the confirming split vote, then complete the move in the
curator workbench. Confirm the audit/history and operational-health screens.

## Production release

Choose a retained directory on encrypted storage for D1 exports. Exports contain
private contribution and anti-abuse data; permissions are created owner-only.

```bash
D1_BACKUP_DIR=/secure/retained/old-prague-photos \
PAGES_PRODUCTION_URL=https://example.com \
PAGES_PRODUCTION_BRANCH=main \
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_API_TOKEN=... \
ADMIN_API_TOKEN=... \
CF_ACCESS_CLIENT_ID=... \
CF_ACCESS_CLIENT_SECRET=... \
CONFIRM_PRODUCTION_DEPLOY=old-prague-photos \
npm run deploy:pages
```

The release refuses to run from a branch other than
`PAGES_PRODUCTION_BRANCH` (default `main`) and passes that branch explicitly to
Pages. Before migrations, it also queries the current Pages project setting
with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, then fails closed if
the configured production branch differs. This prevents a migrated production
database from being paired accidentally with a
preview upload. The checkpoint is written before migrations and contains
`database.sql`,
`time-travel.json`, the deployed Git commit, and its UTC creation time. Retain
it according to the project's backup policy and periodically test an import
against a disposable database.

## Recovery

Prefer a forward fix when the application remains usable. If D1 must be restored:

1. Stop further writes, record the incident window, and save a fresh export of
   the damaged state for investigation.
2. Read the pre-release `time-travel.json` and verify the target database and
   timestamp. Cloudflare Time Travel restore replaces current database state.
3. Run the guarded command with exactly one bookmark or timestamp:

```bash
D1_RESTORE_BOOKMARK=... \
CONFIRM_D1_RESTORE=restore-old-prague-photos-production \
scripts/restore-d1-time-travel.sh production
```

For staging, use the `preview` argument and confirmation value
`restore-old-prague-photos-preview`. After restore, rerun the smoke check and
inspect projections, queues, and curator history before reopening writes.

Never test the restore procedure against the production database. Use a
disposable D1 database or staging copy.
