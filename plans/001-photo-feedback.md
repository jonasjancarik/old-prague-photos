# 001: Poslat soukromou připomínku k fotografii

Read when: implementing independent photo feedback and the admin inbox.

## Zadání a výchozí stav

Priority P1; effort M; risk MED (nové ukládání soukromého textu a administrace); závislosti žádné. Plánováno na `dbf028ae68d37c63bc48482a36f50eacc86c1e14`, 24. 9. 2026.

Uživatel nemohl odeslat poznámku k nevhodnému výsledku hledání, protože nechtěl měnit správnou polohu. Cílem je obecné „Poslat připomínku“ v detailu fotografie, se samostatným úložištěm a frontou správce. Připomínka není hlas ani hlášení nesprávné polohy.

Ověřit před úpravami: `git diff --stat dbf028ae68d37c63bc48482a36f50eacc86c1e14..HEAD -- functions/api viewer migrations tests e2e docs` a `git status --short`. Zachovat cizí změny.

Relevantní současný kód:

```js
// viewer/static/correction-ui.js:183
const hasProposed = !!this.proposedCoords;
this.submitBtn.disabled = !hasProposed || this.submitting || this.saved;
// functions/api/corrections.js:126
if (verdict === "wrong" && !hasCoordinates) {
  return jsonResponse({ detail: "Pro opravu je nutná poloha" }, 400);
}
```

Toto pravidlo pro opravdové opravy zachovat. `migrations/0010_community_projections.sql` má trigger na `corrections`, který zneplatní projekci; nové připomínky do této tabulky vůbec nepatří.

Pozor na existující lokální cestu: `viewer/app.py:90` má `FeedbackPayload` a kolem 2741 `POST /api/feedback`, ukládající `viewer/data/feedback.jsonl`. Je to starší implementace bez Pages protějšku, s přímým tokenovým ověřením a nežádoucím `newsletter_opt_in = bool(email)`. Sjednotit tento endpoint s novým kontraktem; nezakládat vedle něj druhý konkurenční endpoint a nepřenášet souhlas s newsletterem. Existující soukromé soubory nesmazat ani automaticky importovat do produkce.

## Rozsah

Upravit nebo vytvořit `functions/api/feedback.js`, `functions/api/admin/feedback.js`, případný malý sdílený feedback helper, novou následující SQL migraci (aktuálně 0016), `viewer/app.py`, `viewer/static/feedback-ui.js`, `viewer/static/app.js`, `viewer/static/admin.js`, `viewer/static/styles.css`, index/admin šablony a jejich entry imports. Dále příslušné API/Python/e2e testy, `scripts/d1-smoke.sql`, `docs/web-app.md`, `docs/community-voting.md`, `docs/komunitni-pomoc.md`, tento status a generované Vite výstupy.

Neměnit konsenzus poloh, vyhledávání, geodata, seskupování, autentizační politiku správce, tarify ani infrastrukturu. Z existujících bezpečnostních helperů jen použít potřebné funkce; obecný bezpečnostní refaktor není součástí.

## Datový a API kontrakt

- Nová tabulka `photo_feedback` ve stávající D1 vazbě `CORRECTIONS_DB`, samostatná od `corrections`. Pole: interní ID, unikátní `submission_id`, stabilní `xid`, `message`, nullable `email`, `status` (`new` / `resolved`), `created_at`, nullable `resolved_at`. Index pro frontu `(status, id)`. Bez triggeru na komunitní revision/projekce. Neodvozovat mazání od změny skupiny.
- `POST /api/feedback`: `submission_id` (UUID generované jednou pro jeden rozepsaný příspěvek), `xid`, text 5–2000 znaků po ořezání, volitelný e-mail max. 254 znaků. Validovat typy, známé XID přes existující D1 katalog, e-mail a maximální délku payloadu. Žádné souřadnice, verdict ani závislost na aktuální group/candidate revision. Staré `issue` lze tolerovat a ignorovat pro kompatibilitu lokálního endpointu, formulář jej nepotřebuje.
- Úspěch vrací jen potvrzení a ID; nevystavuje e-mail/text ostatních. Opakování stejného `submission_id` se stejným obsahem nevytvoří druhý záznam; odlišný obsah pod stejným ID vrátí 409. Databázová unikátnost je autorita, ne pouze kontrola před insertem.
- Použít `assertSameOrigin`, sdílený write rate limit, platnou session nebo existující Turnstile postup a odpovídající lokální variantu. Ve frontendovém kódu použít `OldPragueSession.submitWithSessionRetry`. Žádný produkční bypass. Ověření smí vyžádat opakování pouze neprovedeného zápisu.
- Soukromý `GET /api/admin/feedback?status=new&limit=...&before_id=...`: autentizace `authorizeAdmin`, no-store, výchozí stránka 30, maximum 100, stabilní sestupné stránkování. Nevkládat neomezený seznam do veřejného `review-state` ani do náročné existující admin projekce.
- `POST /api/admin/feedback` s ID a cílovým stavem: admin auth + same-origin, pouze `new`/`resolved`; opakovaná stejná změna je bezpečná, při návratu do `new` vyčistit `resolved_at`. Vyřízení připomínky nesmí měnit fotografii, polohu ani hlasy.
- FastAPI zachová vlastní oddělené JSONL úložiště, stejnou validaci, lock při idempotentním appendu a odpovídající admin API. Stavové změny ukládat samostatně nebo jako události, bez přepisování existujících hlášení. Staré záznamy bez statusu zobrazit jako nové; nové již nemají newsletter flag. Veřejné kontrakty obou backendů musí být shodné.

## Kroky

1. **Úložiště a endpointy.** Přidat migraci a veřejný/soukromý endpoint. Modelovat bezpečnost a chyby podle `functions/api/corrections.js`, správce podle `functions/api/admin/group-membership.js`. Výpisy dotazovat přes index a limit; žádné načtení celého GeoJSON v každém requestu. Lokální legacy cestu přizpůsobit bez migrace soukromých dat na dálku.
   Ověření: nový `functions/api/__tests__/feedback.test.mjs` spustit `node --test functions/api/__tests__/feedback.test.mjs`; nový `tests/test_feedback.py` přes `uv run pytest -q tests/test_feedback.py`. Očekávání: validní submit, validation/security chyby, idempotence a admin paging procházejí.
2. **Formulář fotografie.** Vedle opravy polohy přidat `Poslat připomínku`. Samostatná, přístupná část dialogu s textem „Nesedí popis nebo jste narazili na jiný problém? Napište nám.“ a nepovinným e-mailem. Uvést „Připomínku uvidí pouze správce.“ Nesmí vzniknout mapa k povinnému posunutí. Odeslání odemknout platným textem, nikoli e-mailem či změnou bodu. Při chybě text ponechat; dvojklik nezaloží další záznam. Při úspěchu „Děkujeme, připomínku jsme poslali správci.“ XID zachytit při otevření; při přechodu na jiný snímek nepřenést poznámku omylem. Email neukládat do browser storage. Zachovat Escape, focus trap a návrat focusu.
   Ověření: `npm run build:viewer` skončí 0; e2e ověří note-only submit, nepovinný e-mail, nedostupné API, retry a konkrétní XID.
3. **Fronta správce.** V admin šabloně přidat sekci „Připomínky“ s přepínačem Nové / Vyřízené, textem, datem, odkazem na fotografii a e-mailem pouze v oprávněném zobrazení. Akce „Označit jako vyřízené“ a „Vrátit mezi nové“, načtení další stránky. Render textu přes `textContent`/bezpečné existující funkce. Chyba této fronty nemá zablokovat ostatní admin sekce. Neodesílat automatické odpovědi.
   Ověření: autentizovaný e2e submit → admin list → vyřešit → vrátit; neautentizovaný přístup odmítnut. Test SQL/HTML payloadu jako obyčejného textu.
4. **Dokumentace a end-to-end důkaz.** Popsat účel, soukromí, stavový model a nezávislost na hlasování. Přidat migraci do skutečné lokální D1 smoke kontroly; nepovažovat FakeD1 za test SQL syntaxe. Vytvořit `e2e/photo-feedback.spec.mjs` podle `e2e/community-flows.spec.mjs`.
   Ověření: `npm run test:d1`, `npm run test:e2e -- e2e/photo-feedback.spec.mjs`; obojí exit 0. UI prohlédnout na 390×844 a 1440×900 v lokálním integrovaném prohlížeči.

## Povinné regresní případy

- Snímek s věží: text jde odeslat bez souřadnic a bez e-mailu. Korekční formulář si naopak dál vyžádá bod.
- Snapshot stavu poloh, jeho komunitní revision a počet hlasů jsou stejné před submit, po submit i po vyřízení. Anti-spam účetnictví se může změnit, poloha nikoli.
- Merge/split skupiny neztratí připomínku přiřazenou XID; záznam nepotřebuje candidate revision.
- Neznámé XID, prázdný/whitespace/krátký/dlouhý text, neplatný e-mail, chybějící session, jiný Origin a rate-limit jsou pokryté.
- GET mimo admin nezpřístupní text ani e-mail. Public review-state ani katalog připomínky neobsahují.
- Idempotentní retry, stránkování bez duplicit a návrat z vyřízeného stavu fungují i na skutečné lokální D1.
- Lokální feedback nevytváří newsletter souhlas a nesmaže staré záznamy.

## Hotovo a předání

Testy výše projdou, vizuální kontrola má konkrétní výsledky, dokumentace odpovídá UI, `git diff --check` bez chyb. Aktualizovat stav 001 v `plans/README.md`, vytvořit logický commit nebo několik commitů v přiděleném worktree. Finální společný gate s 002: `npm run release:verify`; neprovádět ho opakovaně beze změny.

Přerušit závislou část a popsat problém, pokud by test vyžadoval produkční D1, přístupová práva nešla ověřit, nebo se ukázalo, že katalog neobsahuje XID viditelné ve formuláři; neopravovat to obcházením validace. Běžné testové chyby řešit v rozsahu úkolu. Nepřidávat veřejné komentáře, editaci metadat ani export soukromých připomínek do veřejných souborů.
