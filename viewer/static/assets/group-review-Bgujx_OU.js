import{u as a,j as n,c as s}from"./useLegacyScripts-CXtpnk8r.js";const e=`  <div class="page">
    <header class="topbar">
      <div>
        <p class="eyebrow">Kontrola skupin</p>
        <h1>Série podle obsahu, autora a datace</h1>
        <p class="subtitle">
          Série vznikají ze shody metadata (obsah + autor + datace). Projděte verze a skeny v rámci jedné série.
        </p>
        <div class="topbar-actions">
          <a class="action-link" href="./pomoc.html">Zpět na pomoc</a>
          <a class="action-link" href="./index.html">Zpět na mapu</a>
        </div>
      </div>
      <div class="topbar-meta">
        <div class="stat">
          <span class="stat-label">Sérií s více verzemi</span>
          <span class="stat-value" id="group-count">—</span>
        </div>
        <div class="stat">
          <span class="stat-label">Zbývá</span>
          <span class="stat-value" id="remaining-count">—</span>
        </div>
        <div class="stat">
          <span class="stat-label">Série</span>
          <span class="stat-value" id="current-group">—</span>
        </div>
      </div>
    </header>

    <main class="review">
      <section class="card review-card">
        <div class="review-controls">
          <button class="secondary" type="button" id="prev-group" disabled>
            Předchozí skupina
          </button>
          <button class="secondary" type="button" id="next-group">
            Další skupina
          </button>
        </div>
        <p class="helper review-source" id="group-summary">Série: —</p>
        <div class="group-actions">
          <p class="helper group-actions-title" id="group-action-text">
            Zkontrolujte verze/skeny této série a zvolte další krok.
          </p>
          <div class="group-actions-buttons">
            <button class="vote vote-up" type="button" id="group-mark-ok">
              Série vypadá dobře
            </button>
            <button class="secondary" type="button" id="group-open-dedupe">
              Prověřit v párovém porovnání
            </button>
            <a class="secondary group-archive-link" id="group-archive-link" href="#" target="_blank" rel="noopener">
              Otevřít archivní stránku
            </a>
          </div>
        </div>

        <div class="review-grid">
          <div class="review-column">
            <div class="preview-frame">
              <div class="zoom-wrap">
                <div id="group-zoom" class="zoom-viewer" aria-label="Náhled fotografie"></div>
                <img id="group-preview" class="zoom-preview" alt="Náhled fotografie" loading="lazy" />
              </div>
            </div>
          </div>

          <div class="review-column">
            <div class="review-meta">
              <div id="group-details" class="detail-list full-width"></div>
            </div>
          </div>
        </div>

        <div class="form-status-wrap">
          <p class="form-status" id="group-status"></p>
        </div>
      </section>
    </main>
  </div>

`,t=["https://unpkg.com/openseadragon@4.1.1/build/openseadragon/openseadragon.min.js","./zoomify.js","./photo-meta.js","./grouping.js","./media-filter.js","./group-review.js"];function i(){return a(t),n.jsx("div",{dangerouslySetInnerHTML:{__html:e}})}s(document.getElementById("root")).render(n.jsx(i,{}));
