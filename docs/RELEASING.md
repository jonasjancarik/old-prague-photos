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
CLOUDFLARE_ACCOUNT_ID=... \
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
Travel bookmark, migrates and seeds the preview database, deploys a Pages
preview, then checks secure configuration, compact community state, browser
candidate assets, Access enforcement, the signed
HttpOnly curator session, and current operational diagnostics.

After the automated check, use a fresh browser session to submit one location
correction, duplicate decision with undo, and group-split vote. Use a second
anonymous session for the confirming split vote, then complete the move in the
curator workbench. Confirm the audit/history and operational-health screens.

## First production release (davnapraha.cz)

This records the initial setup. The guarded deploy applies any pending D1
migrations, seeds the versioned photo catalog, then deploys Pages. The first
release had no contributions; provision staging before the first release that
follows real contributions.

This login can see several Cloudflare accounts, so export the account that holds
the `old-prague-photos` database before running any command:

```bash
export CLOUDFLARE_ACCOUNT_ID=...
```

1. **Zone.** Confirm `davnapraha.cz` is in that same account (dashboard →
   Websites). Pages attaches custom domains automatically only within one
   account.
2. **Pages project.**
   `npx wrangler pages project create old-prague-photos-viewer --production-branch main`
3. **Keys.**
   - Turnstile widget for `davnapraha.cz` → site key and secret key. `www`
     redirects to the apex before the application runs.
   - Mapy.cz API key restricted to `davnapraha.cz`. The existing project key
     also allows `www.davnapraha.cz`, `localhost:*`, and `127.0.0.1:*` for
     redirects and local development. Use a separate key for staging.
   - Three random secrets, for example `openssl rand -base64 48`, for
     `ADMIN_API_TOKEN`, `TURNSTILE_SESSION_SECRET` and `API_RATE_LIMIT_SECRET`.
4. **Project secrets.** Each command prompts for the value, which keeps it out
   of shell history. Without `--env` they apply to production only.

   ```bash
   for name in TURNSTILE_SITE_KEY TURNSTILE_SECRET_KEY TURNSTILE_SESSION_SECRET \
     TURNSTILE_ALLOWED_HOSTNAMES MAPY_CZ_API_KEY ADMIN_API_TOKEN \
     API_RATE_LIMIT_SECRET; do
     npx wrangler pages secret put "$name" --project-name old-prague-photos-viewer
   done
   ```

   `TURNSTILE_ALLOWED_HOSTNAMES` is `davnapraha.cz`.
   The local `.env` may still use the development-only `r2.dev` address;
   do not copy that value to production. Never set `TURNSTILE_BYPASS` remotely.
5. **Domains and tiles.** In the R2 bucket that holds the `tiles/` objects,
   connect `tiles.davnapraha.cz` under **Settings → Custom Domains**. The R2
   bucket and `davnapraha.cz` zone must be in the same Cloudflare account.
   Wait until the custom domain is active, then request a known
   `/tiles/<xid>/scan_0/ImageProperties.xml` object on the new hostname and
   confirm it returns the expected XML. Then run
   `npx wrangler pages secret put R2_TILES_BASE --project-name old-prague-photos-viewer`
   and enter `https://tiles.davnapraha.cz/tiles` at the prompt. Do not point
   a CNAME at the `r2.dev` URL. Remove the existing apex `A`/`AAAA` records for `davnapraha.cz`
   (the domain currently times out), then add `davnapraha.cz` under the Pages project's
   Custom domains. Redirect `www.davnapraha.cz` to the apex with a Redirect
   Rule.
6. **Access.** In Zero Trust, add a self-hosted application covering
   `davnapraha.cz/admin*` and `davnapraha.cz/api/admin/*`. Add an Allow policy
   for your e-mail and a Service Auth policy for a new service token; keep its
   client ID and secret as `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.
7. **Release credentials.** The deploy script can verify the Pages production
   branch using the authenticated `cf` CLI. Alternatively, set an account API
   token with *Cloudflare Pages: Edit* and *D1: Edit*. When
   `CLOUDFLARE_API_TOKEN` is set, Wrangler uses it instead of the OAuth login,
   so it needs both permissions, not only Pages read.
8. **Release.** Verify the cache baseline (see above), then run the production
   release below with `PAGES_PRODUCTION_URL=https://davnapraha.cz`.
9. **Check by hand.** In a private window, confirm one location in the
   "Chcete pomoct?" flow, then find it in `/admin`.

## Production release

Choose a retained directory on encrypted storage for D1 exports. Exports contain
private contribution and anti-abuse data; permissions are created owner-only.

```bash
D1_BACKUP_DIR=/secure/retained/old-prague-photos \
PAGES_PRODUCTION_URL=https://example.com \
PAGES_PRODUCTION_BRANCH=main \
CLOUDFLARE_ACCOUNT_ID=... \
ADMIN_API_TOKEN=... \
CF_ACCESS_CLIENT_ID=... \
CF_ACCESS_CLIENT_SECRET=... \
CONFIRM_PRODUCTION_DEPLOY=old-prague-photos \
npm run deploy:pages
```

The release refuses to run from a branch other than
`PAGES_PRODUCTION_BRANCH` (default `main`) and passes that branch explicitly to
Pages. Before migrations, it also queries the current Pages project setting
with `CLOUDFLARE_ACCOUNT_ID` and either the `cf` login or
`CLOUDFLARE_API_TOKEN`, then fails closed if
the configured production branch differs. This prevents a migrated production
database from being paired accidentally with a
preview upload. After migrations, the release imports the versioned photo
catalog in checked chunks before uploading Functions. The checkpoint is
written before migrations and contains
`database.sql`,
`time-travel.json`, the deployed Git commit, and its UTC creation time. Retain
it according to the project's backup policy and periodically test an import
against a disposable database.

### Workers Free check

The Pages Functions run on the account's Workers Free plan. Its 10 ms CPU limit
was reached when Functions parsed the complete photo catalog and assembled all
candidate pairs. The current release keeps the catalog indexed in D1 and
builds candidate queues in the browser. Before replacing a maintenance page
or calling a release healthy, verify the live `/api/review-state`, photo lookup,
contribution, and curator routes from cold requests. Check the Cloudflare
invocation outcome and CPU time, including immediately after a write; a local
test or a warm cache hit does not prove the Free-plan limit is met.
The first catalog seed contains 12,518 photos. Check account-wide D1 rows
written before a new seed, because the Free daily allowance also covers other
databases in the account. The seed helper skips photo writes when the catalog
digest matches, updating only the version marker if the surrounding static
assets changed. A changed catalog digest requires checked photo imports and
refuses unexpected row counts or membership changes.

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
