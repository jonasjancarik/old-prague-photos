import{u as e,j as n,c as a}from"./useLegacyScripts-BrBHSRBv.js";const s=`  <div class="page">
    <header class="topbar">
      <div>
        <p class="eyebrow">Kontrola podobných záběrů</p>
        <h1>Porovnání podobných záběrů</h1>
        <p class="subtitle">
          Dvojice skupin se shodnou polohou nebo vizuálně podobné snímky. Označte, zda jde o stejný záběr (jiný sken,
          ořez, barevnost, náklon) nebo různé záběry.
        </p>
        <div class="topbar-actions">
          <a class="action-link" href="./pomoc.html">Zpět na pomoc</a>
          <a class="action-link" href="./index.html">Zpět na mapu</a>
        </div>
      </div>
        <div class="topbar-meta">
          <div class="stat">
          <span class="stat-label">Kandidáti ke kontrole</span>
          <span class="stat-value" id="candidate-count">—</span>
        </div>
        <div class="stat">
          <span class="stat-label">Zbývá</span>
          <span class="stat-value" id="remaining-count">—</span>
        </div>
      </div>
    </header>

    <main class="review">
      <section class="card help-mode" data-mode-picker>
        <div>
          <p class="eyebrow">Vyberte režim</p>
          <h2>Jak chcete pomoct?</h2>
          <p class="helper">
            Opravy polohy, kontrola podobných záběrů i revize skupin pomáhají zpřesnit mapu historických fotografií.
          </p>
        </div>
        <div class="help-mode-actions">
          <a class="secondary report-button" href="./pomoc.html?mode=location">Oprava polohy</a>
          <a class="primary report-button" href="./dup-review.html?mode=dedupe" data-mode-select="dedupe"
            aria-current="page">Kontrola podobných záběrů</a>
          <a class="secondary report-button" href="./group-review.html">Kontrola skupin</a>
        </div>
      </section>

      <section class="card review-card is-hidden" data-mode-flow="dedupe">
        <div class="review-controls">
          <button class="secondary" type="button" id="prev-pair" disabled>
            Předchozí pár
          </button>
          <button class="vote vote-up" type="button" id="mark-same">
            Stejný záběr
          </button>
          <button class="vote vote-down" type="button" id="mark-different">
            Různé záběry
          </button>
          <button class="secondary" type="button" id="skip-pair">
            Další pár
          </button>
        </div>
        <p class="helper review-source" id="pair-source">Zdroj páru: —</p>
        <p class="helper review-source is-hidden" id="pair-filter"></p>

        <div class="review-grid">
          <div class="review-column">
            <div class="preview-frame">
              <div class="zoom-wrap">
                <div id="left-zoom" class="zoom-viewer" aria-label="Náhled fotografie"></div>
                <iframe id="left-iframe" title="Archivní záznam" loading="lazy" referrerpolicy="no-referrer"></iframe>
              </div>
            </div>
            <div class="review-meta">
              <div id="left-details" class="detail-list full-width"></div>
            </div>
          </div>

          <div class="review-column">
            <div class="preview-frame">
              <div class="zoom-wrap">
                <div id="right-zoom" class="zoom-viewer" aria-label="Náhled fotografie"></div>
                <iframe id="right-iframe" title="Archivní záznam" loading="lazy" referrerpolicy="no-referrer"></iframe>
              </div>
            </div>
            <div class="review-meta">
              <div id="right-details" class="detail-list full-width"></div>
            </div>
          </div>
        </div>

        <div class="turnstile-wrap">
          <p class="helper" id="turnstile-note"></p>
        </div>

        <div class="form-status-wrap">
          <p class="form-status" id="review-status"></p>
        </div>
      </section>
    </main>
  </div>

`,i=["https://unpkg.com/openseadragon@4.1.1/build/openseadragon/openseadragon.min.js","./zoomify.js","./photo-meta.js","./grouping.js","./media-filter.js","./session-verify.js","./dup-review.js","./mode-picker.js"];function o(){return e(i),n.jsx("div",{dangerouslySetInnerHTML:{__html:s}})}a(document.getElementById("root")).render(n.jsx(o,{}));
