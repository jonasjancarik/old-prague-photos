import{u as s,j as n,c as a}from"./useLegacyScripts-CXtpnk8r.js";const t=`  <div class="page">
    <header class="topbar">
      <div>
        <p class="eyebrow">Admin</p>
        <h1>Komunitní revize</h1>
        <p class="subtitle">
          Přehled čekajících oprav, flagů, konfliktů a export dat pro ruční kontrolu.
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
          <span class="stat-label">Neuzavřené flagy</span>
          <span class="stat-value" id="count-flags">0</span>
        </div>
        <div class="stat">
          <span class="stat-label">Konflikty</span>
          <span class="stat-value" id="count-conflicts">0</span>
        </div>
      </div>
    </header>

    <main class="content">
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
        <p class="helper" id="admin-status"></p>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Čekající opravy polohy</h2>
        </div>
        <div id="list-pending" class="detail-list full-width"></div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Neuzavřené flagy</h2>
        </div>
        <div id="list-flags" class="detail-list full-width"></div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Kandidáti konfliktů</h2>
        </div>
        <div id="list-conflicts" class="detail-list full-width"></div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Poslední merge rozhodnutí</h2>
        </div>
        <div id="list-merges" class="detail-list full-width"></div>
      </section>
    </main>
  </div>

`,i=["./admin.js"];function e(){return s(i),n.jsx("div",{dangerouslySetInnerHTML:{__html:t}})}a(document.getElementById("root")).render(n.jsx(e,{}));
