# Upřesnění správce

Read when: editing curator metadata, integrating search overlays, or reviewing annotation publication.

Kurátorské upřesnění je samostatný záznam po XID. Nemění archivní text, souřadnice, členství ve skupině ani komunitní hlasy. Připomínku lze vyřídit bez zveřejnění upřesnění; formulář její text ani e-mail automaticky nepřebírá.

Správce načte fotografii přes její ID nebo z fronty připomínek, napíše veřejné vysvětlení a soukromý doklad ověření. Náhled ukazuje pouze veřejný text. Při změně ID se starý formulář skryje a zápisy zůstanou uzamčené až do úplného načtení nové fotografie i seznamu míst. Rozepsané údaje se uchovají v tomto okně po XID; po návratu k fotografii je lze tlačítkem výslovně obnovit. Zavření nebo obnovení okna tento neuložený text odstraní. Uložení rozpracovaného textu zachová dosavadní publikovanou verzi. Zveřejnění vyžaduje neprázdné vysvětlení a doklad ověření. Stažení odstraní veřejnou verzi, nikoli historii nebo archivní metadata. Soukromý doklad se nikdy neposílá veřejnému API.

## API

`GET /api/admin/photo-annotations?xid=…` vrací původní `photo`, editor `annotation` a nejvýše 100 posledních verzí `history`. Přístup používá existující admin session/bearer vrstvu; odpovědi jsou `no-store`. V současné auth vrstvě není osobní účet, proto audit ukládá označení `authenticated-admin`, nikdy token.

`POST /api/admin/photo-annotations` přijímá `xid`, `expected_revision` (0 pro vytvoření) a `action` (`draft`, `publish`, `withdraw`). Draft/publish dále přijímá `public_text` (1–2000 znaků), soukromý `evidence_note` (nejvýše 2000), `place_mode`, `place_ids` a `disputed_place_ids`. Stažení nepotřebuje textová pole. Revize editoru roste při každé změně a stale změna vrátí 409; správce musí načíst aktuální verzi. SQL compare-and-swap a historie v triggeru tvoří jednu atomickou změnu.

`GET /api/photo-annotations` vrací `{metadata_revision, items}`. Každý item obsahuje pouze `xid`, publikační `revision`, `public_text`, `place_mode`, `place_ids`, `disputed_place_ids`, `places`, `published_at`. Stav draft, soukromé doklady, identita správce a připomínky nejsou veřejné. Volitelný `?revision=n` při shodě vrátí jen `{metadata_revision, unchanged: true}` bez agregace položek. Globální metadata revision a veřejné položky se čtou jedním SQL statementem a odpověď je `no-store`; při nedostupnosti se vrací 503, ne falešně prázdný snapshot.

`keep` ponechává vztahy kromě explicitně zpochybněných ID; `replace` vyžaduje neprázdný ověřený seznam a nahrazuje aktivní vztahy; `unknown` nemá aktivní místa. Prázdné `place_ids` nesmí vyjadřovat implicitní náhradu. Archivní termíny se nepřepisují. Publikace/stažení mění pouze metadata revision, nikoli community revision. Nový draft nemění publikovaná data ani jejich revizi.

## Katalog, detail a vyhledávání

Migrace 0017 vytváří `catalog_place_members` s klíčem `(place_id, xid)`. Jednorázově jej naplní z publikovaného katalogu a triggery jej aktualizují při importu změněného `feature_json`. Zápis správce provede indexovaný lookup pouze vybraných ID; neznámé místo vrátí 400. FastAPI používá mapu míst uloženou v paměti podle verze lokálního GeoJSON. Výběr správce ukazuje názvy, čtvrti a typy míst. Veřejné `places` obsahují ověřené entity se `source: curator` a původními archivními source terms; tyto údaje nejsou odvozené ze souřadnic.

Při načtení stránky se získá jeden veřejný snapshot ještě před sestavením indexu. Změna aplikuje vztahy do `properties.places` a přegeneruje index, počty, filtr i detail v jednom synchronním kroku. Původní popis a archivní hesla zůstávají zachovaná a obecný textový filtr zahrnuje také veřejné upřesnění. Popisové návrhy vyžadují všechny tokeny dotazu uvnitř jediného pole (archivní popis nebo veřejné upřesnění), nikoli rozdělené mezi obě pole; index vrací skutečný zdroj shody, ze kterého UI vytváří snippet a jeho označení. Detail odlišuje „Popis z archivu“ a „Upřesnění správce“. Změna skupiny nepřenáší anotaci na jiný XID.

Otevřená stránka obnovuje snapshot při návratu do okna, zprávě z admin formuláře přes BroadcastChannel a každých 30 sekund, pokud je viditelná. Jde o maximálně 30sekundové zpoždění pro změnu z jiného prohlížeče; v jedné vykreslené revizi však detail, vztahy i index vždy používají stejný snapshot. Při selhání se aktivní místa vyřadí a detail sdělí nedostupnost aktuálních upřesnění. Původní text zůstává dostupný. Obnova API obnoví správné vztahy.

## Lokální ověření

- `node --test functions/api/__tests__/photo-annotations.test.mjs`: skutečný SQLite adaptér pro Pages handler, auth, původ, validace, revize, historie a veřejné soukromí.
- `uv run pytest -q tests/test_annotations.py`: FastAPI parita a nezměněný community snapshot.
- D1: migrace a `scripts/d1-annotations-smoke.sql` pouze proti izolovanému lokálnímu `--persist-to` adresáři. Smoke SQL je jednorázový a nesmí běžet proti produkci.
