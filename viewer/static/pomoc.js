const MAPY_CZ_API_KEY = "JToxKFIPuYBZVmm3P8Kjujtg4wUEhzeP3TIBNcKxRV0";

const state = {
  map: null,
  originalMarker: null,
  proposedMarker: null,
  mode: null, // null | "ok" | "wrong"
  remainingCloud: 0,
  archiveBaseUrl: "https://katalog.ahmp.cz/pragapublica",
  features: [],
  remaining: [],
  history: [],
  voted: {}, // xid -> "ok" | "wrong"
  current: null,
  proposed: null,
};

const iframe = document.getElementById("help-iframe");
const zoomWrap = iframe?.closest(".zoom-wrap");
const zoomViewerEl = document.getElementById("help-zoom");
const remainingEl = document.getElementById("remaining-count");
const currentXidEl = document.getElementById("current-xid");
const detailsEl = document.getElementById("help-details");
const voteUpBtn = document.getElementById("vote-up");
const voteDownBtn = document.getElementById("vote-down");
const skipBtn = document.getElementById("skip-photo");
const prevBtn = document.getElementById("prev-photo");

const pragueFallback = [50.0755, 14.4378];

let zoomViewer = null;
let zoomLastXid = null;

function setStatus(message, tone = "") {
  formStatus.textContent = message;
  formStatus.dataset.tone = tone;
}

function clearStatus() {
  formStatus.textContent = "";
  formStatus.dataset.tone = "";
}

function updateCounts() {
  if (remainingEl) {
    remainingEl.textContent = state.remaining.length
      ? state.remaining.length.toLocaleString()
      : "—";
  }
  currentXidEl.textContent = state.current?.properties?.id || "—";
  if (prevBtn) {
    prevBtn.disabled = state.history.length === 0;
  }
}

async function refreshRemainingCloud() {
  try {
    const corrections = await fetchJson("/api/corrections");
    const done = new Set(
      (corrections.items || [])
        .filter((item) => item?.xid && (item?.has_coordinates || item?.verdict === "ok"))
        .map((item) => item.xid)
    );

    // Update local remaining pool while keeping out things already done by others
    state.remaining = state.features.filter((f) => !done.has(f.properties.id));
    updateCounts();
  } catch (err) {
    console.warn("Refresh counteru selhal", err);
  }
}

function updateSubmitState() {
  const isWrong = state.mode === "wrong";
  const hasToken = !!(state.turnstileToken || state.turnstileBypass);
  const hasProposed = !!state.proposed;

  if (submitCorrectionBtn) {
    submitCorrectionBtn.disabled = !isWrong || !hasProposed || !hasToken;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Požadavek selhal: ${response.status}`);
  return response.json();
}

async function loadZoomifyMeta(xid) {
  const url = `/api/zoomify?xid=${encodeURIComponent(xid)}`;
  return fetchJson(url);
}

async function loadZoomifyInto(xid) {
  if (!zoomViewerEl || !zoomWrap) return;
  if (zoomLastXid === xid) return;
  zoomLastXid = xid;
  zoomWrap.classList.remove("is-fallback");

  try {
    if (!window.OpenSeadragon) {
      throw new Error("OpenSeadragon chybí");
    }

    const meta = await loadZoomifyMeta(xid);

    if (!zoomViewer) {
      zoomViewer = window.OpenSeadragon({
        element: zoomViewerEl,
        prefixUrl:
          "https://unpkg.com/openseadragon@4.1.1/build/openseadragon/images/",
        showNavigator: true,
        maxZoomPixelRatio: 2,
      });
    }

    if (!window.OldPragueZoomify?.createTileSource) {
      throw new Error("Chybí helper pro Zoomify");
    }
    zoomViewer.open(window.OldPragueZoomify.createTileSource(meta));
  } catch (error) {
    console.warn("Zoom náhled selhal", error);
    zoomWrap.classList.add("is-fallback");
  }
}

function getArchiveUrl(xid) {
  return `${state.archiveBaseUrl.replace(/\/$/, "")}/permalink?xid=${xid}&scan=1#scan1`;
}

function initMap() {
  state.map = L.map("help-map", {
    zoomControl: true,
    scrollWheelZoom: true,
  }).setView(pragueFallback, 13);

  const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> přispěvatelé';
  const mapyAttr = '&copy; <a href="https://www.mapy.cz">Mapy.cz</a>';

  if (MAPY_CZ_API_KEY) {
    const mapyLayer = L.tileLayer(`https://api.mapy.cz/v1/maptiles/basic/256/{z}/{x}/{y}?apikey=${MAPY_CZ_API_KEY}`, {
      maxZoom: 19,
      attribution: `${mapyAttr}, ${osmAttr}`
    });
    mapyLayer.addTo(state.map);

    let fallbackActive = false;
    mapyLayer.on('tileerror', () => {
      if (fallbackActive) return;
      fallbackActive = true;
      console.warn("Mapy.cz tiles failed, falling back to OSM");
      state.map.removeLayer(mapyLayer);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: osmAttr,
      }).addTo(state.map);
    });
  } else {
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: osmAttr,
    }).addTo(state.map);
  }
}

function showFeature(feature) {
  state.current = feature;
  state.proposed = null;
  state.mode = null;
  clearStatus();
  updateCounts();
  updateSubmitState();

  if (window.OldPragueMeta?.renderDetails) {
    window.OldPragueMeta.renderDetails(detailsEl, feature, state.archiveBaseUrl);
  }

  if (window.OldPragueMeta?.renderDetails) {
    window.OldPragueMeta.renderDetails(detailsEl, feature, state.archiveBaseUrl);
  }

  if (correctionView) correctionView.classList.add("is-hidden");

  // Reflect previous vote state
  const xid = feature.properties.id;
  const prevVote = state.voted[xid];
  voteUpBtn.classList.toggle("is-voted", prevVote === "ok");
  voteDownBtn.classList.toggle("is-voted", prevVote === "wrong");

  const url = getArchiveUrl(xid);
  iframe.src = url;
  if (zoomLastXid !== xid) {
    loadZoomifyInto(xid);
  }

  const [lon, lat] = feature.geometry.coordinates;
  const point = [lat, lon];

  if (!state.originalMarker) {
    state.originalMarker = L.circleMarker(point, {
      radius: 10,
      weight: 2,
      color: "#2b6e78",
      fillColor: "#2b6e78",
      fillOpacity: 0.25,
    }).addTo(state.map);
  } else {
    state.originalMarker.setLatLng(point);
  }

  if (state.proposedMarker) {
    state.map.removeLayer(state.proposedMarker);
    state.proposedMarker = null;
  }

  state.map.setView(point, Math.max(state.map.getZoom(), 15), { animate: true });
}

function setMode(mode) {
  console.log("setMode:", mode);
  state.mode = mode;
  clearStatus();

  const xid = state.current?.properties?.id;
  if (xid) {
    state.voted[xid] = mode;
  }

  // Update button visuals
  voteUpBtn.classList.toggle("is-voted", mode === "ok");
  voteDownBtn.classList.toggle("is-voted", mode === "wrong");

  // For "ok", submit immediately and auto-advance
  if (mode === "ok") {
    console.log("Calling submitOk directly from setMode");
    submitOk();
    return;
  }

  // For "wrong", show the form
  if (!correctionView) return;

  correctionView.classList.remove("is-hidden");
  CorrectionUI.open(state.current, {
    turnstileSiteKey: state.turnstileSiteKey,
    turnstileBypass: state.turnstileBypass,
    onSuccess: () => {
      setTimeout(() => {
        if (correctionView) correctionView.classList.add("is-hidden");
        pickRandom();
      }, 1500);
    },
    onCancel: () => {
      if (correctionView) correctionView.classList.add("is-hidden");
      voteDownBtn.classList.remove("is-voted");
      state.mode = null;
    }
  });
}

async function pickRandom() {
  // Optional: Refresh count from server to see other people's progress
  // We don't await so UI doesn't lag
  refreshRemainingCloud();

  if (!state.remaining.length) {
    state.remaining = [...state.features];
  }

  const idx = Math.floor(Math.random() * state.remaining.length);
  const feature = state.remaining.splice(idx, 1)[0];

  if (state.current) {
    state.history.push(state.current);
  }

  showFeature(feature);
}

function pickPrev() {
  if (state.history.length === 0) return;
  const prevFeature = state.history.pop();

  // Put current back to remaining if it's not the one we just popped
  if (state.current) {
    state.remaining.push(state.current);
  }

  showFeature(prevFeature);
}

function renderTurnstile() {
  if (state.turnstileBypass) {
    if (turnstileNote) turnstileNote.textContent = "Turnstile je vypnutý pro lokální vývoj.";
    updateSubmitState();
    return;
  }

  if (!state.turnstileReady || !state.turnstileSiteKey) {
    if (!state.turnstileSiteKey) {
      if (turnstileNote) turnstileNote.textContent = "Chybí Turnstile klíč.";
    }
    return;
  }

  if (state.turnstileWidgetId !== null) return;

  state.turnstileWidgetId = window.turnstile.render("#turnstile", {
    sitekey: state.turnstileSiteKey,
    callback: (token) => {
      state.turnstileToken = token;
      updateSubmitState();
    },
    "expired-callback": () => {
      state.turnstileToken = "";
      updateSubmitState();
    },
    "error-callback": () => {
      state.turnstileToken = "";
      updateSubmitState();
    },
  });
}

window.turnstileOnload = () => {
  state.turnstileReady = true;
  renderTurnstile();
};

async function submitCorrection() {
  if (!state.current || state.mode !== "wrong" || !state.proposed) return;

  clearStatus();

  if (!state.turnstileToken && !state.turnstileBypass) {
    setStatus("Dokončete Turnstile kontrolu.", "error");
    return;
  }

  const payload = {
    xid: state.current.properties.id,
    lat: state.proposed.lat,
    lon: state.proposed.lon,
    verdict: "wrong",
    message: (messageEl?.value || "").trim() || "Nahlášena špatná poloha.",
    email: (emailEl?.value || "").trim() || null,
    token: state.turnstileToken || "",
  };

  submitCorrectionBtn.disabled = true;

  try {
    const response = await fetch("/api/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Odeslání selhalo");
    }

    setStatus("Díky! Uloženo. Jdeme na další.", "success");
    state.turnstileToken = "";
    if (state.turnstileWidgetId !== null && window.turnstile) {
      window.turnstile.reset(state.turnstileWidgetId);
    }
    setTimeout(() => pickRandom(), 400);
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
    updateSubmitState();
  }
}

async function submitOk() {
  console.log("submitOk started, state:", { xid: state.current?.properties?.id, mode: state.mode, bypass: state.turnstileBypass });
  if (!state.current || state.mode !== "ok") return;

  clearStatus();

  if (!state.turnstileToken && !state.turnstileBypass) {
    console.warn("Blocked by Turnstile: token missing and bypass is false");
    setStatus("Dokončete Turnstile kontrolu.", "error");
    if (helpForm) helpForm.classList.remove("is-hidden");
    return;
  }

  const payload = {
    xid: state.current.properties.id,
    verdict: "ok",
    message: "Poloha potvrzena jako OK.",
    token: state.turnstileToken || "",
  };

  console.log("Submitting OK payload:", payload);
  submitOkBtn.disabled = true;

  try {
    const response = await fetch("/api/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Odeslání selhalo");
    }

    setStatus("Díky! Potvrzeno. Jdeme na další.", "success");
    state.turnstileToken = "";
    if (state.turnstileWidgetId !== null && window.turnstile) {
      window.turnstile.reset(state.turnstileWidgetId);
    }
    setTimeout(() => pickRandom(), 400);
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
    updateSubmitState();
  }
}

async function bootstrap() {
  const config = await fetchJson("/api/config").catch(() => ({}));
  state.turnstileSiteKey = config.turnstileSiteKey || "";
  state.turnstileBypass = Boolean(config.turnstileBypass);
  state.archiveBaseUrl = config.archiveBaseUrl || state.archiveBaseUrl;

  initMap();
  CorrectionUI.init("shared-correction-map");
  CorrectionUI.setTurnstileBypass(state.turnstileBypass);
  renderTurnstile();

  const photos = await fetchJson("/data/photos.geojson");
  state.features = photos.features || [];

  await refreshRemainingCloud();

  pickRandom();
}

/* removed submitOkBtn listener */
const correctionSubmitBtn = document.getElementById("correction-submit-btn");
if (correctionSubmitBtn) {
  correctionSubmitBtn.addEventListener("click", () => CorrectionUI.submit());
}

const correctionCancelBtnShared = document.getElementById("correction-cancel-btn");
if (correctionCancelBtnShared) {
  correctionCancelBtnShared.addEventListener("click", () => CorrectionUI.cancel());
}
skipBtn.addEventListener("click", () => pickRandom());
if (prevBtn) prevBtn.addEventListener("click", () => pickPrev());
voteUpBtn.addEventListener("click", () => setMode("ok"));
voteDownBtn.addEventListener("click", () => setMode("wrong"));

bootstrap().catch((error) => {
  setStatus("Nepodařilo se načíst data.", "error");
  console.error(error);
});
