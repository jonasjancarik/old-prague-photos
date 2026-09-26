# 004: Jedno vyhledávání s přehlednými skupinami výsledků

Read when: replacing the metadata/address toggle with grouped search.

## Kontext

Priority P2; effort L; risk MED; závisí na 003; implementace výslovně zadána 26. 9. 2026. Plánováno na `dbf028ae68d37c63bc48482a36f50eacc86c1e14`, 24. 9. 2026. Po 003 porovnat odpovídající datový kontrakt a drift v `viewer/static/app.js`, index šabloně, styles, config, CSP a testech.

Současný `initSearch` přepíná metadata/adresu a při psaní přímo filtruje mapu. `findMetadataMatches` používá `document.includes(token)`; `fetchGeocode` volá veřejný Nominatim; výběr adresy pouze `state.map.setView([lat, lon], 16)` a vypne textový filtr. Uživatel si plete fotografii přiřazenou k místu s pouhou zmínkou v textu.

Cílem je jedno pole „Hledat místo, fotografii nebo autora…“, bez přepínače adresy, se skupinami podle významu a předvídatelnými akcemi. UI nevysvětluje interní taxonomy ani API. Sekce vyjadřují druh shody, ale stále je nutné u výsledku uvést původ přiřazení a účinek akce.

## Výsledky a jejich účinek

| Sekce v tomto pořadí | Zdroj | Co udělá výběr |
| --- | --- | --- |
| Místa | normalizovaná archivní hesla 003 | nastaví filtr místa a přiblíží mapu na odpovídající fotografie |
| Zmínky v popisu | skutečné pole popisu, nikoli sloučený searchDocument | otevře konkrétní odpovídající fotografii |
| Autoři | pole autora z 003 | nastaví filtr autora |
| Adresy na mapě | Mapy.com Suggest | přesune mapu; samo nemění filtry fotografií |

Místní položka například „Letenská — Malá Strana“, pod ní „Podle údajů archivu · … fotografií“. Počet je skutečný počet odpovídajících XID po aktivních nesearchových filtrech; případný počet seskupených výsledků uvést zvlášť jako skupiny. Nepřebírat číslo 21 z auditu jako počet fotek. Sekci bez shod skrýt; nevyrábět nesouvisející Letenské náměstí jen pro naplnění návrhu.

Textový výsledek má krátký relevantní výňatek. Pokud shoda vznikla na jiném členovi skupiny než primary, otevřít odpovídající XID. V „Zmínkách v popisu“ se nesmí objevit položka nalezená pouze podle signatury/autora. Volné hledání po Enteru může dál hledat ve všech dosavadních podporovaných textových polích; UI pak říká „Text: …“ a nevydává celý výsledek za shodu v popisu.

## Stavové chování první verze

- Psání mění návrhy, nikoli okamžitě potvrzený filtr. Enter bez vybrané položky aplikuje volný text. První položku předem neaktivovat tak, aby obyčejný Enter překvapivě vybral místo.
- První verze má právě jeden potvrzený search filtr (místo, autor nebo text). Volba jiné entity jej nahradí. Vedle pole je odstranitelný štítek `Místo: Letenská — Malá Strana ×`, `Autor: … ×` nebo `Text: … ×`. Existující časové a jiné filtry se s ním kombinují průnikem a nezmizí při psaní. Více entity štítků současně je mimo tuto etapu.
- Během rozepsaného nového dotazu zůstává aktivní starý štítek viditelný. Escape zavře návrhy bez zrušení filtru, křížek u štítku filtr zruší. Prázdný Enter nevymaže jiné filtry skrytě.
- Výběr adresy je označen „Přesunout mapu na toto místo“. Nemění aktivní štítek; pokud kvůli němu nejsou fotky v okolí, UI ukazuje filtr a nabízí jeho zrušení. Nepřipojuje adresu jako prokázané místo snímku.
- Stav místa/autora/textu zachovat v URL s jednoznačným typem/ID a obnovovat přes Back/Forward. Zachovat `xid` permalink a existující parametry; neznámé ID v odkazu srozumitelně odmítnout. Navigace do detailu a zpět nesmí ztratit filtr.
- V každé sekci nejvýše 5 počátečních položek; „Další místa / Další fotografie / Další autoři“ rozšíří lokální sekci po dávkách. Nevytvářet neomezený DOM. Pro adresy nejvýše 5 návrhů, bez automatického stránkování provideru. Výsledky řadit stabilně uvnitř sekcí: přesná kanonická shoda, přesný alias, prefix/token, potom deterministický název/ID. Nemíchat skóre kategorií dohromady.
- Žádné defaultní široké fuzzy slučování. Accent-insensitive a alias matching z 003; případné pozdější zlepšení morfologie je samostatná změna.

## Adresní provider a přístupnost

Veřejný Nominatim v autocomplete nepoužít, ani s 1s prodlevou. Jeho [policy](https://operations.osmfoundation.org/policies/nominatim/) tento způsob výslovně zakazuje. Použít [Mapy.com Suggest](https://developer.mapy.com/rest-api-mapy-cz/tutorials/suggest/), aktuální parametry ověřit v [API](https://api.mapy.com/v1/docs/geocode/). Stávající klíč na tiles není důkaz, že je dostupná suggest kvóta. Ověřit konfiguraci bez změny placeného tarifu; není-li provider dostupný, sekce ukáže dostupnost až při relevantním hledání a místní výsledky fungují dál. Žádný fallback na zakázané Nominatim autocomplete.

Dotazy od 3 znaků, debounce přibližně 350–500 ms, zrušení předchozího fetch přes AbortController a token generace pro všechny asynchronní odpovědi. Změna na krátký/prázdný text rovněž zneplatní staré požadavky. Dotazy omezit na Prahu aktuálně podporovanými parametry a zachovat provider attribution. Krátká paměťová cache pro opakovaný dotaz pouze podle podmínek provideru; žádná nová serverová proxy ani placená infrastruktura bez potřeby. Hostname v CSP musí odpovídat zvolenému API hostu, nikoli wildcardu. Neodesílat osobní údaje z připomínek do hledání.

Combobox s pojmenovaným vstupem, `aria-expanded`, `aria-controls`, `aria-activedescendant`, listbox/options, přístupnými názvy sekcí. Šipky procházejí pouze volitelné výsledky, Enter provede právě jednu akci, Escape zavře, Tab pokračuje normálním pořadím; nezamknout focus. Sekční „Další“ umí klávesnici bez chybného vnoření button do option. Oznámit počet výsledků bez zahlcení při každém znaku; myslet na IME composition.

## Soubory, postup a ověření

In scope: `viewer/static/app.js`, nový malý `search-index.js`/`search-ui.js` podle potřeby, index template/entry, styles, `functions/api/config.js` a `viewer/app.py` pouze pokud je nutná konfigurace provideru, CSP `_headers`, Node/Python/e2e testy a `docs/web-app.md`. Žádný framework rewrite, nová vyhledávací služba, AI, úprava geodat ani hlasování.

1. Izolovat čistou logiku vyhledávání a filtrů s fixture z 003. `node --test functions/api/__tests__/search-index.test.mjs` → deterministické řazení, oddělené zdroje, žádné falešné autorství, správné XID/counts, merge/split aktualizace.
2. Implementovat lokální sekce, štítek a URL stav. Nový `e2e/search-omnibox.spec.mjs`; `npm run test:e2e -- e2e/search-omnibox.spec.mjs` → text Enter, výběr entity, zrušení, časový filtr, nulové shody, historie a deep link projdou.
3. Přidat Mapy Suggest za stejný UI kontrakt. E2E mockuje provider: pomalá stará odpověď, 429, 500, timeout, chybějící klíč. Po vyprázdnění pole se staré výsledky nevrátí. Test ověří, že `nominatim.openstreetmap.org` nedostává autocomplete requesty a místní hledání funguje offline.
4. Vizuálně ověřit 390×844, 820×1060, 1440×900: popup nepřekrývá nedostupným způsobem pole/filtry, dlouhé názvy se čtou, malé displeje nepotřebují horizontální scroll, lze ovládat klávesnicí. Měřit reakci lokálního indexu na celém katalogu a velikost přidaných dat; nezařadit těžkou knihovnu bez měření.
5. `npm run release:verify`, cílené e2e a `git diff --check` → exit 0. Uvést zdokumentovanou konfiguraci/kvótu nebo explicitně neověřenou live provider dostupnost. Neposílat produkční zápisy ani nenasazovat.

## Akceptační příklad

Pro `Letenská` nabídnout kanonické místo z archivních hesel; jeho výběr najde i fotografie s popisem obsahujícím skloňované tvary, protože filtruje místní heslo. Fotka sokolského sletu s věží může být pod „Zmínky v popisu“, ale nebude v místním filtru pouze kvůli textové zmínce. Neexistující autor nesmí vzniknout z hesla Osoba. Výběr dnešní adresy jasně posune mapu, nemění význam archivních údajů. Uživatel vždy pozná aktivní filtr.

Pokud chybí 003, nerozšiřovat textový substring do tvrzení o místě. Pokud provider vyžaduje změnu účtu či placený závazek, dokončit lokální sekce a nahlásit závislost. Aktualizovat stav 004; nevydávat neotestované provider chování za funkční.

## Ověření kandidáta 26. 9. 2026

Kandidát obsahuje 003 z lokálního main (`873a8d58`) a má nový omnibox se samostatným návrhem dotazu a potvrzeným filtrem. `search=place|author` s `search_id`, nebo `search=text` s `search_text`, zachovává `xid` i ostatní URL parametry. Používá jediný index 003 a jeho `searchDescriptions`; žádný konkurenční datový model ani nová D1 tabulka nevznikla.

`npm run release:verify` prošel: 205 Python testů (a 8 subtestů), 116 Node/API testů, migrace a projekční smoke test skutečné izolované lokální D1, Vite build. Cílené e2e zahrnuje katalog 003, reálná místa a autory, URL/deep link/history, časový průnik a nulové shody, 429/500/missing-key/timeout, zneplatnění opožděné odpovědi, IME/klávesnici a stránkování. Sekundární XID s odlišným popisem je výslovná fixture nad reálnými entity records, protože publikovaní členové skupin aktuálně sdílejí popis; nenahrazuje test reálného katalogu.

Responzivní rozložení s dlouhými skutečnými výsledky ověřeno v integrovaném prohlížeči i e2e (390×844, 820×1060, 1440×900), bez horizontálního scrollu. Čísla indexu a velikosti jsou v `docs/web-app.md`. OpenAPI Mapy Suggest ověřeno včetně query array `type` a `locality=BOX(...)`; CSP obsahuje konkrétní host. Live hostname/key oprávnění a zbývající kvóta zatím nejsou ověřené, placený tarif nebyl aktivován. Místní hledání při nedostupných adresách dál funguje. Main, push ani nasazení tento kandidát nemění; čeká na merge slot koordinátora.
