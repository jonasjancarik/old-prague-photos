(() => {
  const state = {
    configPromise: null,
    scriptPromise: null,
    modalEl: null,
    statusEl: null,
    continueBtn: null,
    widgetEl: null,
    widgetId: null,
    token: "",
    pendingResolve: null,
    pendingReject: null,
  };

  function createError(message, response = null) {
    const error = new Error(message || "Požadavek selhal");
    error.detail = message || "";
    error.response = response;
    return error;
  }

  async function fetchConfig() {
    if (state.configPromise) return state.configPromise;
    state.configPromise = fetch("/api/config")
      .then((response) => (response.ok ? response.json() : {}))
      .catch(() => ({}));
    return state.configPromise;
  }

  async function parseResponseDetail(response) {
    try {
      const payload = await response.clone().json();
      if (payload && typeof payload.detail === "string") {
        return payload.detail;
      }
    } catch (error) {
      // ignore JSON parse failures
    }
    try {
      const text = await response.clone().text();
      return String(text || "").trim();
    } catch (error) {
      return "";
    }
  }

  function setStatus(message, tone = "") {
    if (!state.statusEl) return;
    state.statusEl.textContent = message;
    state.statusEl.dataset.tone = tone;
  }

  function closeModal() {
    if (!state.modalEl) return;
    state.modalEl.classList.remove("is-open");
    state.modalEl.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  function rejectPending(error) {
    if (!state.pendingReject) return;
    state.pendingReject(error);
    state.pendingResolve = null;
    state.pendingReject = null;
  }

  function resolvePending(value) {
    if (!state.pendingResolve) return;
    state.pendingResolve(value);
    state.pendingResolve = null;
    state.pendingReject = null;
  }

  async function ensureTurnstileScript() {
    if (window.turnstile) return;
    if (state.scriptPromise) {
      await state.scriptPromise;
      return;
    }
    state.scriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(
        'script[src*="challenges.cloudflare.com/turnstile"]',
      );
      if (existing) {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          if (window.turnstile) {
            clearInterval(timer);
            resolve();
            return;
          }
          if (Date.now() - startedAt > 10000) {
            clearInterval(timer);
            reject(createError("Turnstile se nepodařilo načíst"));
          }
        }, 120);
        return;
      }

      const script = document.createElement("script");
      script.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(createError("Turnstile se nepodařilo načíst"));
      document.head.appendChild(script);
    });
    await state.scriptPromise;
  }

  function ensureModal() {
    if (state.modalEl) return;
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.id = "session-verify-modal";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-dialog modal-compact" role="dialog" aria-modal="true" aria-label="Ověření">
        <div class="modal-header">
          <div>
            <p class="modal-eyebrow">Ověření</p>
            <h2 class="modal-title">Než pokračujete</h2>
          </div>
        </div>
        <div class="modal-body verify-body">
          <p class="helper">Potvrďte, že nejste robot. Ověření platí pro relaci.</p>
          <div class="turnstile-wrap">
            <div id="session-verify-turnstile"></div>
            <p class="helper" id="session-verify-status">Dokončete ověření.</p>
          </div>
          <div class="verify-actions">
            <button class="primary" type="button" id="session-verify-continue" disabled>
              Pokračovat
            </button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    state.modalEl = modal;
    state.statusEl = modal.querySelector("#session-verify-status");
    state.continueBtn = modal.querySelector("#session-verify-continue");
    state.widgetEl = modal.querySelector("#session-verify-turnstile");

    state.continueBtn?.addEventListener("click", async () => {
      if (!state.token) {
        setStatus("Dokončete Turnstile kontrolu.", "error");
        return;
      }
      if (state.continueBtn) state.continueBtn.disabled = true;
      setStatus("Ověřuji...", "");
      try {
        const response = await fetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ token: state.token }),
        });
        if (!response.ok) {
          const detail = (await parseResponseDetail(response)) || "Ověření selhalo";
          throw createError(detail, response);
        }
        state.token = "";
        if (state.widgetId !== null && window.turnstile) {
          window.turnstile.reset(state.widgetId);
        }
        closeModal();
        resolvePending(true);
      } catch (error) {
        const message =
          typeof error?.message === "string" && error.message
            ? error.message
            : "Ověření selhalo";
        setStatus(message, "error");
        if (state.continueBtn) state.continueBtn.disabled = false;
      }
    });
  }

  function openModal() {
    ensureModal();
    if (!state.modalEl) return;
    state.modalEl.classList.add("is-open");
    state.modalEl.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  async function renderWidget(siteKey) {
    await ensureTurnstileScript();
    ensureModal();
    if (!window.turnstile || !state.widgetEl) {
      throw createError("Turnstile není dostupný");
    }
    if (!siteKey) {
      throw createError("Chybí Turnstile klíč.");
    }

    if (state.widgetId === null) {
      state.widgetId = window.turnstile.render(state.widgetEl, {
        sitekey: siteKey,
        action: "session_verify",
        callback: (token) => {
          state.token = token;
          if (state.continueBtn) state.continueBtn.disabled = false;
          setStatus("Ověření připraveno. Pokračujte.", "success");
        },
        "expired-callback": () => {
          state.token = "";
          if (state.continueBtn) state.continueBtn.disabled = true;
          setStatus("Ověření vypršelo, zkuste to znovu.", "error");
        },
        "error-callback": () => {
          state.token = "";
          if (state.continueBtn) state.continueBtn.disabled = true;
          setStatus("Ověření selhalo, zkuste to znovu.", "error");
        },
      });
      return;
    }
    window.turnstile.reset(state.widgetId);
    state.token = "";
    if (state.continueBtn) state.continueBtn.disabled = true;
    setStatus("Dokončete ověření.", "");
  }

  async function ensureSession() {
    const config = await fetchConfig();
    if (config.turnstileBypass) {
      return true;
    }
    const siteKey = String(config.turnstileSiteKey || "").trim();
    if (!siteKey) {
      throw createError("Chybí Turnstile klíč.");
    }
    if (state.pendingResolve) {
      return new Promise((resolve, reject) => {
        const prevResolve = state.pendingResolve;
        const prevReject = state.pendingReject;
        state.pendingResolve = (value) => {
          prevResolve(value);
          resolve(value);
        };
        state.pendingReject = (error) => {
          prevReject(error);
          reject(error);
        };
      });
    }

    openModal();
    if (state.continueBtn) state.continueBtn.disabled = true;
    setStatus("Načítám ověření...", "");
    await renderWidget(siteKey);

    return new Promise((resolve, reject) => {
      state.pendingResolve = resolve;
      state.pendingReject = reject;
    });
  }

  async function submitWithSessionRetry(sendRequest) {
    let retried = false;
    while (true) {
      const response = await sendRequest();
      if (response.ok) return response;
      const detail = await parseResponseDetail(response);
      if (!retried && detail === "Turnstile je povinný") {
        retried = true;
        await ensureSession();
        continue;
      }
      throw createError(detail || "Odeslání selhalo", response);
    }
  }

  window.OldPragueSession = {
    ensureSession,
    submitWithSessionRetry,
  };

  window.addEventListener("beforeunload", () => {
    rejectPending(createError("Ověření bylo přerušeno"));
  });
})();
