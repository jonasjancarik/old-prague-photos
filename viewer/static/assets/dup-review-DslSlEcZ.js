import{m as e}from"./loadLegacyScripts-QtUAv0ZZ.js";import{i as n}from"./openseadragon-CWtobWd5.js";const a=`  <div class="page page-help">
    <header class="topbar">
      <div>
        <p class="eyebrow">Komunitní kontrola</p>
        <h1>Podobné fotografie</h1>
        <p class="subtitle">
          Porovnejte dvě skupiny. Jsou to stejné fotografie, nebo různé záběry?
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
        <div class="help-question">
          <h2>Patří obě skupiny k sobě?</h2>
          <p class="help-caption">
            Sloučit můžete stejnou fotografii (jiný sken, ořez nebo barevnost) i různé záběry ze stejného
            focení. Jiné místo nebo jiná událost znamená ponechat zvlášť.
          </p>
          <p class="helper review-source" id="pair-source">Vybráno podle: —</p>
          <p class="helper review-source is-hidden" id="pair-filter"></p>
        </div>

        <div class="review-grid duplicate-review-grid">
          <div class="review-column" data-review-section="preview-a">
            <p class="review-evidence-label">Skupina A</p>
            <div class="preview-frame">
              <div class="zoom-wrap">
                <div id="left-zoom" class="zoom-viewer" aria-label="Náhled fotografie"></div>
                <iframe id="left-iframe" title="Archivní záznam" loading="lazy" referrerpolicy="no-referrer"></iframe>
              </div>
            </div>
          </div>

          <div class="review-column" data-review-section="preview-b">
            <p class="review-evidence-label">Skupina B</p>
            <div class="preview-frame">
              <div class="zoom-wrap">
                <div id="right-zoom" class="zoom-viewer" aria-label="Náhled fotografie"></div>
                <iframe id="right-iframe" title="Archivní záznam" loading="lazy" referrerpolicy="no-referrer"></iframe>
              </div>
            </div>
          </div>

          <div class="review-meta duplicate-review-meta" data-review-section="details-a">
            <p class="review-meta-heading">Údaje skupiny A</p>
            <div id="left-details" class="detail-list full-width"></div>
          </div>

          <div class="review-meta duplicate-review-meta" data-review-section="details-b">
            <p class="review-meta-heading">Údaje skupiny B</p>
            <div id="right-details" class="detail-list full-width"></div>
          </div>
        </div>

        <div class="help-answer-bar">
          <div class="help-controls">
            <button class="secondary" type="button" id="prev-pair" disabled>
              Předchozí pár
            </button>
            <button class="vote vote-up" type="button" id="mark-same" disabled>
              Sloučit skupiny
            </button>
            <button class="vote vote-down" type="button" id="mark-different" disabled>
              Ponechat skupiny zvlášť
            </button>
            <button class="secondary" type="button" id="skip-pair" disabled>
              Další pár
            </button>
          </div>

          <div class="help-answer-extra">
            <button class="linklike help-undo" type="button" id="undo-last" disabled>
              Zpět
            </button>
            <p class="helper" id="turnstile-note"></p>
          </div>

          <div class="form-status-wrap">
            <p class="form-status" id="review-status" role="status" aria-live="polite"></p>
          </div>

          <p class="help-shortcuts" aria-hidden="true">
            Klávesy: <kbd>A</kbd> sloučit · <kbd>N</kbd> ponechat zvlášť · <kbd>→</kbd> další pár · <kbd>←</kbd> předchozí
          </p>
        </div>

        <details class="workflow-help">
          <summary>Co hodnotím?</summary>
          <div class="workflow-help-body">
            <div class="workflow-help-item">
              <strong>Sloučit skupiny</strong>
              <span>Obě skupiny ukazují tutéž fotografii (její sken nebo ořez), nebo jde o záběry ze stejného focení.</span>
            </div>
            <div class="workflow-help-item">
              <strong>Ponechat skupiny zvlášť</strong>
              <span>Jde o jiné místo nebo jinou událost, případně o fotografie z různých focení.</span>
            </div>
            <div class="workflow-help-item">
              <strong>Další pár</strong>
              <span>Přeskočí nejistý pár bez uložení rozhodnutí.</span>
            </div>
          </div>
        </details>
      </section>
    </main>
  </div>
`;n();e(a,["./zoomify.js","./photo-meta.js","./grouping.js","./candidate-client.js","./media-filter.js","./session-verify.js","./dup-review.js","./mode-picker.js"]).catch(console.error);
