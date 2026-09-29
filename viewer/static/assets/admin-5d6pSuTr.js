import{m as n}from"./loadLegacyScripts-BR7TvZWU.js";const a=`  <div class="page">
    <header class="topbar">
      <div>
        <p class="eyebrow">Admin</p>
        <h1>Komunitní revize</h1>
        <p class="subtitle">
          Čekající opravy, hlášení, konflikty a export dat.
        </p>
        <div class="topbar-actions">
          <a class="action-link" href="./index.html">Zpět na mapu</a>
          <a class="action-link" href="./pomoc.html">Zpět na pomoc</a>
        </div>
      </div>
      <div class="topbar-meta">
        <div class="stat">
          <span class="stat-label">Čekající opravy</span>
          <span class="stat-value" id="count-pending">0</span>
        </div>
        <div class="stat">
          <span class="stat-label">Neuzavřená hlášení</span>
          <span class="stat-value" id="count-flags">0</span>
        </div>
        <div class="stat">
          <span class="stat-label">Konflikty</span>
          <span class="stat-value" id="count-conflicts">0</span>
        </div>
      </div>
    </header>

    <main class="content">
      <section class="card" id="admin-login-card">
        <div class="card-header">
          <h2>Přihlášení správce</h2>
          <p class="card-subtitle">Vložte přístupový token. Po přihlášení z pole zmizí a prohlížeč si ponechá jen chráněné přihlášení.</p>
        </div>
        <div class="form-actions">
          <label class="field">
            <span>Přístupový token</span>
            <input id="admin-token" type="password" autocomplete="current-password" aria-describedby="admin-status" />
          </label>
          <button class="secondary" type="button" id="save-admin-token">Použít token</button>
          <button class="secondary" type="button" id="logout-admin">Odhlásit</button>
        </div>
      </section>

      <section class="card" id="annotation-editor">
        <div class="card-header"><h2>Upřesnění správce</h2>
          <p class="card-subtitle">Ověřené vysvětlení se zveřejňuje samostatně. Původní popis z archivu zůstane zachovaný.</p></div>
        <div class="form-actions"><label class="field"><span>ID fotografie</span><input id="annotation-xid" type="text" maxlength="128" /></label>
          <button type="button" class="secondary" id="annotation-load">Načíst fotografii</button></div>
        <p id="annotation-status" role="status"></p>
        <div id="annotation-content" hidden>
          <p id="annotation-loaded"></p>
          <button type="button" class="secondary" id="annotation-restore" hidden>Obnovit rozepsané údaje z tohoto okna</button>
          <h3>Popis z archivu</h3><p id="annotation-archive"></p>
          <label class="field"><span>Veřejné upřesnění</span><textarea id="annotation-text" maxlength="2000" rows="5"></textarea></label>
          <label class="field"><span>Doklad ověření (jen pro správce)</span><textarea id="annotation-evidence" maxlength="2000" rows="3"></textarea></label>
          <label class="field"><span>Přiřazení míst</span><select id="annotation-mode"><option value="keep">Ponechat dosavadní místa</option><option value="replace">Nahradit ověřeným seznamem</option><option value="unknown">Místo není určeno</option></select></label>
          <label class="field"><span>Ověřená místa (lze vybrat více)</span><select id="annotation-places" multiple size="6"></select></label>
          <label class="field"><span>Zpochybněná místa z původního přiřazení</span><select id="annotation-disputed" multiple size="4"></select></label>
          <h3>Náhled veřejného upřesnění</h3><p id="annotation-preview"></p>
          <p class="helper">Doklad ověření, připomínky ani e-mail se nezveřejní. Uložení rozpracované verze nezmění dosavadní zveřejněné upřesnění.</p>
          <div class="form-actions"><button type="button" class="secondary" id="annotation-draft">Uložit rozpracované</button><button type="button" class="primary" id="annotation-publish">Zveřejnit upřesnění</button><button type="button" class="secondary" id="annotation-withdraw">Stáhnout zveřejněné upřesnění</button></div>
          <h3>Historie změn</h3><div id="annotation-history"></div>
        </div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Provozní stav</h2>
          <p class="card-subtitle">Aktuálnost změn na veřejném webu, co čeká na kontrolu a aktivita přispěvatelů.</p>
        </div>
        <div id="admin-operations" class="detail-list full-width"></div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Export</h2>
          <p class="card-subtitle">JSON/CSV export korekcí, merge rozhodnutí a agregovaných stavů.</p>
        </div>
        <div class="form-actions">
          <label class="field">
            <span>Od data (ISO, volitelné)</span>
            <input id="export-since" type="text" placeholder="2026-01-01T00:00:00Z" />
          </label>
          <label class="field">
            <span>Limit</span>
            <input id="export-limit" type="number" min="1" max="5000" value="500" />
          </label>
        </div>
        <div class="review-controls">
          <button class="secondary" type="button" id="refresh-admin">Obnovit</button>
          <button class="secondary" type="button" id="export-json">Export JSON</button>
          <button class="secondary" type="button" id="export-csv">Export CSV</button>
        </div>
        <p class="helper" id="admin-status" role="status" aria-live="polite"></p>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Čekající opravy polohy</h2>
        </div>
        <div id="list-pending" class="detail-list full-width"></div>
      </section>

      <section class="card" aria-labelledby="feedback-heading">
        <div class="card-header">
          <h2 id="feedback-heading">Připomínky</h2>
          <p class="card-subtitle">Soukromé zprávy k fotografiím. Změna stavu nemění hlasování ani polohu.</p>
        </div>
        <div class="review-controls" role="group" aria-label="Stav připomínek">
          <button class="secondary" type="button" id="feedback-new" aria-pressed="true">Nové</button>
          <button class="secondary" type="button" id="feedback-resolved" aria-pressed="false">Vyřízené</button>
        </div>
        <p class="helper" id="feedback-admin-status" role="status" aria-live="polite"></p>
        <div id="feedback-admin-list" class="feedback-admin-list"></div>
        <button class="secondary" type="button" id="feedback-more" hidden>Načíst další</button>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Neuzavřená hlášení</h2>
        </div>
        <div id="list-flags" class="detail-list full-width"></div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Možné konflikty</h2>
        </div>
        <div id="list-conflicts" class="detail-list full-width"></div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Skupiny navržené k rozdělení</h2>
          <p class="card-subtitle">Porovnejte fotografie a přesuňte je do nové nebo existující skupiny.</p>
        </div>
        <div id="list-splits" class="detail-list full-width"></div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Historie přesunů mezi skupinami</h2>
          <p class="card-subtitle">Každý přesun je zaznamenaný. Chybný přesun můžete vrátit.</p>
        </div>
        <div id="list-membership-history" class="detail-list full-width"></div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Poslední rozhodnutí o sloučení</h2>
        </div>
        <div id="list-merges" class="detail-list full-width"></div>
      </section>
    </main>
  </div>
`;n(a,["./annotation-admin.js","./admin.js"]).catch(console.error);
