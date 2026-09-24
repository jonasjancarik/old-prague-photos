import{m as n}from"./loadLegacyScripts-QtUAv0ZZ.js";import{i as s}from"./openseadragon-CWtobWd5.js";const a=`  <div class="page page-help">
    <header class="topbar">
      <div>
        <p class="eyebrow">Komunitní kontrola</p>
        <h1>Kontrola skupin</h1>
        <p class="subtitle">
          Zkontrolujte, jestli fotografie v jedné skupině opravdu patří k sobě.
        </p>
        <div class="topbar-actions">
          <a class="action-link" href="./pomoc.html">Vybrat jiný úkol</a>
          <a class="action-link" href="./index.html">Zpět na mapu</a>
        </div>
      </div>
      <div class="topbar-meta">
        <div class="stat">
          <span class="stat-label">Vaše kontroly</span>
          <span class="stat-value" id="session-count">0</span>
        </div>
      </div>
    </header>

    <main class="review">
      <section class="card review-card">
        <div class="help-question">
          <h2>Patří všechny fotografie ve skupině k sobě?</h2>
          <p class="help-caption" id="group-caption"></p>
          <p class="helper review-source" id="group-summary">Skupina: —</p>
        </div>

        <div class="group-strip" id="group-strip" aria-label="Fotografie ve skupině" hidden></div>

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

        <div class="help-answer-bar">
          <div class="help-controls">
            <button class="secondary" type="button" id="prev-group" disabled>
              Předchozí skupina
            </button>
            <button class="vote vote-up" type="button" id="group-mark-ok">
              Skupina je správně
            </button>
            <button class="vote vote-down" type="button" id="group-mark-split">
              Skupina míchá různé fotografie
            </button>
            <button class="secondary" type="button" id="next-group">
              Další skupina
            </button>
          </div>

          <div class="help-answer-extra">
            <p class="helper" id="group-action-text"></p>
            <button class="linklike" type="button" id="group-open-dedupe">
              Porovnat s podobnými
            </button>
            <a class="linklike group-archive-link" id="group-archive-link" href="#" target="_blank" rel="noopener">
              Otevřít archivní stránku
            </a>
          </div>

          <div class="form-status-wrap">
            <p class="form-status" id="group-status" role="status" aria-live="polite"></p>
          </div>

          <p class="help-shortcuts" aria-hidden="true">
            Klávesy: <kbd>A</kbd> správně · <kbd>N</kbd> míchá různé · <kbd>→</kbd> další · <kbd>←</kbd> předchozí
          </p>
        </div>

        <details class="workflow-help">
          <summary>Co hodnotím?</summary>
          <div class="workflow-help-body">
            <div class="workflow-help-item">
              <strong>Skupina je správně</strong>
              <span>Fotografie a skeny v této skupině podle vás patří k sobě.</span>
            </div>
            <div class="workflow-help-item">
              <strong>Poloha se tím nepotvrzuje</strong>
              <span>Tento hlas nepotvrzuje, že špendlík na mapě je správně.</span>
            </div>
            <div class="workflow-help-item">
              <strong>Párové porovnání</strong>
              <span>Pokud skupina míchá různé záběry, otevřete párové porovnání.</span>
            </div>
          </div>
        </details>

        <p class="helper help-ref">
          ID skupiny: <span id="current-group">—</span>
          ·
          <button class="linklike" type="button" id="reset-group-progress">Zobrazit znovu prošlé</button>
        </p>
      </section>
    </main>
  </div>
`;s();n(a,["./zoomify.js","./photo-meta.js","./grouping.js","./candidate-client.js","./media-filter.js","./session-verify.js","./group-review.js"]).catch(console.error);
