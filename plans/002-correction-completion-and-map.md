# 002: Srozumitelně dokončit opravu a ukázat oba body

Read when: changing location-correction completion or proposal maps.

## Zadání a současný stav

Priority P1; effort M; risk MED; implementovat po 001 kvůli společnému UI, datová závislost není. Plánováno na `dbf028ae68d37c63bc48482a36f50eacc86c1e14`, 24. 9. 2026.

Po uložení uživatel vidí „Někdo navrhl jinou polohu“ a výzvu „Zkontrolovat návrh“, i když návrh právě vytvořil. Server správně nezapočítá jeho vlastní následný hlas jako nezávislé potvrzení. Úspěch je ve sdíleném formuláři vidět jen krátce. Současně je na úzké stránce kontroly mapa až pod vysokou fotografií.

```js
// viewer/static/app.js:1453
if (correctionState === "pending" && anchorType === "correction") {
  text = "Někdo navrhl jinou polohu. V kontrole uvidíte současný i navržený bod.";
  showProposalReview = true;
}
// viewer/static/pomoc.js:693
state.map.fitBounds([point, proposedPoint], {
  animate: true, maxZoom: 17, padding: [36, 36],
});
```

`pomoc.js` načítá authoritative `review-state?snapshot=1` před první fotografií a při změně evidence přepočítává UI. `review-state.js` u snapshotu obchází edge cache. Neodstraňovat tyto pojistky podle nepotvrzené hypotézy. Při auditu se oba body načetly; chybějící druhý bod po Filipově konkrétním submitu nebyl reprodukován.

## Rozsah

`viewer/static/correction-ui.js`, `app.js`, `pomoc.js`, `styles.css`, index/pomoc šablony a případný malý helper pro vlastní návrhy + entry imports; `functions/api/corrections.js`, `viewer/app.py` pouze doplnění receipt ID; odpovídající API/Python/e2e testy; dokumentace komunitního toku a buildem generované Vite výstupy.

Bez změny pravidel konsenzu, přijetí vlastního hlasu, geodat, vyhledávání a celkové redesignové práce. Před úpravou spustit `git status --short` a `git diff --stat dbf028ae68d37c63bc48482a36f50eacc86c1e14..HEAD -- viewer functions/api/corrections.js e2e`; změny 001 jsou očekávané a zachovat je.

## Navržené chování

1. Bez nového bodu uvést u tlačítka „Nejdřív vyberte správné místo na mapě.“ Tlačítko zůstává neaktivní. E-mail je nepovinný. Připomínky bez změny bodu vedou na 001, nikoli na `wrong`/`flag`.
2. Po úspěšném POST zobrazit „Děkujeme, návrh jsme uložili. Čeká na potvrzení dalšího člověka.“ Potvrzení nezmizí za 500 ms. V hlavním detailu zůstane v metadatech/bannneru; v hromadné kontrole lze přejít na další snímek, ale zpráva musí zůstat dost dlouho a být oznámena přes status. Nabídnout jednoduchou další akci, nevytvářet povinný další krok.
3. Záznam o vlastním návrhu je pouze UX pomůcka pro aktuální browser session. Vrátit z API stabilní ID skutečně vložené korekce (`correction_id` jako string; lokální backend vlastní record ID). Uložit do `sessionStorage` jen XID/ID návrhu, žádný e-mail, text ani voter key. Použít receipt konkrétního submitu, ne aktuální globální návrh po pozdějším fetchi. Při zablokovaném storage funguje alespoň paměť stránky. Session omezení zdokumentovat; nepředstírat rozpoznání autora na jiném zařízení.
4. Vlastní ID porovnat s aktuálním `proposed_id`. Pouze při shodě a pending stavu ukázat osobní poděkování, nezobrazovat výzvu k vlastnímu potvrzení a při přímém otevření kontroly vysvětlit čekání místo aktivního „Potvrdit návrh“. Jiný novější návrh se zobrazuje normálně, schválený návrh dostane schválený stav. UX údaj není autorizace; serverové pravidlo nezávislého hlasu zůstává autoritativní.
5. Odeslání a načtení následného stavu rozlišit: když POST uspěje a refresh selže, sdělit, že návrh je uložený, nabídnout obnovu a nezopakovat POST. Navigace na jinou fotografii během requestu nesmí připsat poděkování jinému XID.
6. U srovnávací mapy mít trvale viditelnou legendu „Současná poloha“ a „Navržená poloha“, odlišný vzhled i jinak než jen barvou a přístupné názvy markerů. Při souběžných bodech nesmí legenda ani stav mizet. Bez návrhu zobrazovat pouze aktuální bod, schválení nesmí zanechat starý návrh.
7. Nejprve reprodukovat úzký layout a změřit rozměry mapy. Po zobrazení či skutečné změně rozměrů provést `invalidateSize`, potom fit obou bodů uvnitř mapy. Nespouštět automatický re-fit při každém pollu beze změny, aby se nerušilo ruční přiblížení či výběr nového bodu. Při příchodu přes „Zkontrolovat návrh“ zajistit, že srovnání není skryté pod vysokým náhledem nebo sticky ovládáním (přiměřená výška náhledu a cílené zobrazení mapy až po načtení). Zachovat možnost fotografii zvětšit.

## Kroky a ověření

1. Doplnit receipt ID do obou backendů bez změny existujících response polí. Test správného ID po dvou souběžných korekcích, nikoli ID posledního obecného SELECTu. D1 použije ID z výsledku konkrétního insertu. Ověřit `node --test functions/api/__tests__/routes.test.mjs functions/api/__tests__/review-state-consensus.test.mjs` a `uv run pytest -q tests/test_viewer_preview_api.py` → všechny projdou.
2. Doplnit potvrzení a rozpoznání vlastního návrhu na obou vstupních místech. Napsat nové `e2e/correction-ux.spec.mjs` s uživatelem A (autor) a B (nezávislý), storage failure, refresh failure a superseded proposal. Využít stávající testovou infrastrukturu; nic neodesílat na produkci.
3. Upravit srovnávací mapu na základě reprodukce. Doplnit e2e cold navigation → první hotové vykreslení bez pomocného kliknutí. Testovat dva body v různých vzdálenostech, překrývající se body, bez návrhu, přepnutí fotky, schválení a resize. Kontrolovat skutečné umístění markerů vůči DOM obdélníku mapy i překrytí sticky ovládáním, ne pouze existenci dvou DOM uzlů.
4. `npm run test:e2e -- e2e/correction-ux.spec.mjs` → exit 0. Ruční vizuální kontrola v integrovaném browseru na 390×844, 820×1060 a 1440×900: oba body a legenda jsou čitelné bez náhodného klikání; ovládání nezakrývá potřebný obsah. Zapsat, který původní problém se reprodukoval a co zůstává neprokázané.
5. Dokumentace: význam uložení vs. schválení, session omezení vlastního návrhu a chování při výpadku refresh. Společný gate první etapy `npm run release:verify` + `npm run test:e2e -- e2e/photo-feedback.spec.mjs e2e/correction-ux.spec.mjs` provést jednou nad konečným stavem.

## Hotovo, rizika a údržba

- [ ] Autor po submitu dostane čitelné dokončení a není vyzýván potvrdit stejný návrh.
- [ ] B může návrh potvrdit, A se stále serverově nepočítá jako nezávislý hlas.
- [ ] ID se neváže na nesprávnou fotografii ani novější cizí návrh.
- [ ] Bez pohybu/výběru bodu formulář vysvětlí neaktivní tlačítko.
- [ ] První vykreslení srovnání a responzivní kontrola projdou, ruční pan/zoom se neresetuje bez změny evidence.
- [ ] `git diff --check` bez chyb, změny pouze v rozsahu, stav 002 v indexu aktualizovaný, logický commit v worktree.

Nevytvářet endpoint zveřejňující autorův voter key nebo per-user údaje v cachovaném veřejném snapshotu. Pokud identifikace vlastního návrhu vyžaduje takový zásah, zachovat session receipt variantu. Neobcházet konzistenci snapshotů ani neoznačovat původní hlášení za opravené jen na základě testu jiného scénáře. Neslučovat, nepushovat a nenasazovat.
