import{m as n}from"./loadLegacyScripts-3eKIZyXn.js";const e=`  <div class="page">
    <header class="topbar">
      <div>
        <p class="eyebrow">Kontrola podobných záběrů</p>
        <h1>Podobné fotografie</h1>
        <p class="subtitle">
          Porovnejte dvě skupiny. Jsou to stejné fotografie, nebo různé záběry?
        </p>
        <div class="topbar-actions">
          <a class="action-link" href="./pomoc.html">Zpět na pomoc</a>
          <a class="action-link" href="./index.html">Zpět na mapu</a>
        </div>
      </div>
        <div class="topbar-meta">
          <div class="stat">
          <span class="stat-label">Párů ke kontrole</span>
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
          <h2>Co chcete zkontrolovat?</h2>
          <p class="helper">
            Poloha i seskupení vznikají automaticky a mohou být chybné. Pomozte je rychle zkontrolovat.
          </p>
          <div class="help-mode-guide" aria-label="Rozdíl mezi režimy">
            <a class="help-mode-card" href="./pomoc.html?mode=location">
              <strong>Oprava polohy</strong>
              <span>Je fotografie správně umístěná na mapě?</span>
            </a>
            <a class="help-mode-card is-current" href="./dup-review.html?mode=dedupe" data-mode-select="dedupe"
              aria-current="page">
              <strong>Podobné fotografie</strong>
              <span>Mají se tyto záběry sloučit?</span>
            </a>
            <a class="help-mode-card" href="./group-review.html">
              <strong>Skupiny fotografií</strong>
              <span>Zkontrolujte, jestli jsou fotografie správně seskupené.</span>
            </a>
          </div>
        </div>
      </section>

      <section class="card review-card is-hidden" data-mode-flow="dedupe">
        <div class="review-controls">
          <button class="secondary" type="button" id="prev-pair" disabled>
            Předchozí pár
          </button>
          <button class="secondary" type="button" id="undo-last" disabled>
            Zpět
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
        <p class="helper review-source" id="pair-source">Vybráno podle: —</p>
        <p class="helper review-source is-hidden" id="pair-filter"></p>

        <details class="workflow-help">
          <summary>Co hodnotím?</summary>
          <div class="workflow-help-body">
            <div class="workflow-help-item">
              <strong>Stejný záběr</strong>
              <span>Skupiny ukazují tutéž fotografii, sken, ořez nebo sérii.</span>
            </div>
            <div class="workflow-help-item">
              <strong>Různé záběry</strong>
              <span>Jde o jiné místo, jiný úhel, jinou událost nebo jiný snímek.</span>
            </div>
            <div class="workflow-help-item">
              <strong>Další pár</strong>
              <span>Přeskočí nejistý pár bez uložení rozhodnutí.</span>
            </div>
          </div>
        </details>

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
          <p class="form-status" id="review-status" role="status" aria-live="polite"></p>
        </div>
      </section>
    </main>
  </div>
`;n(e,["https://unpkg.com/openseadragon@4.1.1/build/openseadragon/openseadragon.min.js","./zoomify.js","./photo-meta.js","./grouping.js","./media-filter.js","./session-verify.js","./dup-review.js","./mode-picker.js"]).catch(console.error);
