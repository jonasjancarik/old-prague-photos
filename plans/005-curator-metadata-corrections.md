# 005: Správce doplní ověřené vysvětlení a místo

Read when: implementing curated public annotations without overwriting archive metadata.

## Kontext a stav

Priority P3; effort L; risk HIGH kvůli veřejným opravám a konzistenci indexu. Závisí na 001, 003 a 004. Toto je pozdější samostatný úkol, nikoli součást první implementace. Plánováno na `dbf028ae68d37c63bc48482a36f50eacc86c1e14`, 24. 9. 2026. Před zahájením porovnat implementované kontrakty předchozích částí s tímto návrhem.

Současný detail renderuje původní `description`; oprava v `corrections` mění pouze polohu a její komunitní stav. Špatně pojmenovaný snímek se proto po přesunu bodu může dál objevovat pod původní ulicí. Archivní originál musí zůstat dohledatelný, ale správce má mít možnost publikovat ověřené vysvětlení a opravit aktivní přiřazení místa.

Rozsah: nová samostatná D1 tabulka/small metadata overlay API, admin formulář a veřejné zobrazení přes `photo-meta.js`/detail, propojení s place indexem 003/004, FastAPI obdoba, testy a dokumentace. Příslušné nové soubory pod `functions/api/admin`, `functions/api`, nová další migration, admin/index/pomoc templates, shared frontend metadata helper a relevantní entry imports. Bez změny archivních raw JSON/CSV, souřadnic, konsenzu nebo veřejného editování.

## Funkční kontrakt

- Připomínka 001 je neveřejný podnět. Správce ji může vyřídit bez publikace. Publikace ověřeného doplnění je samostatná výslovná akce s náhledem; text ani e-mail připomínky se automaticky nezveřejní.
- Kurátorský záznam je po XID: veřejné vysvětlení (max. 2000 znaků), odkaz/poznámka k důkazu, případné schválené place IDs, explicitně zpochybněná původní přiřazení, stav draft/published/withdrawn a vlastní revision. Uchovat předešlé verze a čas změny; identita správce z existující auth vrstvy nesmí do veřejného payloadu vynést token.
- Rozlišit „ponechat místa“, „nahradit ověřeným seznamem“ a „místo neurčeno“. Prázdné pole nesmí nechtěně vymazat vše. Ulice, čtvrť a jiné typy entit držet odděleně. Náhrada se týká normalizovaných vztahů, nikoli původních slov v archivním záznamu.
- Opravené přiřazení je prioritní v sekci Místa a jejích počtech. Zpochybněné přiřazení se nepočítá jako aktivní vztah jen proto, že zůstává v originálním textu. Původní popis je stále dohledatelný v textových výsledcích, označený spolu s viditelným kurátorským vysvětlením.
- Veřejně „Popis z archivu“ a „Upřesnění správce“; neprezentovat archivní text jako nově potvrzený. Nepřepisovat AHMP web a nesdělovat archivu opravu automaticky.
- Publikace/stažení updatuje pouze metadata revision/index, nikoli community location revision. Optimistická concurrency kontrola zabrání přepsání novější správcovy verze. Každé publikování je dohledatelné a lze je stáhnout.
- Pokud správce zatím nemá dost důkazů k Filipovu snímku, může uložit draft; samotná existence připomínky ani schváleného bodu neznamená historické ověření ulice.

## Implementační kroky a ověření

1. Navrhnout konkrétní migraci a oddělené auth/no-store admin API podle 001 a `_admin_auth.js`. Jen publikované očištěné overlay údaje mohou být v veřejném read API. Nevkládat soukromé připomínky ani admin evidence do veřejného payloadu. Nové `functions/api/__tests__/photo-annotations.test.mjs` přes `node --test functions/api/__tests__/photo-annotations.test.mjs` → auth, validace, stale revision 409, publish/withdraw a soukromí projdou.
2. Admin: z připomínky otevřít příslušné XID, původní metadata, formulář a náhled budoucího zobrazení. Vyřízení a publikaci zachovat jako odlišné akce. Umožnit draft, explicitní publikaci a stažení bez mazání historie. XSS text renderovat jako text, URL validovat na povolené webové schéma.
3. Public overlay a index: načítat revizované změny úsporně, nikoli v každém requestu skládat celý katalog. Ověřit chování cache při publish/withdraw, nový i již otevřený prohlížeč musí dostat konzistentní revision. Čerstvý uživatel nesmí dostat opravený detail a starý počet míst ve stejné revizi. Při selhání overlay načtení nevracet potichu vyvrácené vztahy jako jisté; sdělit nedostupnost aktuálních upřesnění a nechat dostupný původní archivní text.
4. Nový `e2e/curator-annotations.spec.mjs`: submit soukromé připomínky → admin draft → public stále beze změny → publish → detail i hledání odpovídají → withdraw vrátí předchozí stav, hlasy a geometry stále stejné. Testovat i změnu skupiny při stejném XID a konflikt dvou správcovských editací. `npm run test:e2e -- e2e/curator-annotations.spec.mjs` → exit 0.
5. Doplnit FastAPI parity testy, skutečnou lokální D1 migraci, dokumentaci původu údajů a správcovského postupu. Vizuální kontrola admin/public na mobilu a desktopu. `npm run release:verify`, cílené e2e, `git diff --check` → exit 0.

## Podmínky dokončení a omezení

Správce může navázat veřejné ověřené doplnění na konkrétní fotografii bez přepsání archivního originálu; vyhledávání respektuje publikované opravy; soukromé připomínky a e-mail nikdy neuniknou do overlay; polohy a hlasy zůstanou beze změny; změna je vratná a auditovatelná. Stav 005 aktualizovat v indexu.

Tato část je úmyslně odložená, aby nezdržela sběr připomínek a základní hledání. Pokud by vyžadovala jinou autorizační roli, editor celé ontologie ulic nebo plošnou rekatalogizaci fotografií, nejprve předložit menší konkrétní rozsah. Nenasazovat bez samostatného oprávnění a release postupu projektu.

## Ověřený kandidát 26. 9. 2026

Implementace ve větvi `codex/curator-annotations` obsahuje lokální main `992c2411` s etapami 001–004. Migrace `0017_photo_annotations.sql` přidává nezávislé anotace, audit a revizi; indexovaný lookup míst se aktualizuje při importu katalogu. Admin má náhled a samostatné draft/publish/withdraw, veřejný detail a vyhledávání používají stejný snapshot. Připomínky, e-maily a důkazy nejsou veřejné. Žádná reálná historická oprava nebyla vložena.

Ověřeno: `npm run release:verify` exit 0 (206 Python testů, 121 API testů, lokální D1 migrace a 8 anotací SQL assertions, Vite build); všechny požadované e2e sady mají dohromady 24 různých prošlých případů. První společný běh měl 22/23 úspěchů: lokální Pages server v jednom bootstrapu vrátil uříznutý GeoJSON (8 796 857 místo 17 113 061 bajtů, trace potvrdil nevalidní JSON). Cílené opakování tohoto případu a doplněného testu změny skupiny prošlo 2/2 bez změny aplikačního toku. Před tím byly dva timeouty přípravy serveru (180/300 s), nikoli neúspěšné testy; migrace, seed a testový server byly poté spuštěny odděleně. Veškeré zápisy šly pouze do izolované lokální D1 `/tmp/old-prague-005-final-d1`.

Admin a veřejný detail ověřeny v integrovaném prohlížeči na desktopu a mobilu, pouze proti dočasné FastAPI databázi s testovacím vysvětlením. Doklad i originál se zobrazují ve správných soukromých/veřejných částech. Detail a index mají ověřenou shodnou metadata revizi; stažení obnovuje archivní vztahy a neovlivňuje komunitní revision. Při stejné revizi se overlay znovu neagreguje. Změny z jiného prohlížeče mohou mít až 30 sekund zpoždění, uvnitř jedné vykreslené revize je zobrazení konzistentní.

Live API a Mapy hostname/key/kvóta nebyly ověřeny. Push, deployment ani merge do lokálního main nejsou součástí tohoto kandidátního předání. Merge slot řídí koordinátor po review.
