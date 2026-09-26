import{m as a}from"./loadLegacyScripts-CTEPpsh0.js";import{i as n,a as e}from"./leaflet-Dp5Exmga.js";import{i as o}from"./openseadragon-CWtobWd5.js";const i=`  <div class="page page-map">
    <header class="topbar">
      <div class="topbar-title">
        <h1>Staré fotografie Prahy</h1>
        <p class="subtitle">
          Mapa fotografií z Archivu hl. m. Prahy. Neoficiální komunitní projekt.
        </p>
      </div>
      <div class="topbar-actions">
        <button class="secondary" type="button" id="info-open">Jak mapa vznikla</button>
        <a class="action-link action-link-strong" href="./pomoc.html?mode=location">Chcete pomoct?</a>
      </div>
    </header>

    <main class="content">
      <div class="map-toolbar">
        <div class="search-container">
          <div class="search-input-row">
            <input type="text" id="map-search" placeholder="Hledat místo, fotografii nebo autora…"
              aria-label="Hledat místo, fotografii nebo autora" role="combobox" aria-autocomplete="list"
              aria-expanded="false" aria-controls="search-results" autocomplete="off" disabled />
          </div>
          <div id="search-filter" class="search-filter" hidden></div>
          <div id="search-results" class="search-results is-hidden" aria-label="Návrhy hledání"></div>
          <p id="search-link-status" class="search-link-status" role="status"></p>
          <div id="search-status" class="sr-only" role="status" aria-live="polite"></div>
        </div>
        <button class="filters-toggle" type="button" id="filters-toggle" aria-expanded="false"
          aria-controls="map-controls">
          Filtry
          <span class="filters-toggle-dot" id="filters-active" hidden></span>
        </button>
        <div class="topbar-meta" aria-live="polite">
          <div class="stat">
            <span class="stat-value" id="photo-count">—</span>
            <span class="stat-label">fotografií na mapě</span>
          </div>
          <div class="stat" hidden>
            <span class="stat-value" id="verified-count">—</span>
            <span class="stat-label">ověřeno komunitou</span>
          </div>
        </div>
        <div class="map-controls" id="map-controls" hidden>
          <div class="year-filter" aria-label="Filtr podle roku">
            <span class="year-filter-label">Rok</span>
            <div class="year-slider-wrap" id="year-slider-wrap">
              <div class="year-slider-track"></div>
              <input class="year-slider year-slider-min" type="range" id="year-min" min="0" max="0" step="1"
                aria-label="Rok od" />
              <input class="year-slider year-slider-max" type="range" id="year-max" min="0" max="0" step="1"
                aria-label="Rok do" />
            </div>
            <div class="year-filter-values">
              <output class="year-filter-value" id="year-min-value">—</output>
              <span class="year-filter-sep">–</span>
              <output class="year-filter-value" id="year-max-value">—</output>
            </div>
            <label class="year-filter-toggle">
              <input type="checkbox" id="year-unknown-toggle" checked />
              <span class="year-filter-toggle-text">
                Bez datace <span id="year-unknown-count">—</span>
              </span>
            </label>
            <label class="year-filter-toggle">
              <input type="checkbox" id="year-imprecise-toggle" checked />
              <span class="year-filter-toggle-text">
                Nepřesná datace <span id="year-imprecise-count">—</span>
              </span>
            </label>
          </div>
          <div class="cluster-toggle-wrap">
            <div class="cluster-toggle-container">
              <label class="toggle-switch">
                <input
                  type="checkbox"
                  id="cluster-toggle"
                  aria-expanded="false"
                  aria-controls="cluster-warning"
                  checked
                />
                <span class="toggle-slider"></span>
              </label>
              <span class="toggle-label">Seskupit body</span>
            </div>
            <div
              class="cluster-warning is-hidden"
              id="cluster-warning"
              role="group"
              aria-labelledby="cluster-warning-text"
            >
              <p id="cluster-warning-text">
                Zobrazení každého bodu zvlášť může mapu s mnoha fotografiemi zpomalit.
                Fotografie na přesně stejném místě zůstanou spolu.
              </p>
              <div class="cluster-warning-actions">
                <button type="button" class="secondary" id="cluster-warning-cancel">
                  Ponechat seskupení
                </button>
                <button type="button" class="primary" id="cluster-warning-continue">
                  Zobrazit jednotlivé body
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="map-layout">
        <section class="map-panel">
          <div id="map" aria-label="Mapa s polohami fotografií"></div>
          <div class="map-overlay">
            <div class="chip">Kliknutím otevřete fotografii</div>
          </div>
        </section>

        <section class="card photo-grid-section" aria-label="Galerie fotografií">
          <div class="photo-grid-head">
            <p class="eyebrow">Fotografie ve výřezu</p>
            <p class="helper photo-grid-count" id="photo-grid-count">—</p>
          </div>
          <div class="photo-grid" id="photo-grid"></div>
          <p class="helper photo-grid-empty is-hidden" id="photo-grid-empty">
            V tomto výřezu nejsou žádné fotografie.
          </p>
          <div class="photo-grid-actions">
            <button class="secondary" type="button" id="photo-grid-load-more">
              Načíst další
            </button>
          </div>
        </section>
      </div>
    </main>
  </div>

  <!-- Info Modal -->
  <div class="modal" id="info-modal" aria-hidden="true">
    <div class="modal-backdrop" data-info-close></div>
    <div class="modal-dialog info-dialog" role="dialog" aria-modal="true" aria-label="O projektu">
      <div class="modal-header">
        <div>
          <p class="modal-eyebrow">Informace</p>
          <h2 class="modal-title">Jak mapa vznikla</h2>
        </div>
        <button class="modal-close" type="button" data-info-close>
          Zavřít
        </button>
      </div>
      <div class="modal-body info-body">
        <div class="card info-card">
          <p class="how-lead">
            V mapě je zhruba 10&nbsp;000 fotografií z archivu. Část poloh jde určit podle adresy,
            u části jsme použili AI k odhadu místa z popisu. Proto potřebujeme lidskou kontrolu.
          </p>
          <div class="info-footer">
            <p>Tento projekt je komunitní a open-source. Data pocházejí z Archivu hlavního města Prahy.</p>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="modal" id="archive-modal" aria-hidden="true">
    <div class="modal-backdrop" data-modal-close></div>
    <div class="modal-dialog" role="dialog" aria-modal="true" aria-label="Archivní záznam">
      <div class="modal-header">
        <div>
          <!-- <p class="modal-eyebrow">Archivní záznam</p>
            <h2 class="modal-title">Náhled stránky</h2> -->
        </div>
        <button class="modal-close" type="button" data-modal-close>
          Zavřít
        </button>
      </div>
      <div class="modal-body">
        <div class="modal-frame">
          <div class="modal-main">
            <div class="zoom-wrap zoom-wrap-preview-fallback">
              <div id="zoom-viewer" class="zoom-viewer" aria-label="Náhled fotografie"></div>
              <img id="archive-preview" class="zoom-preview" alt="Náhled fotografie" loading="lazy" />
              <div
                id="archive-unavailable"
                class="zoom-unavailable"
                role="status"
                aria-live="polite"
              ></div>
              <iframe id="archive-iframe" title="Archivní záznam" loading="lazy" referrerpolicy="no-referrer"></iframe>
            </div>

            <aside class="modal-sidebar" id="modal-sidebar" aria-label="Detaily a opravy">
              <!-- Meta view -->
              <div class="modal-meta" id="modal-meta-view">
                <div class="modal-meta-head">
                  <p class="modal-meta-eyebrow">Detaily</p>
                  <h3 class="modal-meta-title">Fotografie</h3>
                </div>
                <div id="photo-details" class="detail-list"></div>
                <div class="photo-minimap is-hidden" id="photo-minimap-wrap">
                  <p class="detail-label">Poloha na mapě</p>
                  <div id="photo-minimap" aria-label="Mini mapa polohy fotografie"></div>
                </div>

              </div>

              <!-- Correction view -->
              <div class="modal-correction is-hidden" id="modal-photo-feedback-view">
                <div class="modal-meta-head">
                  <p class="modal-meta-eyebrow">Připomínka</p>
                  <h3 class="modal-meta-title">Poslat připomínku</h3>
                  <p class="helper">Nesedí popis nebo jste narazili na jiný problém? Napište nám.</p>
                </div>
                <form id="photo-feedback-form">
                  <label class="field" for="photo-feedback-message">
                    <span>Vaše připomínka</span>
                    <textarea id="photo-feedback-message" rows="5" minlength="5" maxlength="2000" required></textarea>
                  </label>
                  <label class="field" for="photo-feedback-email">
                    <span>E-mail (volitelné)</span>
                    <input id="photo-feedback-email" type="email" maxlength="254" autocomplete="email" />
                  </label>
                  <p class="helper">Připomínku uvidí pouze správce.</p>
                  <div class="form-actions">
                    <button class="primary" type="submit" disabled>Odeslat připomínku</button>
                    <button class="secondary" type="button" id="cancel-photo-feedback">Zpět</button>
                  </div>
                  <p class="form-status" id="photo-feedback-status" role="status" aria-live="polite"></p>
                </form>
              </div>

              <!-- Correction view -->
              <div class="modal-correction is-hidden" id="modal-correction-view">
                <div class="modal-meta-head">
                  <p class="modal-meta-eyebrow">Oprava polohy</p>
                  <h3 class="modal-meta-title">Zadejte správné místo</h3>
                  <p class="helper scope-hint is-hidden" id="correction-scope-hint"></p>
                </div>

                <form id="feedback-form" class="is-open"> <!-- form stays open in its container -->
                  <input type="hidden" name="issue" value="wrong_location" />
                  <input type="hidden" name="correction_lat" />
                  <input type="hidden" name="correction_lon" />

                  <div class="correction-picker">
                    <p class="helper">Přesuňte špendlík na správné místo.</p>
                    <div id="correction-map" aria-label="Mapa pro opravu polohy"></div>
                  </div>

                  <label class="field">
                    <span>Poznámka</span>
                    <textarea name="message" rows="2" placeholder="Např. nároží, směr záběru…"></textarea>
                  </label>

                  <label class="field">
                    <span>E-mail (volitelné)</span>
                    <input name="email" type="email" autocomplete="email" placeholder="vy@priklad.cz"
                      aria-describedby="correction-email-privacy" />
                  </label>
                  <p class="helper field-privacy" id="correction-email-privacy">
                    E-mail uložíme spolu s hlášením a použijeme ho jen pro případné upřesnění tohoto hlášení.
                    Veřejně ho nezobrazujeme a tento web si ho neuloží pro příští hlášení.
                  </p>

                  <div class="turnstile-wrap">
                    <p class="helper" id="turnstile-note"></p>
                  </div>

                  <div class="form-actions">
                    <button type="submit" class="primary" disabled>
                      Uložit polohu
                    </button>
                    <button type="button" class="secondary" id="cancel-correction">
                      Zrušit
                    </button>
                  </div>
                  <p class="helper" id="correction-point-hint">Nejdřív vyberte správné místo na mapě.</p>
                  <p class="form-status" id="form-status" role="status" aria-live="polite"></p>
                </form>
              </div>
            </aside>
          </div>
          <div class="modal-footer">
            <div class="modal-nearby-nav">
              <button class="secondary modal-nearby-btn" type="button" id="nearby-prev">
                Předchozí v okolí
              </button>
              <span class="helper modal-nearby-state" id="nearby-state">—</span>
              <button class="secondary modal-nearby-btn" type="button" id="nearby-next">
                Další v okolí
              </button>
            </div>
            <div class="report-cta-container modal-footer-feedback">
              <div class="consensus-banner is-hidden" id="consensus-banner">
                <p class="helper consensus-text" id="consensus-text"></p>
                <div class="consensus-actions">
                  <button class="secondary" type="button" id="confirm-cta">
                    Zkontrolovat návrh
                  </button>
                </div>
              </div>

              <div class="report-cta" id="report-cta-container">
                <div class="report-meta">
                  <p class="report-eyebrow">Zpětná vazba</p>
                  <h2 class="report-title">Je poloha špatně?</h2>
                </div>
                <div class="report-actions">
                  <button class="primary report-button" type="button" id="report-cta">
                    Opravit polohu
                  </button>
                  <button class="secondary report-button report-flag-button" type="button" id="report-flag">
                    Nesedí, ale nevím, kde to je
                  </button>
                  <button class="secondary report-button" type="button" id="photo-feedback-cta">
                    Poslat připomínku
                  </button>
                </div>
              </div>
            </div>
            <div class="modal-footer-right">
              <div class="modal-footer-actions">
                <button class="secondary" type="button" id="download-fullres" disabled>
                  Stáhnout plné rozlišení
                </button>
                <a id="archive-fallback" href="#" target="_blank" rel="noopener">
                  Otevřít v archivu
                </a>
              </div>
              <p class="helper modal-download-status" id="download-fullres-status" role="status" aria-live="polite"></p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
`;async function t(){n(),o(),await e(),await a(i,["./zoomify.js","./photo-meta.js","./grouping.js","./media-filter.js","./session-verify.js","./own-proposals.js","./correction-ui.js","./feedback-ui.js","./search-ui.js","./app.js"])}t().catch(console.error);
