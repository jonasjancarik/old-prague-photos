Ahoj Peter — TODO (Cloudflare Pages + D1 + viewer)

1) Data build
- `uv run cli export`
- `python viewer/build_geojson.py` (vygeneruje `viewer/static/data/photos.geojson`)

2) Cloudflare login + D1
- `npx wrangler login`
- `npx wrangler d1 create old-prague-photos`
- Zapiš `database_id` do `wrangler.toml` (binding `CORRECTIONS_DB`)

3) Migrace
- Lokálně (persist): `npx wrangler d1 migrations apply CORRECTIONS_DB --local --persist-to .wrangler/state`
- Produkce (remote): `npx wrangler d1 migrations apply CORRECTIONS_DB --remote`

4) Lokální dev (Pages)
- Bez Turnstile: `TURNSTILE_BYPASS=1 npx wrangler pages dev viewer/static --local`
- S remote DB (preview): `npx wrangler pages dev viewer/static --remote`

5) Produkční deploy (Pages)
- `npx wrangler pages project create <project-name>`
- `npx wrangler pages deploy viewer/static --project-name <project-name>`

6) Secrets / env vars (Pages)
- `TURNSTILE_SITE_KEY` (env var)
- `TURNSTILE_SECRET_KEY` (secret)
- Volitelně `ARCHIVE_BASE_URL` (default `https://katalog.ahmp.cz/pragapublica`)

7) Ověření
- Otevři site, klikni marker => modal + iframe
- CTA “Nahlásit špatnou polohu” => odeslání bez textu OK
- Toggle “Chci upřesnit polohu” => klik do mapy => uloží lat/lon
- Po odeslání refresh => `/api/corrections` se projeví (posunutý marker)
