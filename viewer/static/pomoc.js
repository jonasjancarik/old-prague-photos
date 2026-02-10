// MAPY_CZ_API_KEY is defined in correction-ui.js

const state = {
  map: null,
  originalMarker: null,
  proposedMarker: null,
  mode: null, // null | "ok" | "wrong"
  archiveBaseUrl: "https://katalog.ahmp.cz/pragapublica",
  features: [],
  groups: [],
  groupByXid: new Map(),
  remaining: [],
  history: [],
  voted: {}, // group_id -> "ok" | "wrong"
  currentGroup: null,
  currentFeature: null,
  proposed: null,
};

const iframe = document.getElementById("help-iframe");
const zoomWrap = iframe?.closest(".zoom-wrap");
const zoomViewerEl = document.getElementById("help-zoom");
const remainingEl = document.getElementById("remaining-count");
const currentXidEl = document.getElementById("current-xid");
const detailsEl = document.getElementById("help-details");
const submitCorrectionBtn = document.getElementById("submit-correction");
const submitFlagBtn = document.getElementById("submit-flag");
const cancelCorrectionBtn = document.getElementById("cancel-correction");
const prevBtn = document.getElementById("prev-photo");
const skipBtn = document.getElementById("skip-photo");
const voteUpBtn = document.getElementById("vote-up");
const voteDownBtn = document.getElementById("vote-down");
const helpForm = document.getElementById("help-form");
const helpCorrectionModal = document.getElementById("help-correction-modal");
const helpMapNote = document.getElementById("help-map-note");
const messageEl = document.getElementById("help-message");
const emailEl = document.getElementById("help-email");
const formStatus = document.getElementById("form-status");
const modalStatus = document.getElementById("modal-status");
const turnstileNote = document.getElementById("turnstile-note");

const pragueFallback = [50.0755, 14.4378];
const EMAIL_STORAGE_KEY = "old-prague-help-email";
const REVIEW_STATE_REFRESH_INTERVAL_MS = 45_000;
const REVIEW_STATE_REFRESH_MIN_GAP_MS = 8_000;

let dataReady = false;
let flowStarted = false;
let reviewStateRefreshInFlight = false;
let reviewStateLastRefreshAt = 0;
let reviewStateRefreshTimer = null;

let zoomViewer = null;
let zoomLastXid = null;

function handleModeActivated(mode) {
  if (mode !== "location") return;
  if (state.map) state.map.invalidateSize();
  if (zoomViewer && typeof zoomViewer.updateSize === "function") {
    zoomViewer.updateSize();
  }
}

window.addEventListener("old-prague-mode", (event) => {
  handleModeActivated(event.detail?.mode || "");
});

function setStatus(message, tone = "") {
  [formStatus, modalStatus].forEach((el) => {
    if (!el) return;
    el.textContent = message;
    el.dataset.tone = tone;
  });
}

function clearStatus() {
  [formStatus, modalStatus].forEach((el) => {
    if (!el) return;
    el.textContent = "";
    el.dataset.tone = "";
  });
}

function setVerificationNote(message, tone = "") {
  if (!turnstileNote) return;
  turnstileNote.textContent = message;
  turnstileNote.dataset.tone = tone;
}

function setControlsEnabled(enabled) {
  [voteUpBtn, voteDownBtn, skipBtn, prevBtn].forEach((btn) => {
    if (!btn) return;
    btn.disabled = !enabled;
  });
  if (!enabled && submitCorrectionBtn) {
    submitCorrectionBtn.disabled = true;
  }
  if (!enabled && submitFlagBtn) {
    submitFlagBtn.disabled = true;
  }
}

function openCorrectionModal() {
  if (!helpCorrectionModal) return;
  helpCorrectionModal.classList.add("is-open");
  helpCorrectionModal.setAttribute("aria-hidden", "false");
  if (helpForm) helpForm.classList.remove("is-hidden");
  document.body.style.overflow = "hidden";
}

function closeCorrectionModal() {
  if (!helpCorrectionModal) return;
  helpCorrectionModal.classList.remove("is-open");
  helpCorrectionModal.setAttribute("aria-hidden", "true");
  if (helpForm) helpForm.classList.add("is-hidden");
  document.body.style.overflow = "";
}

function cancelCorrection() {
  state.mode = null;
  closeCorrectionModal();
  clearStatus();
  if (voteDownBtn) voteDownBtn.classList.remove("is-voted");
  if (state.proposedMarker) {
    state.map.removeLayer(state.proposedMarker);
    state.proposedMarker = null;
  }
  state.proposed = null;
  updateSubmitState();
}

function maybeStartFlow() {
  if (!dataReady || flowStarted) return;
  flowStarted = true;
  setControlsEnabled(true);
  startReviewStatePolling();
  refreshRemainingCloud({ force: true });
  pickRandom();
}

function loadSavedEmail() {
  const saved = localStorage.getItem(EMAIL_STORAGE_KEY);
  if (saved) {
    if (emailEl) emailEl.value = saved;
  }
}

function updateCounts() {
  if (remainingEl) {
    remainingEl.textContent = state.remaining.length
      ? state.remaining.length.toLocaleString()
      : "—";
  }
  const groupId = state.currentGroup?.id || "";
  if (currentXidEl) {
    if (groupId) {
      const shortId = `${groupId.slice(0, 6)}...${groupId.slice(-4)}`;
      currentXidEl.textContent = shortId;
      currentXidEl.title = groupId;
    } else {
      currentXidEl.textContent = "—";
      currentXidEl.title = "";
    }
  }
  if (prevBtn) {
    prevBtn.disabled = state.history.length === 0;
  }
}

function startReviewStatePolling() {
  if (reviewStateRefreshTimer !== null) return;
  reviewStateRefreshTimer = window.setInterval(() => {
    refreshRemainingCloud();
  }, REVIEW_STATE_REFRESH_INTERVAL_MS);
}

async function refreshRemainingCloud(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();
  if (!force) {
    if (reviewStateRefreshInFlight) return;
    if (reviewStateLastRefreshAt > 0 && now - reviewStateLastRefreshAt < REVIEW_STATE_REFRESH_MIN_GAP_MS) {
      return;
    }
  }

  reviewStateRefreshInFlight = true;
  try {
    const reviewState = await fetchJson("/api/review-state");
    const done = applyReviewStateToFeatures(state.features, reviewState);

    // Update local remaining pool while keeping out things already done by others
    state.remaining = state.groups.filter((group) => !done.has(group.id));
    updateCounts();
    reviewStateLastRefreshAt = Date.now();
  } catch (err) {
    console.warn("Refresh counteru selhal", err);
  } finally {
    reviewStateRefreshInFlight = false;
  }
}

function updateSubmitState() {
  const isWrong = state.mode === "wrong";
  const hasProposed = !!state.proposed;

  if (submitCorrectionBtn) {
    submitCorrectionBtn.disabled = !isWrong || !hasProposed;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Požadavek selhal: ${response.status}`);
  return response.json();
}

function applyReviewStateToFeatures(features, reviewState) {
  const grouping = window.OldPragueGrouping;
  const applied = grouping.applyReviewState(features, reviewState || {});
  return applied.doneGroupIds || new Set();
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
      window.OldPragueZoomify?.styleControls?.(zoomViewer);
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

  state.map.on("click", (event) => {
    if (state.mode !== "wrong") return;
    const { lat, lng } = event.latlng;
    state.proposed = { lat: Number(lat.toFixed(6)), lon: Number(lng.toFixed(6)) };
    if (!state.proposedMarker) {
      state.proposedMarker = L.marker([lat, lng]).addTo(state.map);
    } else {
      state.proposedMarker.setLatLng([lat, lng]);
    }
    if (helpMapNote) {
      helpMapNote.textContent = "Poloha vybrána. Doplňte poznámku a odešlete.";
    }
    updateSubmitState();
    openCorrectionModal();
  });
}

function setCurrentFeature(feature) {
  if (!feature) return;
  state.currentFeature = feature;

  if (window.OldPragueMeta?.renderDetails) {
    window.OldPragueMeta.renderDetails(detailsEl, feature, state.archiveBaseUrl, {
      groupItems: state.currentGroup?.items || [],
      selectedId: feature.properties?.id || "",
      onSelectVersion: (xid) => {
        const nextFeature = state.currentGroup?.items?.find(
          (item) => item?.properties?.id === xid,
        );
        if (nextFeature) {
          setCurrentFeature(nextFeature);
        }
      },
    });
  }

  const xid = feature.properties.id;
  const url = getArchiveUrl(xid);
  iframe.src = url;
  if (zoomLastXid !== xid) {
    loadZoomifyInto(xid);
  }

  const [lon, lat] = feature.geometry.coordinates;
  const point = [lat, lon];

  if (!state.originalMarker) {
    state.originalMarker = L.marker(point).addTo(state.map);
  } else {
    state.originalMarker.setLatLng(point);
  }

  state.map.setView(point, Math.max(state.map.getZoom(), 15), { animate: true });
}

function showGroup(group, options = {}) {
  state.currentGroup = group;
  state.proposed = null;
  state.mode = null;
  clearStatus();
  closeCorrectionModal();
  updateCounts();
  updateSubmitState();

  if (messageEl) messageEl.value = "";
  if (submitCorrectionBtn) submitCorrectionBtn.classList.add("is-hidden");

  const groupId = group?.id || "";
  const prevVote = state.voted[groupId];
  voteUpBtn.classList.toggle("is-voted", prevVote === "ok");
  voteDownBtn.classList.toggle("is-voted", prevVote === "wrong");

  let feature = group?.primary;
  const selectedXid = options.selectedXid;
  if (selectedXid) {
    const candidate = group?.items?.find(
      (item) => item?.properties?.id === selectedXid,
    );
    if (candidate) feature = candidate;
  }

  setCurrentFeature(feature);

  if (state.proposedMarker) {
    state.map.removeLayer(state.proposedMarker);
    state.proposedMarker = null;
  }
}

function setMode(mode) {
  state.mode = mode;
  clearStatus();

  const groupId = state.currentGroup?.id;
  if (groupId) {
    state.voted[groupId] = mode;
  }

  // Update button visuals
  voteUpBtn.classList.toggle("is-voted", mode === "ok");
  voteDownBtn.classList.toggle("is-voted", mode === "wrong");

  // For "ok", submit immediately and auto-advance
  if (mode === "ok") {
    submitOk();
    return;
  }

  // For "wrong", show the form
  if (!helpForm) return;
  state.proposed = null; // Reset proposed point when entering mode
  if (state.proposedMarker) {
    state.map.removeLayer(state.proposedMarker);
    state.proposedMarker = null;
  }
  closeCorrectionModal();
  if (submitCorrectionBtn) {
    submitCorrectionBtn.classList.remove("is-hidden");
  }
  if (helpMapNote) {
    helpMapNote.textContent =
      "Nesedí? Klikněte do mapy na správné místo, nebo zvolte „Nevím kde přesně“.";
  }
  updateSubmitState();
}

async function pickRandom() {
  if (!state.remaining.length) {
    state.remaining = [...state.groups];
  }

  const idx = Math.floor(Math.random() * state.remaining.length);
  const group = state.remaining.splice(idx, 1)[0];

  if (state.currentGroup) {
    state.history.push(state.currentGroup);
  }

  showGroup(group);
}

function pickPrev() {
  if (state.history.length === 0) return;
  const prevGroup = state.history.pop();

  // Put current back to remaining if it's not the one we just popped
  if (state.currentGroup) {
    state.remaining.push(state.currentGroup);
  }

  showGroup(prevGroup);
}

async function submitCorrectionRequest(payload) {
  const sendRequest = () =>
    fetch("/api/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });

  const submitWithRetry = window.OldPragueSession?.submitWithSessionRetry;
  if (submitWithRetry) {
    await submitWithRetry(sendRequest);
    return;
  }

  const response = await sendRequest();
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || "Odeslání selhalo");
  }
}

async function submitCorrection() {
  if (!state.currentGroup || !state.currentFeature || state.mode !== "wrong" || !state.proposed) return;

  clearStatus();

  const payload = {
    xid: state.currentFeature.properties.id,
    group_id: state.currentGroup.id,
    lat: state.proposed.lat,
    lon: state.proposed.lon,
    verdict: "wrong",
    message: (messageEl?.value || "").trim() || "Nahlášena špatná poloha.",
    email: (emailEl?.value || "").trim() || null,
  };

  submitCorrectionBtn.disabled = true;

  try {
    await submitCorrectionRequest(payload);

    setStatus("Díky! Uloženo. Jdeme na další.", "success");
    closeCorrectionModal();
    setTimeout(() => pickRandom(), 400);
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
    updateSubmitState();
  }
}

async function submitFlag() {
  if (!state.currentGroup || !state.currentFeature || state.mode !== "wrong") return;

  clearStatus();

  const payload = {
    xid: state.currentFeature.properties.id,
    group_id: state.currentGroup.id,
    verdict: "flag",
    message: (messageEl?.value || "").trim() || "Nahlášeno bez upřesnění polohy.",
    email: (emailEl?.value || "").trim() || null,
  };

  if (submitFlagBtn) submitFlagBtn.disabled = true;

  try {
    await submitCorrectionRequest(payload);

    setStatus("Díky! Hlášení uloženo. Jdeme na další.", "success");
    closeCorrectionModal();
    setTimeout(() => pickRandom(), 400);
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
  } finally {
    if (submitFlagBtn) submitFlagBtn.disabled = false;
  }
}

async function submitOk() {
  if (!state.currentGroup || !state.currentFeature || state.mode !== "ok") return;

  clearStatus();

  const payload = {
    xid: state.currentFeature.properties.id,
    group_id: state.currentGroup.id,
    verdict: "ok",
    message: "Poloha potvrzena jako OK.",
  };

  try {
    await submitCorrectionRequest(payload);

    setStatus("Díky! Potvrzeno. Jdeme na další.", "success");
    setTimeout(() => pickRandom(), 400);
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
    updateSubmitState();
  }
}

async function bootstrap() {
  const config = await fetchJson("/api/config").catch(() => ({}));
  state.archiveBaseUrl = config.archiveBaseUrl || state.archiveBaseUrl;

  initMap();
  loadSavedEmail();
  setControlsEnabled(false);
  setVerificationNote("Při prvním odeslání může vyskočit ověření pro relaci.");

  const photos = await fetchJson("/data/photos.geojson");
  const features = photos.features || [];
  state.features = features;

  const reviewState = await fetchJson("/api/review-state").catch(() => ({}));
  const doneGroupIds = applyReviewStateToFeatures(features, reviewState);

  const grouping = window.OldPragueGrouping;
  const groupIndex = grouping.buildGroups(features);
  state.groups = groupIndex.groups;
  state.groupByXid = groupIndex.groupByXid;
  state.remaining = state.groups.filter((group) => !doneGroupIds.has(group.id));
  updateCounts();
  refreshRemainingCloud({ force: true });

  dataReady = true;
  maybeStartFlow();
}

/* removed submitOkBtn listener */
if (submitCorrectionBtn) {
  submitCorrectionBtn.addEventListener("click", submitCorrection);
}
if (submitFlagBtn) {
  submitFlagBtn.addEventListener("click", submitFlag);
}
if (cancelCorrectionBtn) {
  cancelCorrectionBtn.addEventListener("click", () => {
    cancelCorrection();
  });
}
if (emailEl) {
  emailEl.addEventListener("input", () => {
    const value = emailEl.value.trim();
    if (value) {
      localStorage.setItem(EMAIL_STORAGE_KEY, value);
    }
  });
}

document.querySelectorAll("[data-help-close]").forEach((el) => {
  el.addEventListener("click", cancelCorrection);
});
skipBtn.addEventListener("click", () => pickRandom());
if (prevBtn) prevBtn.addEventListener("click", () => pickPrev());
voteUpBtn.addEventListener("click", () => setMode("ok"));
voteDownBtn.addEventListener("click", () => setMode("wrong"));

bootstrap().catch((error) => {
  setStatus("Nepodařilo se načíst data.", "error");
  console.error(error);
});
