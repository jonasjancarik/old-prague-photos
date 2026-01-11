// MAPY_CZ_API_KEY is defined in correction-ui.js

const state = {
  map: null,
  originalMarker: null,
  proposedMarker: null,
  mode: null, // null | "ok" | "wrong"
  turnstileSiteKey: "",
  turnstileBypass: false,
  turnstileReady: false,
  verifyWidgetId: null,
  verifyToken: "",
  sessionVerified: false,
  archiveBaseUrl: "https://katalog.ahmp.cz/pragapublica",
  features: [],
  groups: [],
  groupByXid: new Map(),
  groupIdByXid: new Map(),
  resolveGroupId: (id) => id,
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
const verifyModal = document.getElementById("verify-modal");
const verifyStatus = document.getElementById("verify-status");
const verifyEmailInput = document.getElementById("verify-email");
const verifyContinueBtn = document.getElementById("verify-continue");

const pragueFallback = [50.0755, 14.4378];
const EMAIL_STORAGE_KEY = "old-prague-help-email";

let dataReady = false;
let flowStarted = false;

let zoomViewer = null;
let zoomLastXid = null;

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

function setVerifyStatus(message, tone = "") {
  if (!verifyStatus) return;
  verifyStatus.textContent = message;
  verifyStatus.dataset.tone = tone;
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

function openVerifyModal() {
  if (!verifyModal) return;
  if (state.sessionVerified) return;
  closeCorrectionModal();
  verifyModal.classList.add("is-open");
  verifyModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  setControlsEnabled(false);
  setVerifyStatus("Pro pokračování je potřeba ověření.", "");
  if (state.verifyWidgetId !== null && window.turnstile) {
    window.turnstile.reset(state.verifyWidgetId);
    state.verifyToken = "";
  }
  if (verifyContinueBtn) verifyContinueBtn.disabled = true;
}

function closeVerifyModal() {
  if (!verifyModal) return;
  verifyModal.classList.remove("is-open");
  verifyModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function maybeStartFlow() {
  if (!dataReady || !state.sessionVerified || flowStarted) return;
  flowStarted = true;
  setControlsEnabled(true);
  pickRandom();
}

function loadSavedEmail() {
  const saved = localStorage.getItem(EMAIL_STORAGE_KEY);
  if (saved) {
    if (verifyEmailInput) verifyEmailInput.value = saved;
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

async function refreshRemainingCloud() {
  try {
    const corrections = await fetchJson("/api/corrections");
    const grouping = window.OldPragueGrouping;
    const done = grouping.buildDoneGroupSet(
      corrections.items || [],
      state.groupIdByXid,
      state.resolveGroupId,
    );

    // Update local remaining pool while keeping out things already done by others
    state.remaining = state.groups.filter((group) => !done.has(group.id));
    updateCounts();
  } catch (err) {
    console.warn("Refresh counteru selhal", err);
  }
}

function updateSubmitState() {
  const isWrong = state.mode === "wrong";
  const hasSession = state.sessionVerified || state.turnstileBypass;
  const hasProposed = !!state.proposed;

  if (submitCorrectionBtn) {
    submitCorrectionBtn.disabled = !isWrong || !hasProposed || !hasSession;
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
  console.log("setMode:", mode);
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
    console.log("Calling submitOk directly from setMode");
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
  if (helpMapNote) helpMapNote.textContent = "Nesedí? Klikněte do mapy na správné místo.";
  updateSubmitState();
}

async function pickRandom() {
  // Optional: Refresh count from server to see other people's progress
  // We don't await so UI doesn't lag
  refreshRemainingCloud();

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

function renderVerifyTurnstile() {
  if (state.turnstileBypass) {
    setVerifyStatus("Turnstile je vypnutý pro lokální vývoj.", "success");
    state.sessionVerified = true;
    setVerificationNote("Turnstile je vypnutý pro lokální vývoj.");
    closeVerifyModal();
    maybeStartFlow();
    return;
  }

  if (!state.turnstileReady || !state.turnstileSiteKey) {
    if (!state.turnstileSiteKey) {
      setVerifyStatus("Chybí Turnstile klíč.", "error");
    }
    return;
  }

  if (state.verifyWidgetId !== null) return;

  state.verifyWidgetId = window.turnstile.render("#verify-turnstile", {
    sitekey: state.turnstileSiteKey,
    callback: (token) => {
      state.verifyToken = token;
      if (verifyContinueBtn) verifyContinueBtn.disabled = false;
      setVerifyStatus("Ověření připraveno. Pokračujte.", "success");
    },
    "expired-callback": () => {
      state.verifyToken = "";
      if (verifyContinueBtn) verifyContinueBtn.disabled = true;
      setVerifyStatus("Ověření vypršelo, zkuste to znovu.", "error");
    },
    "error-callback": () => {
      state.verifyToken = "";
      if (verifyContinueBtn) verifyContinueBtn.disabled = true;
      setVerifyStatus("Ověření selhalo, zkuste to znovu.", "error");
    },
  });
}

async function submitVerification() {
  if (state.sessionVerified) {
    closeVerifyModal();
    return;
  }
  if (state.turnstileBypass) {
    state.sessionVerified = true;
    setVerificationNote("Turnstile je vypnutý pro lokální vývoj.");
    closeVerifyModal();
    maybeStartFlow();
    return;
  }

  if (!state.verifyToken) {
    setVerifyStatus("Dokončete Turnstile kontrolu.", "error");
    return;
  }

  if (verifyContinueBtn) verifyContinueBtn.disabled = true;
  setVerifyStatus("Ověřuji...", "");

  try {
    const response = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ token: state.verifyToken }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Ověření selhalo");
    }

    state.sessionVerified = true;
    state.verifyToken = "";
    if (state.verifyWidgetId !== null && window.turnstile) {
      window.turnstile.reset(state.verifyWidgetId);
    }
    if (verifyContinueBtn) verifyContinueBtn.disabled = true;

    const email = (verifyEmailInput?.value || "").trim();
    if (email) {
      localStorage.setItem(EMAIL_STORAGE_KEY, email);
      if (emailEl) emailEl.value = email;
    }

    setVerificationNote("Ověřeno pro tuto relaci.");
    closeVerifyModal();
    maybeStartFlow();
    setControlsEnabled(true);
    updateCounts();
    if (state.mode === "ok") {
      submitOk();
    } else if (state.mode === "wrong" && state.proposed) {
      openCorrectionModal();
      updateSubmitState();
    }
  } catch (error) {
    setVerifyStatus(error.message || "Ověření selhalo", "error");
    if (verifyContinueBtn) verifyContinueBtn.disabled = false;
  }
}

window.turnstileOnload = () => {
  state.turnstileReady = true;
  renderVerifyTurnstile();
};

async function submitCorrection() {
  if (!state.currentGroup || !state.currentFeature || state.mode !== "wrong" || !state.proposed) return;

  clearStatus();

  if (!state.sessionVerified && !state.turnstileBypass) {
    openVerifyModal();
    return;
  }

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
    const response = await fetch("/api/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Odeslání selhalo");
    }

    setStatus("Díky! Uloženo. Jdeme na další.", "success");
    closeCorrectionModal();
    setTimeout(() => pickRandom(), 400);
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
    if (String(error.message || "").toLowerCase().includes("turnstile")) {
      state.sessionVerified = false;
      openVerifyModal();
      setVerificationNote("Ověření vypršelo. Dokončete prosím ověření znovu.", "error");
    }
    updateSubmitState();
  }
}

async function submitOk() {
  console.log("submitOk started, state:", { group: state.currentGroup?.id, mode: state.mode, bypass: state.turnstileBypass });
  if (!state.currentGroup || !state.currentFeature || state.mode !== "ok") return;

  clearStatus();

  if (!state.sessionVerified && !state.turnstileBypass) {
    openVerifyModal();
    return;
  }

  const payload = {
    xid: state.currentFeature.properties.id,
    group_id: state.currentGroup.id,
    verdict: "ok",
    message: "Poloha potvrzena jako OK.",
  };

  console.log("Submitting OK payload:", payload);
  try {
    const response = await fetch("/api/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Odeslání selhalo");
    }

    setStatus("Díky! Potvrzeno. Jdeme na další.", "success");
    setTimeout(() => pickRandom(), 400);
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
    if (String(error.message || "").toLowerCase().includes("turnstile")) {
      state.sessionVerified = false;
      openVerifyModal();
      setVerificationNote("Ověření vypršelo. Dokončete prosím ověření znovu.", "error");
    }
    updateSubmitState();
  }
}

async function bootstrap() {
  const config = await fetchJson("/api/config").catch(() => ({}));
  state.turnstileSiteKey = config.turnstileSiteKey || "";
  state.turnstileBypass = Boolean(config.turnstileBypass);
  state.archiveBaseUrl = config.archiveBaseUrl || state.archiveBaseUrl;

  initMap();
  loadSavedEmail();
  setControlsEnabled(false);

  if (state.turnstileBypass) {
    state.sessionVerified = true;
    setVerificationNote("Turnstile je vypnutý pro lokální vývoj.");
  } else {
    openVerifyModal();
    if (window.turnstile) {
      renderVerifyTurnstile();
    }
  }

  const photos = await fetchJson("/data/photos.geojson");
  const features = photos.features || [];
  state.features = features;

  const mergeData = await fetchJson("/api/merges").catch(() => ({
    items: [],
  }));
  const mergeItems = mergeData.items || [];

  const grouping = window.OldPragueGrouping;
  const { map: groupIdByXid, groupIds } = grouping.buildGroupIdByXid(features);
  state.groupIdByXid = groupIdByXid;
  state.resolveGroupId = grouping.buildMergeResolver(groupIds, mergeItems);

  const corrections = await fetchJson("/api/corrections").catch(() => ({
    items: [],
  }));
  grouping.applyCorrections(
    features,
    corrections.items || [],
    groupIdByXid,
    state.resolveGroupId,
  );

  const groupIndex = grouping.buildGroups(features, state.resolveGroupId);
  state.groups = groupIndex.groups;
  state.groupByXid = groupIndex.groupByXid;

  await refreshRemainingCloud();

  dataReady = true;
  maybeStartFlow();
}

/* removed submitOkBtn listener */
if (submitCorrectionBtn) {
  submitCorrectionBtn.addEventListener("click", submitCorrection);
}
if (cancelCorrectionBtn) {
  cancelCorrectionBtn.addEventListener("click", () => {
    cancelCorrection();
  });
}
if (verifyContinueBtn) {
  verifyContinueBtn.addEventListener("click", submitVerification);
}
if (verifyEmailInput) {
  verifyEmailInput.addEventListener("input", () => {
    const value = verifyEmailInput.value.trim();
    if (value) {
      localStorage.setItem(EMAIL_STORAGE_KEY, value);
    }
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
