# Upřesnění správce

Read when: editing curator metadata, integrating search overlays, or reviewing annotation publication.

Kurátorské upřesnění je samostatný záznam po XID. Nemění archivní text, souřadnice, členství ve skupině ani komunitní hlasy. Připomínku lze vyřídit bez zveřejnění upřesnění; formulář její text ani e-mail automaticky nepřebírá.

Správce načte fotografii přes její ID nebo z fronty připomínek, napíše veřejné vysvětlení a soukromý doklad ověření. Náhled ukazuje pouze veřejný text. Uložení rozpracovaného textu zachová dosavadní publikovanou verzi. Zveřejnění vyžaduje neprázdné vysvětlení a doklad ověření. Stažení odstraní veřejnou verzi, nikoli historii nebo archivní metadata. Soukromý doklad se nikdy neposílá veřejnému API.

## API

`GET /api/admin/photo-annotations?xid=…` vrací původní `photo`, editor `annotation` a nejvýše 100 posledních verzí `history`. Přístup používá existující admin session/bearer vrstvu; odpovědi jsou `no-store`. V současné auth vrstvě není osobní účet, proto audit ukládá označení `authenticated-admin`, nikdy token.

`POST /api/admin/photo-annotations` přijímá `xid`, `expected_revision` (0 pro vytvoření) a `action` (`draft`, `publish`, `withdraw`). Draft/publish dále přijímá `public_text` (1–2000 znaků), soukromý `evidence_note` (nejvýše 2000), `place_mode`, `place_ids` a `disputed_place_ids`. Stažení nepotřebuje textová pole. Revize editoru roste při každé změně a stale změna vrátí 409; správce musí načíst aktuální verzi. SQL compare-and-swap a historie v triggeru tvoří jednu atomickou změnu.

`GET /api/photo-annotations` vrací `{metadata_revision, items}`. Každý item obsahuje pouze `xid`, publikační `revision`, `public_text`, `place_mode`, `place_ids`, `disputed_place_ids`, `published_at`. Stav draft, soukromé doklady, identita správce a připomínky nejsou veřejné. Globální metadata revision a veřejné položky se čtou jedním SQL statementem a odpověď je `no-store`; při nedostupnosti se vrací 503, ne falešně prázdný snapshot.

`keep` ponechává vztahy kromě explicitně zpochybněných ID; `replace` vyžaduje neprázdný ověřený seznam a nahrazuje aktivní vztahy; `unknown` nemá aktivní místa. Prázdné `place_ids` nesmí vyjadřovat implicitní náhradu. Archivní termíny se nepřepisují. Publikace/stažení mění pouze metadata revision, nikoli community revision. Nový draft nemění publikovaná data ani jejich revizi.

## Stav implementace a další integrace

Samostatná SQL/API/FastAPI/admin část je připravena před integrací 003/004. Neprázdná place IDs prozatím selžou s 503, dokud nebude připojen ověřený katalogový lookup. Veřejný detail a vyhledávací index zatím overlay nepoužívají. Tato část tedy ještě není hotová pro vydání.

Po sloučení 003/004 doplnit katalogový lookup míst bez procházení celého katalogu v každém požadavku; aplikovat jeden snapshot podle XID současně na detail a search index/počty; při chybě zobrazit nedostupnost aktuálních upřesnění a nepovažovat staré vztahy za ověřené. Zachovat původní text v textovém hledání. Admin výběr míst doplnit o čitelné názvy a typy z katalogu. Dokončit kombinované e2e a mobilní/desktop kontrolu veřejného UI.

## Lokální ověření

- `node --test functions/api/__tests__/photo-annotations.test.mjs`: skutečný SQLite adaptér pro Pages handler, auth, původ, validace, revize, historie a veřejné soukromí.
- `uv run pytest -q tests/test_annotations.py`: FastAPI parita a nezměněný community snapshot.
- D1: migrace a `scripts/d1-annotations-smoke.sql` pouze proti izolovanému lokálnímu `--persist-to` adresáři. Smoke SQL je jednorázový a nesmí běžet proti produkci.
