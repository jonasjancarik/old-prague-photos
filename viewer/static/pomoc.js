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
  doneGroupIds: new Set(),
  submittedGroupIds: new Set(),
  remaining: [],
  history: [],
  voted: {}, // group_id -> "ok" | "wrong"
  currentGroup: null,
  currentFeature: null,
  proposed: null,
  reviewStateReady: false,
  submitting: false,
  candidateTotal: 0,
  candidateNextCursor: "0",
  loadingCandidates: false,
  lastReviewState: null,
  focusGroupId: "",
};

const iframe = document.getElementById("help-iframe");
const zoomWrap = iframe?.closest(".zoom-wrap");
const zoomViewerEl = document.getElementById("help-zoom");
const sessionCountEl = document.getElementById("session-count");
const captionEl = document.getElementById("help-caption");
const currentXidEl = document.getElementById("current-xid");
const detailsEl = document.getElementById("help-details");
const submitCorrectionBtn = document.getElementById("submit-correction");
const submitFlagBtn = document.getElementById("submit-flag");
const cancelCorrectionBtn = document.getElementById("cancel-correction");
const prevBtn = document.getElementById("prev-photo");
const skipBtn = document.getElementById("skip-photo");
const voteUpBtn = document.getElementById("vote-up");
const voteDownBtn = document.getElementById("vote-down");
const wrongActionsEl = document.getElementById("help-wrong-actions");
const openFlagBtn = document.getElementById("open-flag");
const helpForm = document.getElementById("help-form");
const helpCorrectionModal = document.getElementById("help-correction-modal");
const helpMapNote = document.getElementById("help-map-note");
const locationReviewNote = document.getElementById("location-review-note");
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
let correctionModalPreviousFocus = null;
let statusClearTimer = null;

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

function clearStatusElements() {
  [formStatus, modalStatus].forEach((el) => {
    if (!el) return;
    el.textContent = "";
    el.dataset.tone = "";
  });
}

function setStatus(message, tone = "", options = {}) {
  if (statusClearTimer !== null) {
    window.clearTimeout(statusClearTimer);
    statusClearTimer = null;
  }
  [formStatus, modalStatus].forEach((el) => {
    if (!el) return;
    el.textContent = message;
    el.dataset.tone = tone;
  });
  const clearAfter = Number(options.clearAfter) || 0;
  if (clearAfter > 0) {
    statusClearTimer = window.setTimeout(() => {
      statusClearTimer = null;
      clearStatusElements();
    }, clearAfter);
  }
}

function clearStatus(options = {}) {
  if (statusClearTimer !== null && !options.force) return;
  if (statusClearTimer !== null) {
    window.clearTimeout(statusClearTimer);
    statusClearTimer = null;
  }
  clearStatusElements();
}

function setVerificationNote(message, tone = "") {
  if (!turnstileNote) return;
  turnstileNote.textContent = message;
  turnstileNote.dataset.tone = tone;
}

function setControlsEnabled(enabled) {
  const effectiveEnabled =
    Boolean(enabled) && state.reviewStateReady && !state.submitting;
  [voteUpBtn, voteDownBtn, skipBtn, openFlagBtn].forEach((btn) => {
    if (!btn) return;
    btn.disabled = !effectiveEnabled;
  });
  if (prevBtn) {
    prevBtn.disabled = !effectiveEnabled || state.history.length === 0;
  }
  if (submitFlagBtn) submitFlagBtn.disabled = !effectiveEnabled;
  if (!effectiveEnabled && submitCorrectionBtn) {
    submitCorrectionBtn.disabled = true;
  }
}

function openCorrectionModal() {
  if (!helpCorrectionModal) return;
  correctionModalPreviousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  helpCorrectionModal.classList.add("is-open");
  helpCorrectionModal.setAttribute("aria-hidden", "false");
  if (helpForm) helpForm.classList.remove("is-hidden");
  document.body.style.overflow = "hidden";
  helpCorrectionModal.querySelector("button")?.focus();
}

function closeCorrectionModal({ restoreFocus = true } = {}) {
  if (!helpCorrectionModal) return;
  const wasOpen = helpCorrectionModal.classList.contains("is-open");
  helpCorrectionModal.classList.remove("is-open");
  helpCorrectionModal.setAttribute("aria-hidden", "true");
  if (helpForm) helpForm.classList.add("is-hidden");
  document.body.style.overflow = "";
  if (restoreFocus && wasOpen && correctionModalPreviousFocus?.isConnected) {
    correctionModalPreviousFocus.focus();
  }
  correctionModalPreviousFocus = null;
}

function cancelCorrection() {
  state.mode = null;
  closeCorrectionModal({ restoreFocus: false });
  clearStatus({ force: true });
  if (voteDownBtn) voteDownBtn.classList.remove("is-voted");
  if (state.proposedMarker) {
    state.map.removeLayer(state.proposedMarker);
    state.proposedMarker = null;
  }
  state.proposed = null;
  wrongActionsEl?.classList.add("is-hidden");
  if (state.currentFeature) setCurrentFeature(state.currentFeature);
  updateSubmitState();
  voteDownBtn?.focus();
}

function openFlagModal() {
  if (state.mode !== "wrong") return;
  state.proposed = null;
  if (submitCorrectionBtn) submitCorrectionBtn.classList.add("is-hidden");
  if (submitFlagBtn) submitFlagBtn.classList.remove("is-hidden");
  if (helpMapNote) {
    helpMapNote.textContent =
      "Odešlete hlášení, pokud víte, že poloha nesedí, ale správné místo neznáte.";
  }
  if (locationReviewNote) {
    locationReviewNote.textContent =
      "Klikněte do mapy na správnou polohu, nebo zvolte „Nevím, kde to je“.";
  }
  openCorrectionModal();
}

function maybeStartFlow() {
  if (!dataReady || flowStarted) return;
  flowStarted = true;
  setControlsEnabled(true);
  startReviewStatePolling();
  refreshRemainingCloud({ force: true });
  pickRandom();
}

function clearLegacyStoredEmail() {
  try {
    window.localStorage.removeItem(EMAIL_STORAGE_KEY);
  } catch (error) {
    console.warn("Uložený e-mail se nepodařilo odstranit", error);
  }
}

function updateCounts() {
  // Show what the visitor has done, not the size of the whole backlog.
  if (sessionCountEl) {
    sessionCountEl.textContent = state.submittedGroupIds.size.toLocaleString("cs-CZ");
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
    const reviewState = await fetchJson("/api/review-state?snapshot=1");
    state.reviewStateReady = true;
    applyReviewStateSnapshot(reviewState, { announceCurrentChange: true });
    setControlsEnabled(true);
    reviewStateLastRefreshAt = Date.now();
  } catch (err) {
    state.reviewStateReady = false;
    setControlsEnabled(false);
    setStatus(
      "Aktuální stav komunity se nepodařilo načíst. Obnovte stránku a zkuste to znovu.",
      "error",
    );
    console.warn("Refresh counteru selhal", err);
  } finally {
    reviewStateRefreshInFlight = false;
  }
}

function updateSubmitState() {
  const isWrong = state.mode === "wrong";
  const hasProposed = !!state.proposed;

  if (submitCorrectionBtn) {
    submitCorrectionBtn.disabled =
      !state.reviewStateReady || state.submitting || !isWrong || !hasProposed;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(
      payload?.detail || `Požadavek selhal: ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function loadLocationCandidatePage({ reset = false } = {}) {
  if (state.loadingCandidates) return false;
  const cursor = reset ? "0" : state.candidateNextCursor;
  if (cursor === null) return false;
  state.loadingCandidates = true;
  try {
    let payload;
    try {
      const params = new URLSearchParams({
        flow: "location",
        cursor,
        limit: "40",
      });
      if (state.focusGroupId) params.set("group_id", state.focusGroupId);
      payload = await fetchJson(`/api/community-candidates?${params.toString()}`);
    } catch (error) {
      if (error?.status === 409 && !reset) {
        state.loadingCandidates = false;
        return loadLocationCandidatePage({ reset: true });
      }
      throw error;
    }
    if (reset) {
      state.features = [];
      state.groups = [];
      state.groupByXid = new Map();
      state.remaining = [];
    }
    const knownXids = new Set(
      state.features
        .map((feature) => String(feature?.properties?.id || "").trim())
        .filter(Boolean),
    );
    (Array.isArray(payload?.items) ? payload.items : []).forEach((group) => {
      const groupId = String(group?.id || "").trim();
      if (groupId) state.doneGroupIds.delete(groupId);
      (Array.isArray(group?.items) ? group.items : []).forEach((feature) => {
        const xid = String(feature?.properties?.id || "").trim();
        if (!xid || knownXids.has(xid)) return;
        knownXids.add(xid);
        state.features.push(feature);
      });
    });
    state.candidateTotal = Number(payload?.total) || 0;
    state.candidateNextCursor = payload?.nextCursor ?? null;
    rebuildGroupIndexPreservingNavigation();
    return true;
  } finally {
    state.loadingCandidates = false;
    updateCounts();
  }
}

function applyReviewStateToFeatures(features, reviewState) {
  const grouping = window.OldPragueGrouping;
  const applied = grouping.applyReviewState(features, reviewState || {});
  return applied.doneGroupIds || new Set();
}

function primaryXid(group) {
  return String(
    group?.primary?.properties?.id || group?.items?.[0]?.properties?.id || "",
  ).trim();
}

function rebuildGroupIndexPreservingNavigation() {
  const currentXid = String(state.currentFeature?.properties?.id || "").trim();
  const historyXids = state.history.map((group) => primaryXid(group)).filter(Boolean);
  const grouping = window.OldPragueGrouping;
  const groupIndex = grouping.buildGroups(state.features);
  state.groups = groupIndex.groups;
  state.groupByXid = groupIndex.groupByXid;

  state.currentGroup = currentXid
    ? state.groupByXid.get(currentXid) || null
    : null;
  if (state.currentGroup) {
    state.currentFeature =
      state.currentGroup.items.find(
        (feature) => String(feature?.properties?.id || "") === currentXid,
      ) || state.currentGroup.primary;
  }

  const seenHistory = new Set();
  state.history = historyXids
    .map((xid) => state.groupByXid.get(xid))
    .filter((group) => {
      if (!group?.id || group.id === state.currentGroup?.id) return false;
      if (seenHistory.has(group.id)) return false;
      seenHistory.add(group.id);
      return true;
    });
  state.remaining = [];
  syncRemainingPool();
  updateCounts();
}

function locationEvidenceKey(feature) {
  if (!feature) return "";
  const props = feature.properties || {};
  const coordinates = Array.isArray(feature.geometry?.coordinates)
    ? feature.geometry.coordinates.slice(0, 2)
    : [];
  return JSON.stringify([
    String(props.location_revision || "").trim(),
    String(props.proposed_id || "").trim(),
    Boolean(props.proposed_has_coordinates),
    props.proposed_lat ?? null,
    props.proposed_lon ?? null,
    coordinates,
  ]);
}

function resetTransientLocationDecision() {
  const groupId = String(state.currentGroup?.id || "").trim();
  if (groupId) delete state.voted[groupId];
  state.mode = null;
  state.proposed = null;
  closeCorrectionModal({ restoreFocus: false });
  wrongActionsEl?.classList.add("is-hidden");
  voteUpBtn?.classList.remove("is-voted");
  voteDownBtn?.classList.remove("is-voted");
  updateSubmitState();
}

function applyReviewStateSnapshot(reviewState, options = {}) {
  const currentXid = String(state.currentFeature?.properties?.id || "").trim();
  const previousEvidence = locationEvidenceKey(state.currentFeature);
  state.lastReviewState = reviewState;
  const done = applyReviewStateToFeatures(state.features, reviewState);
  state.doneGroupIds = new Set(done);
  rebuildGroupIndexPreservingNavigation();
  const evidenceChanged = Boolean(
    currentXid &&
      state.currentFeature &&
      previousEvidence !== locationEvidenceKey(state.currentFeature),
  );
  if (evidenceChanged) {
    resetTransientLocationDecision();
    setCurrentFeature(state.currentFeature);
    if (options.announceCurrentChange) {
      setStatus(
        "Stav polohy se mezitím změnil. Prohlédněte si aktualizované body a rozhodněte se znovu.",
        "info",
      );
    }
  }
  return evidenceChanged;
}

function syncRemainingPool() {
  const currentGroupId = state.currentGroup?.id || "";
  const historyIds = new Set(
    state.history.map((group) => String(group?.id || "").trim()).filter(Boolean),
  );
  const next = [];
  const seen = new Set();

  state.remaining.forEach((group) => {
    const groupId = String(group?.id || "").trim();
    if (!groupId || seen.has(groupId)) return;
    if (state.doneGroupIds.has(groupId)) return;
    if (state.submittedGroupIds.has(groupId)) return;
    if (groupId === currentGroupId || historyIds.has(groupId)) return;
    seen.add(groupId);
    next.push(group);
  });

  state.groups.forEach((group) => {
    const groupId = String(group?.id || "").trim();
    if (!groupId || seen.has(groupId)) return;
    if (state.doneGroupIds.has(groupId)) return;
    if (state.submittedGroupIds.has(groupId)) return;
    if (groupId === currentGroupId || historyIds.has(groupId)) return;
    seen.add(groupId);
    next.push(group);
  });

  state.remaining = next;
  updateCounts();
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
  zoomWrap.classList.add("is-loading");
  const reveal = () => {
    if (zoomLastXid === xid) zoomWrap.classList.remove("is-loading");
  };

  try {
    if (!window.OpenSeadragon) {
      throw new Error("OpenSeadragon chybí");
    }

    const meta = await loadZoomifyMeta(xid);
    if (zoomLastXid !== xid) return;

    if (!zoomViewer) {
      zoomViewer = window.OpenSeadragon({
        element: zoomViewerEl,
        prefixUrl:
          "/vendor/openseadragon/images/",
        showNavigator: true,
        maxZoomPixelRatio: 2,
      });
      window.OldPragueZoomify?.styleControls?.(zoomViewer);
    }

    if (!window.OldPragueZoomify?.createTileSource) {
      throw new Error("Chybí helper pro Zoomify");
    }
    if (zoomLastXid !== xid) return;
    zoomViewer.addOnceHandler("tile-drawn", reveal);
    zoomViewer.addOnceHandler("open-failed", reveal);
    zoomViewer.open(window.OldPragueZoomify.createTileSource(meta));
  } catch (error) {
    if (zoomLastXid !== xid) return;
    console.warn("Zoom náhled selhal", error);
    reveal();
    zoomWrap.classList.add("is-fallback");
  }
}

function getArchiveUrl(xid) {
  return `${state.archiveBaseUrl.replace(/\/$/, "")}/permalink?xid=${xid}&scan=1#scan1`;
}

function buildMarkerIcon(markerState = "") {
  const className = markerState ? `marker-dot is-${markerState}` : "marker-dot";
  return L.divIcon({
    className,
    html: "<span></span>",
    iconSize: [34, 34],
  });
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
      helpMapNote.textContent = "Poloha vybrána. Přidejte poznámku a odešlete.";
    }
    updateSubmitState();
    if (submitFlagBtn) submitFlagBtn.classList.add("is-hidden");
    if (submitCorrectionBtn) submitCorrectionBtn.classList.remove("is-hidden");
    openCorrectionModal();
  });
}

function clearCurrentEvidence() {
  state.currentGroup = null;
  state.currentFeature = null;
  state.mode = null;
  state.proposed = null;
  closeCorrectionModal({ restoreFocus: false });
  wrongActionsEl?.classList.add("is-hidden");
  voteUpBtn?.classList.remove("is-voted");
  voteDownBtn?.classList.remove("is-voted");
  if (voteUpBtn) voteUpBtn.textContent = "Poloha sedí";
  if (locationReviewNote) locationReviewNote.textContent = "";
  if (iframe) iframe.removeAttribute("src");
  if (zoomViewer && typeof zoomViewer.close === "function") zoomViewer.close();
  zoomLastXid = null;
  zoomWrap?.classList.remove("is-fallback", "is-loading", "is-unavailable");
  detailsEl?.replaceChildren();
  if (captionEl) captionEl.textContent = "";
  if (state.map && state.originalMarker) {
    state.map.removeLayer(state.originalMarker);
    state.originalMarker = null;
  }
  if (state.map && state.proposedMarker) {
    state.map.removeLayer(state.proposedMarker);
    state.proposedMarker = null;
  }
  if (state.map) state.map.setView(pragueFallback, 13, { animate: false });
  updateCounts();
}

function setCurrentFeature(feature) {
  if (!feature) return;
  state.currentFeature = feature;

  if (captionEl) {
    const props = feature.properties || {};
    const context = [props.date_label, props.author].filter(Boolean).join(" · ");
    captionEl.textContent = [props.description || "Bez popisu", context]
      .filter(Boolean)
      .join(" — ");
  }

  if (window.OldPragueMeta?.renderDetails) {
    window.OldPragueMeta.renderDetails(detailsEl, feature, state.archiveBaseUrl, {
      omitDescription: Boolean(captionEl),
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
    state.originalMarker = L.marker(point, { icon: buildMarkerIcon() }).addTo(
      state.map,
    );
  } else {
    state.originalMarker.setLatLng(point);
    state.originalMarker.setIcon(buildMarkerIcon());
  }
  state.originalMarker.unbindTooltip();
  state.originalMarker.bindTooltip("Současná poloha");

  const props = feature.properties || {};
  const proposedLat = Number(props.proposed_lat);
  const proposedLon = Number(props.proposed_lon);
  const hasProposal = Boolean(
    props.proposed_has_coordinates &&
      props.proposed_id &&
      props.location_revision &&
      Number.isFinite(proposedLat) &&
      Number.isFinite(proposedLon),
  );

  if (hasProposal) {
    const proposedPoint = [proposedLat, proposedLon];
    if (!state.proposedMarker) {
      state.proposedMarker = L.marker(proposedPoint, {
        icon: buildMarkerIcon("pending"),
      }).addTo(state.map);
    } else {
      state.proposedMarker.setLatLng(proposedPoint);
      state.proposedMarker.setIcon(buildMarkerIcon("pending"));
    }
    state.proposedMarker.unbindTooltip();
    state.proposedMarker.bindTooltip("Navržená poloha");
    state.map.fitBounds([point, proposedPoint], {
      animate: true,
      maxZoom: 17,
      padding: [36, 36],
    });
  } else {
    if (state.proposedMarker) {
      state.map.removeLayer(state.proposedMarker);
      state.proposedMarker = null;
    }
    state.map.setView(point, Math.max(state.map.getZoom(), 15), { animate: true });
  }

  if (voteUpBtn) {
    voteUpBtn.textContent = hasProposal ? "Potvrdit návrh" : "Poloha sedí";
  }
  if (locationReviewNote) {
    locationReviewNote.textContent = hasProposal
      ? "Mapa ukazuje současnou polohu a bod „Navržená poloha“. Potvrzením schválíte navržený bod pro celou sérii."
      : "Bod na mapě ukazuje současnou polohu celé série.";
  }
}

function showGroup(group, options = {}) {
  state.currentGroup = group;
  state.proposed = null;
  state.mode = null;
  clearStatus();
  closeCorrectionModal();
  wrongActionsEl?.classList.add("is-hidden");
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

  if (state.proposedMarker) {
    state.map.removeLayer(state.proposedMarker);
    state.proposedMarker = null;
  }
  setCurrentFeature(feature);
}

function setMode(mode) {
  state.mode = mode;
  clearStatus({ force: true });

  const groupId = state.currentGroup?.id;
  if (groupId) {
    state.voted[groupId] = mode;
  }

  // Update button visuals
  voteUpBtn.classList.toggle("is-voted", mode === "ok");
  voteDownBtn.classList.toggle("is-voted", mode === "wrong");

  // For "ok", submit immediately and auto-advance
  if (mode === "ok") {
    wrongActionsEl?.classList.add("is-hidden");
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
  wrongActionsEl?.classList.remove("is-hidden");
  if (submitCorrectionBtn) {
    submitCorrectionBtn.classList.remove("is-hidden");
  }
  if (helpMapNote) {
    helpMapNote.textContent =
      "Nesedí? Klikněte na správné místo v mapě, nebo zvolte „Nesedí, ale nevím, kde to je“.";
  }
  updateSubmitState();
}

async function pickRandom() {
  syncRemainingPool();
  if (!state.remaining.length && state.candidateNextCursor) {
    try {
      await loadLocationCandidatePage();
    } catch (error) {
      clearCurrentEvidence();
      setControlsEnabled(false);
      setStatus("Další fotografie se nepodařilo načíst. Zkuste stránku obnovit.", "error");
      console.error(error);
      return;
    }
    syncRemainingPool();
  }
  if (!state.remaining.length) {
    clearCurrentEvidence();
    setControlsEnabled(false);
    if (prevBtn) {
      prevBtn.disabled = state.history.length === 0;
    }
    if (statusClearTimer === null) {
      setStatus("Pro tuto chvíli už nic dalšího nezbývá.", "success");
    }
    return;
  }

  const idx = Math.floor(Math.random() * state.remaining.length);
  const group = state.remaining.splice(idx, 1)[0];

  if (
    state.currentGroup &&
    !state.doneGroupIds.has(state.currentGroup.id) &&
    !state.submittedGroupIds.has(state.currentGroup.id)
  ) {
    state.history.push(state.currentGroup);
  }

  setControlsEnabled(true);
  showGroup(group);
}

function pickPrev() {
  if (state.history.length === 0) return;
  const prevGroup = state.history.pop();

  // Put current back to remaining if it's not the one we just popped
  if (state.currentGroup) {
    state.remaining.push(state.currentGroup);
  }

  setControlsEnabled(true);
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
  const response = submitWithRetry
    ? await submitWithRetry(sendRequest)
    : await sendRequest();
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || "Odeslání selhalo");
  }
  return response.json().catch(() => ({ ok: true }));
}

async function submitCorrection() {
  if (!state.currentGroup || !state.currentFeature || state.mode !== "wrong" || !state.proposed) return;

  const submittedGroupId = state.currentGroup.id;
  const submittedXid = state.currentFeature.properties.id;
  const proposed = { ...state.proposed };
  state.submitting = true;
  setControlsEnabled(false);
  clearStatus({ force: true });

  const payload = {
    xid: submittedXid,
    group_id: submittedGroupId,
    lat: proposed.lat,
    lon: proposed.lon,
    verdict: "wrong",
    message: (messageEl?.value || "").trim() || "Nahlášena špatná poloha.",
    email: (emailEl?.value || "").trim() || null,
  };

  submitCorrectionBtn.disabled = true;

  let saved = false;
  try {
    await submitCorrectionRequest(payload);
    saved = true;
    if (emailEl) emailEl.value = "";
    state.submittedGroupIds.add(submittedGroupId);
    syncRemainingPool();

    setStatus("Oprava polohy je uložená. Načítám další skupinu.", "success", {
      clearAfter: 2600,
    });
    closeCorrectionModal();
    setTimeout(() => pickRandom(), 400);
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
  } finally {
    state.submitting = false;
    setControlsEnabled(!saved);
    updateSubmitState();
  }
}

async function submitFlag() {
  if (!state.currentGroup || !state.currentFeature || state.mode !== "wrong") return;

  const submittedGroupId = state.currentGroup.id;
  const submittedXid = state.currentFeature.properties.id;
  state.submitting = true;
  setControlsEnabled(false);
  clearStatus({ force: true });

  const payload = {
    xid: submittedXid,
    group_id: submittedGroupId,
    verdict: "flag",
    message: (messageEl?.value || "").trim() || "Nahlášeno bez upřesnění polohy.",
    email: (emailEl?.value || "").trim() || null,
  };

  if (submitFlagBtn) submitFlagBtn.disabled = true;

  let saved = false;
  try {
    await submitCorrectionRequest(payload);
    saved = true;
    if (emailEl) emailEl.value = "";
    state.submittedGroupIds.add(submittedGroupId);
    syncRemainingPool();

    setStatus("Hlášení o poloze je uložené. Načítám další skupinu.", "success", {
      clearAfter: 2600,
    });
    closeCorrectionModal();
    setTimeout(() => pickRandom(), 400);
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
  } finally {
    state.submitting = false;
    setControlsEnabled(!saved);
  }
}

async function submitOk() {
  if (!state.currentGroup || !state.currentFeature || state.mode !== "ok") return;

  const submittedGroupId = state.currentGroup.id;
  const submittedXid = state.currentFeature.properties.id;
  const properties = state.currentFeature.properties || {};
  const locationRevision = String(properties.location_revision || "").trim();
  if (!locationRevision) {
    setStatus(
      "Potvrzovanou polohu se nepodařilo určit. Obnovte stránku a zkuste to znovu.",
      "error",
    );
    state.mode = null;
    voteUpBtn?.classList.remove("is-voted");
    return;
  }
  const proposalId = String(properties.proposed_id || "").trim() || null;
  state.submitting = true;
  setControlsEnabled(false);
  clearStatus({ force: true });

  const payload = {
    xid: submittedXid,
    group_id: submittedGroupId,
    verdict: "ok",
    location_revision: locationRevision,
    proposal_id: proposalId,
    message: proposalId
      ? "Navržená poloha potvrzena."
      : "Poloha potvrzena jako správná.",
  };

  let saved = false;
  try {
    await submitCorrectionRequest(payload);
    saved = true;
    state.submittedGroupIds.add(submittedGroupId);
    syncRemainingPool();

    setStatus(proposalId
      ? "Navržená poloha je potvrzená. Načítám další skupinu."
      : "Potvrzení polohy je uložené. Načítám další skupinu.", "success", {
      clearAfter: 2600,
    });
    setTimeout(() => pickRandom(), 400);
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
  } finally {
    state.submitting = false;
    setControlsEnabled(!saved);
    updateSubmitState();
  }
}

async function bootstrap() {
  const searchParams = new URLSearchParams(window.location.search);
  state.focusGroupId = String(searchParams.get("group_id") || "").trim();
  const config = await fetchJson("/api/config").catch(() => ({}));
  MAPY_CZ_API_KEY = String(config.mapyCzApiKey || "").trim();
  state.archiveBaseUrl = config.archiveBaseUrl || state.archiveBaseUrl;

  initMap();
  clearLegacyStoredEmail();
  if (emailEl) emailEl.value = "";
  setControlsEnabled(false);
  setVerificationNote("Při prvním odeslání se může zobrazit ověření.");

  await loadLocationCandidatePage({ reset: true });
  const reviewState = await fetchJson("/api/review-state?snapshot=1");
  state.reviewStateReady = true;
  applyReviewStateSnapshot(reviewState);
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
if (openFlagBtn) {
  openFlagBtn.addEventListener("click", openFlagModal);
}
if (cancelCorrectionBtn) {
  cancelCorrectionBtn.addEventListener("click", () => {
    cancelCorrection();
  });
}
document.querySelectorAll("[data-help-close]").forEach((el) => {
  el.addEventListener("click", cancelCorrection);
});
document.addEventListener("keydown", (event) => {
  if (!helpCorrectionModal?.classList.contains("is-open")) return;
  if (event.key !== "Escape") return;
  event.preventDefault();
  cancelCorrection();
});
const REVIEW_SHORTCUTS = {
  a: voteUpBtn,
  n: voteDownBtn,
  ArrowRight: skipBtn,
  ArrowLeft: prevBtn,
};

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (helpCorrectionModal?.classList.contains("is-open")) return;
  if (event.target.closest?.("input, textarea, select, [contenteditable], .leaflet-container, .openseadragon-container")) {
    return;
  }
  const flow = document.querySelector('[data-mode-flow="location"]');
  if (!flow || flow.classList.contains("is-hidden")) return;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const button = REVIEW_SHORTCUTS[key];
  if (!button || button.disabled) return;
  event.preventDefault();
  button.click();
});

skipBtn.addEventListener("click", () => pickRandom());
if (prevBtn) prevBtn.addEventListener("click", () => pickPrev());
voteUpBtn.addEventListener("click", () => setMode("ok"));
voteDownBtn.addEventListener("click", () => setMode("wrong"));

bootstrap().catch((error) => {
  clearCurrentEvidence();
  setControlsEnabled(false);
  setStatus("Nepodařilo se načíst data.", "error");
  console.error(error);
});
