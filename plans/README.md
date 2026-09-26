# Připomínky uživatelů a sjednocené hledání

Read when: implementing feedback, location-correction UX, place indexing, the omnibox, or curator metadata corrections.

Plán z 24. 9. 2026, založený na commitu `dbf028ae68d37c63bc48482a36f50eacc86c1e14`. Autorem zadání je Jonas; podnětem je zkušenost prvního uživatele Filipa s hledáním Letenské a opravou fotografie. Tento adresář je implementační zadání, nikoli zpráva o dokončených změnách.

## Co se má změnit

Uživatel musí mít možnost poslat připomínku bez změny polohy. Po opravě má vědět, že jeho práce skončila a čeká se na dalšího člověka. Hledání má jedním polem nabídnout místa, fotografie podle popisu, autory a dnešní adresy, přičemž u každého výsledku musí být zřejmé, co výběr udělá.

| Část | Výsledek | Priorita | Rozsah | Závislost | Stav |
| --- | --- | --- | --- | --- | --- |
| [001](001-photo-feedback.md) | Soukromá připomínka k fotografii a fronta správce | P1 | M | žádná | Hotovo ve worktree; lokální ověření |
| [002](002-correction-completion-and-map.md) | Jasné dokončení opravy, vlastní návrh, oba body na mapě | P1 | M | lze samostatně; po 001 kvůli společnému UI | Hotovo ve worktree; lokální ověření |
| [003](003-place-and-author-data.md) | Normalizovaná místa a autoři s původem údajů | P2 | L | žádná; před 004 | Připraveno k integraci; validovaná data a lokální testy |
| [004](004-grouped-search-omnibox.md) | Jedno hledání se skupinami výsledků a viditelnými filtry | P2 | L | 003 | TODO — pozdější etapa |
| [005](005-curator-metadata-corrections.md) | Ověřené doplnění popisu a opravy přiřazení správcem | P3 | L | 001, 003, 004 | TODO — pozdější etapa |

M = několik souvisejících změn včetně testů; L = práce přes více vrstev. Nejde o časový příslib. Do prvního nového úkolu patří pouze 001 a 002. Implementátor nesmí automaticky pokračovat částmi 003–005 ani nasazovat.

## Rozhodnutí o produktu

- Připomínky jsou soukromé pro správce, nejsou diskuse a nemění hodnocení polohy. Váží se na stabilní XID fotografie, ne pouze na proměnlivou skupinu.
- E-mail je nepovinný, slouží jen k případnému upřesnění a nesmí znamenat souhlas s newsletterem. Neodesílat e-maily ani jiné zprávy.
- Původní archivní text a hesla se zachovávají. Normalizovaný tvar je index pro hledání, ne přepsaný historický pramen.
- Bod na mapě, ulice z geokodéru a archivní místní heslo nejsou zaměnitelné. Odhad ulice z bodu nesmí být vydáván za ověřené přiřazení fotografie.
- Autor fotografie vychází z pole `autor` / `author`. Archivní heslo `Osoba` může označovat zobrazeného člověka a samo o sobě autorství nedokazuje.
- Jedna fotografie může patřit k více místům. Nejednoznačná hesla se nespojují automaticky jen podle podobnosti nebo polohy.
- Současný přepínač „Hledat adresu“ nahradí omnibox. Možnost přesunout mapu zůstane jako výslovně označený druh výsledku.
- Stavby, témata, obecná databáze osob, fuzzy hledání pomocí AI, plošné reverzní geokódování a veřejné editování míst jsou odložené.

## Ověřený výchozí stav

Na živém webu hledání `Letenská` vrátilo dva popsané výsledky. Statický GeoJSON obsahuje 12 534 záznamů; přesná archivní hesla `Letenská` / `Letenská ulice` spolu s `Malá Strana` mají 24 záznamů ve 21 statických skupinách. Explicitní `regional.street` v geokodéru má 11 923 publikovaných XID. Tyto počty jsou kontrolní snímek, ne konstanty produktu; komunitní slučování, vyřazená média a filtry mění viditelné počty.

U XID `E08DA55F7B0411E4A348406186009F3A` je v lokální kopii AHMP heslo `Praha-Malá Strana - ulice Letenská` a popis `Průhled ulicí Letenská na Malé Straně.` Filip určuje místo jako Valdštejnskou. Původ archivního označení je ověřen; nezávislá historická identifikace v tomto auditu provedena nebyla. Nevkládat tuto opravu automaticky jako schválený údaj.

V živém prohlížeči se oba body návrhu načetly. V úzkém okně je mapa pod vysokou fotografií a část zpočátku zůstává pod obrazovkou. Konkrétní původní závada „druhý bod až po kliknutí“ nebyla reprodukována. Pět cílených testů komunitního potvrzování prošlo. Neproběhl úplný build/test gate, protože šlo o audit bez změn zdrojového kódu.

## Společné technické podmínky

Projekt používá Python/uv, vanilla JS s Vite vstupními soubory pod `viewer/react`, Leaflet, Pages Functions a D1. Neprovádět migraci frameworku. Kanonický komunitní backend je Pages/D1; `viewer/app.py` je lokální FastAPI varianta a musí mít odpovídající chování tam, kde už tok podporuje. Vite šablony pod `viewer/react/src/templates` jsou zdroj, `viewer/static/*.html` a verzované `viewer/static/assets` vznikají buildem.

Použít npm a uv, existující styly a bezpečnostní pomocníky. Před Cloudflare změnami načíst příslušný skill; před příkazy Wrangler také jeho skill. Netisknout klíče ani obsah `.env`. Nepřenášet produkční D1 do preview a netestovat zápisy na produkci. Vlastní testovací data musí žít v dočasném adresáři nebo izolované lokální D1.

Původní checkout `/Users/janca/projects/old-prague-photos` se při implementaci v worktree nemění. Plány mohou být dosud necommitované: zkopírovat pouze tento adresář do vlastního worktree, pokud tam chybí. `output/raw_records/*.json` jsou verzované a běžně budou i ve worktree; ostatní ignorované části `output/`, soukromé `viewer/data/` a `.env` se nemají automaticky kopírovat. Velké zdrojové cache v původním checkoutu lze pro pozdější část 003 číst, nikoli přepisovat nebo znovu stahovat.

Samostatné logické commity jsou žádoucí, push, merge a deployment nejsou tímto zadáním povoleny. Pokud se HEAD liší, porovnat dotčené soubory s plánovaným SHA; běžné změny z předchozí části integrovat, při skutečném konfliktu požadavků jej popsat a nepřepisovat cizí práci.

## Předání a ověření

Každý plán uvádí konkrétní testy. Pro finální předání první etapy spustit jednou `npm run release:verify` a cílené Playwright testy 001/002; příkaz release:verify pouze testuje a sestavuje, nenasazuje. Potřebné závislosti instalovat standardním projektovým postupem jen pokud chybí. Při nedostupném runtime jasně oddělit hotový kód od neprovedeného ověření.

UI ověřit v integrovaném prohlížeči; skutečné e2e testy přes Playwright jsou vhodné. U persistentního dev serveru dodržet PortPilot registraci, bind `0.0.0.0` a předat localhost, LAN i Tailscale URL po jejich skutečném zjištění. Dočasný e2e server se do PortPilotu neregistruje. Nezastavovat cizí procesy. Testy mohou používat existující fixture port 8790 pouze pokud jej nevlastní jiná služba.

Při pozdějším autorizovaném nasazení dodržet `docs/RELEASING.md`: cache baseline, čistý commit, izolované staging D1, záloha před migrací a kontrola CPU limitů Workers Free. Doplnění indexu nesmí vrátit parsování celého katalogu do každého API požadavku. Migrations/seed a frontend mají být kompatibilní při postupném release; static build nikdy nesmí smazat komunitní data.

## Zdroje pro adresní hledání

- [Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/), ověřeno 24. 9. 2026: veřejný server zakazuje autocomplete. Limit 1 požadavek/s platí pro aplikaci celkem; debounce sám zákaz neřeší. Nový omnibox jej proto pro našeptávání nepoužije.
- [Mapy.com Suggest tutorial](https://developer.mapy.com/rest-api-mapy-cz/tutorials/suggest/) a [aktuální API](https://api.mapy.com/v1/docs/geocode/): podporované našeptávání; ověřit oprávnění a kvótu existujícího hostname-restricted browser klíče. Nepovolovat placený tarif ani neměnit účet bez samostatného zadání.

## Zvažované a odmítnuté zkratky

- Pouhé zpřístupnění tlačítka opravy pro text: připomínky by zasahovaly do hlasování.
- Další verdict v `corrections`: zbytečně propojuje nezávislá data s projekcí poloh.
- „Osoba = autor“ nebo „nejbližší ulice = místo snímku“: tvrzení není podložené.
- Pevné počty 21 fotek v UI: 21 byl počet statických skupin, nikoli univerzální počet fotografií.
- Záměna hypotézy o špendlíku za opravu cache bez reprodukce: hrozí regresní chyba v již funkční konzistenci snapshotů.
