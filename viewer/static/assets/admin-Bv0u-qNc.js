import{m as n}from"./loadLegacyScripts-3eKIZyXn.js";const s=`  <div class="page">
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
          <p class="card-subtitle">Vložte přístupový token. Zůstane uložený jen v této kartě prohlížeče.</p>
        </div>
        <div class="form-actions">
          <label class="field">
            <span>Přístupový token</span>
            <input id="admin-token" type="password" autocomplete="current-password" aria-describedby="admin-status" />
          </label>
          <button class="secondary" type="button" id="save-admin-token">Použít token</button>
        </div>
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
          <p class="card-subtitle">Vyberte fotografie, které mají přejít do nové samostatné skupiny.</p>
        </div>
        <div id="list-splits" class="detail-list full-width"></div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Poslední rozhodnutí o sloučení</h2>
        </div>
        <div id="list-merges" class="detail-list full-width"></div>
      </section>
    </main>
  </div>
`;n(s,["./admin.js"]).catch(console.error);
