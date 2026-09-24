# 003: Připravit místa a autory pro sjednocené hledání

Read when: exporting or normalizing searchable archive metadata.

## Kontext a scope

Priority P2; effort L; risk MED/HIGH kvůli identitám a datovým exportům. Žádná funkční závislost na 001/002, ale tento plán nyní není zadán k implementaci. Plánováno na `dbf028ae68d37c63bc48482a36f50eacc86c1e14`, 24. 9. 2026. Před zahájením porovnat drift v `src/pipeline/export.py`, `viewer/build_geojson.py`, `scripts/build_catalog_seed.py`, `viewer/static/grouping.js`, datech a souvisejících testech.

Uživatel hledající Letenskou dostane dvě textové shody, přestože zdrojová místní hesla obsahují další záznamy. Pole pro místa existují v klientském search builderu, ale nejsou v exportu:

```js
// viewer/static/app.js:237
props.location, props.place, props.street, props.city,
```

`src/pipeline/export.py:27` má pevné `MINIMAL_COLUMNS`; `viewer/build_geojson.py:182` sestavuje vybrané properties bez místních hesel. `scripts/build_catalog_seed.py` má další allowlist `FEATURE_FIELDS`. Údaj musí projít všemi relevantními cestami, jinak statická mapa a detail načtený z API ukážou jiný obsah.

Zdrojová data jsou v `output/raw_records/*.json` (verzovaná), geokódování v `output/geolocation/ok/*.json` (ignorovaná cache), publikovaná populace v `viewer/static/data/photos.geojson`. Ve worktree může geokódovací cache chybět: použít explicitní read-only zdrojovou cestu do původního checkoutu, nevytvářet novou scraping/AI úlohu. Všechny počty počítat nad publikovanými XID a respektovat media filter; 24 záznamů Letenské ve 21 statických skupinách je auditní snímek, nikoli hardcoded test globální databáze.

In scope: export a nový čistý normalizační modul pod `src/pipeline`, GeoJSON builder, katalog seed allowlist, malé klientské index helpers, související Python/Node testy, dokumentace datového kontraktu a reprodukovatelný postup tvorby kandidátních dat. Nezasahovat do scraperu, AI geolokace, souřadnic, immutable group ID, scan/media cache, komunitních hlasů a produkčního D1. Publikovaná data měnit teprve po validaci kandidátního exportu.

## Cílový model

- Zachovat původní archivní místní hesla beze změny jako `archive_place_terms` (pole řetězců).
- Odvozené `places` jsou pole objektů se stabilním `id`, `label`, `kind` (`street`, `district`, `other`), `district` pouze při doložené jednoznačnosti, `aliases`, `source: archive`, `source_terms`. Původ a jistota nesmí být ztraceny při normalizaci. ID nesmí záviset na pořadí záznamů, počtu fotek ani souřadnicích.
- Zachovat více míst na XID. Nepřiřazovat všechny čtvrti ke všem ulicím při nejednoznačné kombinaci; takové heslo má district neuvedený a přiznanou nejednoznačnost. Moderní geokodér smí poskytnout oddělenou nápovědu, ne rozhodnout archivní identitu.
- Konzervativní sjednocení Unicode, whitespace a známých obalů: `Letenská` / `Letenská ulice`, `Holešovice` / `Holešovice (Praha)`, `Praha - Josefská ulice`. Označení street potvrdit známým heslem/kurátorovanou mapou, ne předpokladem „každé přídavné jméno je ulice“. Nevytvářet globální odsekávání přípon nebo volné fuzzy merge.
- Malý verzovaný seznam ověřených aliasů může být součástí modulu nebo datového souboru, odděleně od původních hesel. Historické přejmenování není kosmetická varianta a automaticky neslučovat odlišné historické entity.
- Autoři vycházejí z `autor`/`author`; uchovat původní označení, bezpečně sjednotit whitespace/diakritické vyhledávací klíče a ověřené varianty. Nedělit vícejmenné zápisy na čárkách naslepo a nepovažovat `Osoba` za autora. První verze může mít celé původní společné autorství jako jednu položku.
- Geocoder street případně uchovat jako oddělený odhad s provenance, ale nevkládat do `places` ani podle něj nerozšiřovat archivní počty. Plošný reverse geocoding není nutný pro tuto část.

## Postup a testy

1. Napsat malý fixture dataset přesně zachycující místní varianty, dvě stejnojmenné ulice v odlišném kontextu, více míst u jedné fotky, chybějící raw record, osobu odlišnou od autora a společné autorství. Nové `tests/test_place_normalization.py`. Ověření `uv run pytest -q tests/test_place_normalization.py` → determinismus, žádné nepodložené sloučení, původní text zachován.
2. Rozšířit exportní kontrakt od raw overlay přes CSV (JSON serializovaná pole) po GeoJSON a D1 feature payload. Výpadek jednoho raw sidecaru nesmí vyřadit fotografii; její místa budou neznámá, nikoli odhadnutá. Použít vzory v `tests/test_export.py`, `tests/test_viewer_build_geojson.py`, `tests/test_catalog_seed.py`. Ověření `uv run pytest -q tests/test_export.py tests/test_viewer_build_geojson.py tests/test_catalog_seed.py tests/test_place_normalization.py` → exit 0.
3. Klientský index sestavit jednou po načtení a aktualizovat členství podle současného grouping/review-state. Počty rozlišují unikátní XID a skupiny; nezapočítávat skeny zvlášť. V rámci skupiny udržet konkrétní odpovídající XID, aby otevřený reprezentant vysvětloval shodu. Nepočítat archivní populace mimo publikované fotografie. Ověření novým `functions/api/__tests__/search-index.test.mjs` přes `node --test functions/api/__tests__/search-index.test.mjs`.
4. Kandidátní export vytvořit v dočasném adresáři, uvést zdrojové cesty a počty: XID přidána/odebrána, group IDs a geometry změněny, místa známá/neznámá/nejednoznačná, raw source gaps a velikost výsledku. Změna geometry/group ID nebo ztráta publikovaného XID je chyba a blokuje publikaci. Snapshot 24/21 jen porovnat a vysvětlit případný legitimní rozdíl.
5. D1 seed digest musí zahrnout nová feature data. Změna indexu nesmí vynutit slepé přegenerování fotek či reset komunity; ověřit seed readback a komunitní příspěvky zachované. Aktualizovat dokumentaci pipeline/web a případné explicitní versioning zdroje, jestliže vznikne samostatný index asset. Preferovat odvození indexu z přidaných feature polí bez dalšího obřího duplikovaného souboru.

## Done a release

`npm run test:api`, příslušné Python testy a `npm run build:viewer` projdou. Kandidátní export má zachované XID, geometry a immutable group IDs. Příklady Letenská/Letenské/Letenskou lze vyhledat přes kanonické místní heslo fotografie; nepředstírat obecnou českou lemmatizaci textu. Metadata nedělají z vodárenské věže snímek Letenské ulice pouze kvůli přídavnému jménu v popisu.

Nový formát, počty a velikost jsou zdokumentované; `git diff --check` projde; stav 003 aktualizován. Nepřepisovat baseline manifest, aby jen přestal hlásit rozdíl. Chybějící cache, konflikt identity nebo požadavek na nové placené/API dávky znamenají popsat blokaci, nikoli spustit sběr. Deployment pouze samostatně autorizovaným postupem podle `docs/RELEASING.md`.
