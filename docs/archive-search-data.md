# Archive places and authors

Read when: exporting archive metadata, building the catalogue, or implementing search and curator overlays.

Each GeoJSON feature and D1 `feature_json` contains `archive_place_terms` (unaltered strings from `rejstříkové záznamy` entries of type `Místo`), `places` and `authors` (arrays; unknown is `[]`). CSV serializes each array as JSON. Existing `author` remains available.

A place is `{id, label, kind, aliases, source: "archive", source_terms, ambiguous}`. `kind` is `street`, `district` or `other`. A street has optional `district` only when the archive record supplies exactly one recognized district; multiple districts yield `ambiguous: true` and omit `district`. IDs hash the NFC-normalized, whitespace-normalized, casefolded kind/label/district, independently of coordinates, order or population. Unknown place terms remain separate `other` entities. Cosmetic street wrappers and a small explicit alias table are normalized; historical renamings are not merged. Diacritics are preserved in identities and removed only for searching.

An author is `{id, label, aliases: [], source: "archive", source_terms}`. Only `autor`/`author` supply authors. Full joint authorship and dates stay in one entity; commas do not split names. `Osoba`, descriptions, archive headings and geocoder results supply neither authors nor places. Missing raw sidecars leave places/authors unknown in an export with explicit `--raw-dir`.

`viewer/static/search-index.js` exports:

- `normalizeSearchText(value)` → accent-insensitive whitespace-normalized lowercase string.
- `buildSearchIndex(features)` → `{photos, places, authors}` Maps over unique published XIDs. Entities accumulate all source variants without expanding scans.
- `updateSearchMembership(index, groupByXid = new Map(), visibleXids = null)` → `{index, membership}`. Pass the current grouping `groupByXid` (values are group objects with `.id` or ID strings); optional Set restricts visible XIDs. Reapply after grouping/review/filter changes without rebuilding metadata.
- `searchIndex(state, query, {limit = 14, field = "all"} = {})` → `{places, authors, photos}`. Entity matches include `xids`, `groupIds`, `photoCount`, `groupCount`, `matchedXid`; photograph matches include `groupId`, `matchedXid`, `xids`. Open `matchedXid` to explain the match. Ranking is exact canonical label (including district), exact alias, label prefix, remaining token matches, then Czech label order and ID; `rank` is 0–3. `field: "description"` restricts photograph matches to description.
- `searchDescriptions(state, query, {limit = 14} = {})` → the photograph result array from description-only matching. Search uses all query tokens and explicit aliases (including Letenské/Letenskou), not general Czech lemmatization.

Old assets and absent fields remain readable. No D1 schema migration or community reset is needed; seed upserts replace only catalogue source payloads and their digest. The index is derived in memory, with no second large asset.

## Validated catalogue snapshot (26 September 2026)

The published 12,534 features were enriched using tracked `output/raw_records`, without consulting geocoder caches. There are 12,262 records with archive places, 272 with unknown places, 50 with ambiguous street context, 9,532 with authors, and 16 missing raw sidecars. All XIDs, group IDs, geometry and pre-existing properties remain unchanged. The enriched GeoJSON is 17,113,061 bytes. Exact archive Letenská/Malá Strana membership remains 24 XIDs in 21 groups; 23/20 have an unambiguous normalized Malá Strana street. `F03A042A205F11E88E87406186009F3A` supplies both Hradčany and Malá Strana, so it has no inferred district.

Reproduce a candidate without editing the published asset:

```sh
uv run python -m scripts.enrich_archive_metadata --output /tmp/photos-candidate.geojson
```

The command checks that removing the three derived fields restores the complete input, and reports source paths, missing raw records, counts, bytes and unchanged identity/geometry. Review the report before copying the candidate to `viewer/static/data/photos.geojson`, then run `npm run prepare:community-data` and build the seed. The ignored release cache baseline is not rewritten. Existing media population is retained exactly. The seed defaults to 32 rows per statement after enrichment (64 exceeds the SQL byte limit); its byte guard remains enforced.
