import{u as n,j as a,c as e}from"./useLegacyScripts-BniyuhKt.js";const o=`  <div class="page">
    <header class="topbar">
      <div>
        <p class="eyebrow">Pomoc s opravami</p>
        <h1>Pomoc s opravami</h1>
        <p class="subtitle">
          Vyberte, jestli chcete opravovat polohu, kontrolovat podobné záběry, nebo projít skupiny podle metadata.
        </p>
        <div class="topbar-actions">
          <a class="action-link" href="./index.html">Zpět na mapu</a>
        </div>
      </div>
      <div class="topbar-meta">
        <div class="stat">
          <span class="stat-label">Zbývá ke kontrole</span>
          <span class="stat-value" id="remaining-count">—</span>
        </div>
        <div class="stat">
          <span class="stat-label">Skupina</span>
          <span class="stat-value" id="current-xid">—</span>
        </div>
      </div>
    </header>

    <main class="help">
      <section class="card help-mode" data-mode-picker>
        <div>
          <p class="eyebrow">Vyberte režim</p>
          <h2>Jak chcete pomoct?</h2>
          <p class="helper">
            Opravy polohy, kontrola podobných záběrů i revize skupin pomáhají zpřesnit mapu historických fotografií.
          </p>
        </div>
        <div class="help-mode-actions">
          <a class="primary report-button" href="./pomoc.html?mode=location" data-mode-select="location"
            aria-current="page">Oprava polohy</a>
          <a class="secondary report-button" href="./dup-review.html?mode=dedupe">Kontrola podobných záběrů</a>
          <a class="secondary report-button" href="./group-review.html">Kontrola skupin</a>
        </div>
      </section>

      <section class="card help-card is-hidden" data-mode-flow="location">
        <div class="help-controls">
          <button class="secondary" type="button" id="prev-photo" disabled>
            Předchozí fotka
          </button>
          <button class="vote vote-up" type="button" id="vote-up">
            👍 Sedí
          </button>
          <button class="vote vote-down" type="button" id="vote-down">
            👎 Nesedí
          </button>
          <button class="secondary" type="button" id="skip-photo">
            Další fotka
          </button>
        </div>

        <div class="help-grid">
          <div class="help-preview">
            <div class="preview-frame">
              <div class="zoom-wrap">
                <div id="help-zoom" class="zoom-viewer" aria-label="Náhled fotografie"></div>
                <iframe id="help-iframe" title="Archivní záznam" loading="lazy" referrerpolicy="no-referrer"></iframe>
              </div>
            </div>
          </div>

          <div class="help-map">
            <div id="help-map" aria-label="Mapa pro opravu polohy"></div>
          </div>
        </div>

        <div class="help-meta-wrap" aria-label="Detaily fotografie">
          <div id="help-details" class="detail-list full-width"></div>
        </div>

        <div class="form-status-wrap">
          <p class="form-status" id="form-status"></p>
        </div>

      </section>
    </main>
  </div>

  <div class="modal" id="help-correction-modal" aria-hidden="true">
    <div class="modal-backdrop" data-help-close></div>
    <div class="modal-dialog modal-compact" role="dialog" aria-modal="true" aria-label="Oprava polohy">
      <div class="modal-header">
        <div>
          <p class="modal-eyebrow">Oprava polohy</p>
          <h2 class="modal-title">Doplňte poznámku</h2>
        </div>
        <button class="modal-close" type="button" data-help-close>
          Zavřít
        </button>
      </div>
      <div class="modal-body">
        <div class="help-form is-hidden" id="help-form">
          <div class="card help-down">
            <p class="helper" id="help-map-note">Klikněte do mapy na správné místo. Pak odešlete opravu.</p>
            <label class="field">
              <span>Poznámka (volitelné)</span>
              <textarea id="help-message" rows="3" placeholder="Např. správná ulice, orientační bod..."></textarea>
            </label>
            <label class="field">
              <span>E-mail (volitelné, přihlášení k newsletteru)</span>
              <input id="help-email" type="email" placeholder="vy@priklad.cz" />
            </label>
          </div>
          <p class="helper" id="turnstile-note"></p>
          <div class="help-submit">
            <button class="secondary help-secondary" type="button" id="cancel-correction">
              Zrušit
            </button>
            <button class="secondary help-secondary" type="button" id="submit-flag">
              Nevím kde přesně
            </button>
            <button class="primary help-primary is-hidden" type="button" id="submit-correction" disabled>
              Uložit opravu
            </button>
          </div>
          <p class="form-status" id="modal-status"></p>
        </div>
      </div>
    </div>
  </div>

`,s=["https://unpkg.com/leaflet@1.9.4/dist/leaflet.js","https://unpkg.com/openseadragon@4.1.1/build/openseadragon/openseadragon.min.js","./zoomify.js","./photo-meta.js","./grouping.js","./media-filter.js","./session-verify.js","./correction-ui.js","./pomoc.js","./mode-picker.js"];function t(){return n(s),a.jsx("div",{dangerouslySetInnerHTML:{__html:o}})}e(document.getElementById("root")).render(a.jsx(t,{}));
