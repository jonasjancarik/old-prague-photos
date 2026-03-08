const state = {
  features: [],
  groups: [],
  groupById: new Map(),
  groupByXid: new Map(),
  groupRoots: new Map(),
  decisions: [],
  decisionsByPair: new Map(),
  candidates: [],
  remaining: [],
  history: [],
  currentPair: null,
  lastSubmittedPair: null,
  similarityPairs: [],
  leftGroup: null,
  rightGroup: null,
  leftFeature: null,
  rightFeature: null,
  archiveBaseUrl: "",
  scanIndexByXid: new Map(),
  lastPickedSource: "",
  focusGroupId: "",
};

const candidateCountEl = document.getElementById("candidate-count");
const remainingCountEl = document.getElementById("remaining-count");
const prevBtn = document.getElementById("prev-pair");
const skipBtn = document.getElementById("skip-pair");
const sameBtn = document.getElementById("mark-same");
const differentBtn = document.getElementById("mark-different");
const undoBtn = document.getElementById("undo-last");
const statusEl = document.getElementById("review-status");
const turnstileNote = document.getElementById("turnstile-note");
const pairSourceEl = document.getElementById("pair-source");
const pairFilterEl = document.getElementById("pair-filter");

const leftDetails = document.getElementById("left-details");
const rightDetails = document.getElementById("right-details");
const leftWrap = document.getElementById("left-iframe")?.closest(".zoom-wrap");
const rightWrap = document.getElementById("right-iframe")?.closest(".zoom-wrap");
const leftIframe = document.getElementById("left-iframe");
const rightIframe = document.getElementById("right-iframe");
const leftZoomEl = document.getElementById("left-zoom");
const rightZoomEl = document.getElementById("right-zoom");

function setStatus(message, tone = "") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function clearStatus() {
  if (!statusEl) return;
  statusEl.textContent = "";
  statusEl.dataset.tone = "";
}

function pairKey(a, b) {
  if (!a || !b) return "";
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function updateCounts() {
  if (candidateCountEl) {
    candidateCountEl.textContent = state.candidates.length
      ? state.candidates.length.toLocaleString()
      : "0";
  }
  if (remainingCountEl) {
    remainingCountEl.textContent = state.remaining.length
      ? state.remaining.length.toLocaleString()
      : "0";
  }
  if (prevBtn) {
    prevBtn.disabled = state.history.length === 0;
  }
}

function updateActionState() {
  const canSubmit = !!state.currentPair;
  const canUndo = Boolean(
    state.lastSubmittedPair?.group_id_a && state.lastSubmittedPair?.group_id_b,
  );
  if (sameBtn) sameBtn.disabled = !canSubmit;
  if (differentBtn) differentBtn.disabled = !canSubmit;
  if (undoBtn) undoBtn.disabled = !canUndo;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Požadavek selhal: ${response.status}`);
  return response.json();
}

function resolveGroupRoot(groupId) {
  const raw = String(groupId || "").trim();
  if (!raw) return "";
  return state.groupRoots.get(raw) || raw;
}

function applyReviewStatePayload(reviewState) {
  const grouping = window.OldPragueGrouping;
  grouping.applyReviewState(state.features, reviewState || {});

  const roots = reviewState?.groupRoots || {};
  state.groupRoots = new Map(Object.entries(roots));
  state.decisions = Array.isArray(reviewState?.mergeDecisions)
    ? reviewState.mergeDecisions
    : [];

  const groupIndex = grouping.buildGroups(state.features);
  state.groups = groupIndex.groups;
  state.groupById = groupIndex.groupById;
  state.groupByXid = groupIndex.groupByXid;
}

async function loadZoomifyMeta(xid, scanIndex) {
  const url = `/api/zoomify?xid=${encodeURIComponent(xid)}&scanIndex=${encodeURIComponent(
    String(scanIndex || 0),
  )}`;
  return fetchJson(url);
}

function getArchiveUrl(xid, scanIndex) {
  if (!state.archiveBaseUrl || !xid) return "";
  const scanParam = Number.isFinite(scanIndex) ? scanIndex + 1 : 1;
  return `${state.archiveBaseUrl.replace(/\/$/, "")}/permalink?xid=${encodeURIComponent(
    xid,
  )}&scan=${scanParam}#scan${scanParam}`;
}

function createZoomState(viewerEl, wrapEl, iframeEl) {
  return {
    viewer: null,
    lastKey: null,
    viewerEl,
    wrapEl,
    iframeEl,
  };
}

const leftZoom = createZoomState(leftZoomEl, leftWrap, leftIframe);
const rightZoom = createZoomState(rightZoomEl, rightWrap, rightIframe);

function buildZoomKey(xid, scanIndex) {
  return `${xid || ""}::${scanIndex ?? 0}`;
}

async function loadZoomifyInto(target, xid, scanIndex) {
  if (!target.viewerEl || !target.wrapEl) return;
  const key = buildZoomKey(xid, scanIndex);
  if (target.lastKey === key) return;
  target.lastKey = key;
  target.wrapEl.classList.remove("is-fallback");

  try {
    if (!window.OpenSeadragon) {
      throw new Error("OpenSeadragon chybí");
    }

    const meta = await loadZoomifyMeta(xid, scanIndex);

    if (!target.viewer) {
      target.viewer = window.OpenSeadragon({
        element: target.viewerEl,
        prefixUrl:
          "https://unpkg.com/openseadragon@4.1.1/build/openseadragon/images/",
        showNavigator: true,
        maxZoomPixelRatio: 2,
      });
      window.OldPragueZoomify?.styleControls?.(target.viewer);
    }

    if (!window.OldPragueZoomify?.createTileSource) {
      throw new Error("Chybí helper pro Zoomify");
    }
    target.viewer.open(window.OldPragueZoomify.createTileSource(meta));
  } catch (error) {
    console.warn("Zoom náhled selhal", error);
    target.wrapEl.classList.add("is-fallback");
  }
}

function renderSideDetails(side, group, feature) {
  const container = side === "left" ? leftDetails : rightDetails;
  if (!container || !window.OldPragueMeta?.renderDetails) return;
  const xid = feature?.properties?.id || "";
  const selectedScanIndex = getScanIndex(xid);
  window.OldPragueMeta.renderDetails(container, feature, state.archiveBaseUrl, {
    groupItems: group?.items || [],
    selectedId: feature?.properties?.id || "",
    onSelectVersion: (xid) => {
      const nextFeature = group?.items?.find(
        (item) => item?.properties?.id === xid,
      );
      if (nextFeature) {
        setSideFeature(side, group, nextFeature);
      }
    },
    selectedScanIndex,
    onSelectScan: (nextScan) => {
      setScanIndex(xid, nextScan);
      setSideFeature(side, group, feature);
    },
  });
}

function getScanIndex(xid) {
  if (!xid) return 0;
  return state.scanIndexByXid.get(xid) ?? 0;
}

function setScanIndex(xid, scanIndex) {
  if (!xid || !Number.isFinite(scanIndex)) return;
  state.scanIndexByXid.set(xid, scanIndex);
}

function renderFocusFilter() {
  if (!pairFilterEl) return;
  const focusId = resolveGroupRoot(state.focusGroupId) || state.focusGroupId;
  if (!focusId) {
    pairFilterEl.classList.add("is-hidden");
    pairFilterEl.textContent = "";
    return;
  }
  pairFilterEl.textContent = `Filtr: jen páry ze série ${shortId(focusId)}`;
  pairFilterEl.classList.remove("is-hidden");
}

function setSideFeature(side, group, feature) {
  if (!group || !feature) return;
  const xid = feature.properties.id;
  if (!xid) return;

  if (side === "left") {
    state.leftFeature = feature;
  } else {
    state.rightFeature = feature;
  }

  const scanIndex = getScanIndex(xid);
  const url = getArchiveUrl(xid, scanIndex);
  const iframe = side === "left" ? leftIframe : rightIframe;
  if (iframe) iframe.src = url;

  const zoomTarget = side === "left" ? leftZoom : rightZoom;
  loadZoomifyInto(zoomTarget, xid, scanIndex);

  renderSideDetails(side, group, feature);
}

function showPair(pair) {
  if (!pair) return;
  state.currentPair = pair;
  state.leftGroup = pair.groupA;
  state.rightGroup = pair.groupB;
  if (pairSourceEl) {
    const label =
      pair.source === "similarity"
        ? "Zdroj páru: vizuální podobnost"
        : "Zdroj páru: shodná poloha";
    pairSourceEl.textContent = label;
  }

  const leftFeature = pair.groupA?.primary || pair.groupA?.items?.[0];
  const rightFeature = pair.groupB?.primary || pair.groupB?.items?.[0];

  setSideFeature("left", pair.groupA, leftFeature);
  setSideFeature("right", pair.groupB, rightFeature);

  clearStatus();
  updateActionState();
  updateCounts();
}

function buildDecisionMap() {
  state.decisionsByPair = new Map();
  (state.decisions || []).forEach((item) => {
    const a = String(item?.group_id_a || "").trim();
    const b = String(item?.group_id_b || "").trim();
    const verdict = String(item?.verdict || "").trim();
    if (!a || !b) return;
    const resolvedA = resolveGroupRoot(a);
    const resolvedB = resolveGroupRoot(b);
    if (!resolvedA || !resolvedB || resolvedA === resolvedB) return;
    const key = pairKey(resolvedA, resolvedB);
    if (key) state.decisionsByPair.set(key, verdict);
  });
}

function buildCandidates() {
  const coordMap = new Map();
  const candidates = [];
  const candidateKeys = new Set();
  const focusGroupId = resolveGroupRoot(state.focusGroupId);
  const addCandidate = (groupA, groupB, source) => {
    if (!groupA || !groupB) return;
    if (
      focusGroupId &&
      groupA.id !== focusGroupId &&
      groupB.id !== focusGroupId
    ) {
      return;
    }
    const key = pairKey(groupA.id, groupB.id);
    if (!key || state.decisionsByPair.has(key) || candidateKeys.has(key)) return;
    candidateKeys.add(key);
    candidates.push({ groupA, groupB, key, source });
  };

  state.groups.forEach((group) => {
    const lat = Number(group.lat);
    const lon = Number(group.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    if (!coordMap.has(key)) coordMap.set(key, []);
    coordMap.get(key).push(group);
  });

  coordMap.forEach((groups) => {
    if (groups.length < 2) return;
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const groupA = groups[i];
        const groupB = groups[j];
        addCandidate(groupA, groupB, "coords");
      }
    }
  });

  (state.similarityPairs || []).forEach((item) => {
    const rawA = String(item?.group_id_a || "").trim();
    const rawB = String(item?.group_id_b || "").trim();
    if (!rawA || !rawB) return;
    const resolvedA = resolveGroupRoot(rawA);
    const resolvedB = resolveGroupRoot(rawB);
    if (!resolvedA || !resolvedB || resolvedA === resolvedB) return;
    const groupA = state.groupById.get(resolvedA);
    const groupB = state.groupById.get(resolvedB);
    addCandidate(groupA, groupB, "similarity");
  });

  state.candidates = candidates;
  state.remaining = [...candidates];
  updateCounts();
}

function randomItem(items) {
  if (!Array.isArray(items) || !items.length) return null;
  const idx = Math.floor(Math.random() * items.length);
  return items[idx];
}

function removeRandomRemaining(source = "") {
  const sourceFilter = String(source || "").trim();
  const pool = sourceFilter
    ? state.remaining.filter((item) => item?.source === sourceFilter)
    : state.remaining;
  const picked = randomItem(pool);
  if (!picked) return null;
  const idx = state.remaining.indexOf(picked);
  if (idx >= 0) {
    state.remaining.splice(idx, 1);
  }
  return picked;
}

function pickNext() {
  if (!state.remaining.length) {
    state.remaining = [...state.candidates];
  }
  if (!state.remaining.length) {
    const suffix = state.focusGroupId ? " pro vybranou sérii." : ".";
    setStatus(`Žádné další páry k porovnání${suffix}`, "success");
    state.currentPair = null;
    if (pairSourceEl) pairSourceEl.textContent = "Zdroj páru: —";
    updateActionState();
    updateCounts();
    return;
  }

  const sources = Array.from(
    new Set(
      state.remaining
        .map((item) => String(item?.source || "").trim())
        .filter(Boolean),
    ),
  );
  let preferredSource = "";
  if (sources.length > 1 && state.lastPickedSource) {
    const alternatives = sources.filter((source) => source !== state.lastPickedSource);
    preferredSource = randomItem(alternatives) || "";
  } else if (sources.length > 0) {
    preferredSource = randomItem(sources) || "";
  }

  const pair = removeRandomRemaining(preferredSource) || removeRandomRemaining();
  if (!pair) {
    updateActionState();
    updateCounts();
    return;
  }
  state.lastPickedSource = String(pair.source || "").trim();

  if (state.currentPair) {
    state.history.push(state.currentPair);
  }
  showPair(pair);
}

function pickPrev() {
  if (!state.history.length) return;
  const prevPair = state.history.pop();
  if (state.currentPair) {
    state.remaining.push(state.currentPair);
  }
  showPair(prevPair);
}

function rebuildPairs() {
  state.history = [];
  state.currentPair = null;
  state.lastPickedSource = "";
  buildDecisionMap();
  buildCandidates();
  pickNext();
}

async function submitDecision(verdict) {
  if (!state.currentPair) return;

  clearStatus();

  const payload = {
    group_id_a: state.currentPair.groupA.id,
    group_id_b: state.currentPair.groupB.id,
    verdict,
  };

  try {
    await submitMergePayload(payload);
    state.lastSubmittedPair = {
      group_id_a: payload.group_id_a,
      group_id_b: payload.group_id_b,
    };
    setStatus("Uloženo.", "success");
    rebuildPairs();
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
  }
}

async function submitMergePayload(payload) {
  const sendRequest = () =>
    fetch("/api/merges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });

  const submitWithRetry = window.OldPragueSession?.submitWithSessionRetry;
  if (submitWithRetry) {
    await submitWithRetry(sendRequest);
  } else {
    const response = await sendRequest();
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Odeslání selhalo");
    }
  }

  const reviewState = await fetchJson("/api/review-state?fresh=1").catch(() => ({}));
  applyReviewStatePayload(reviewState);
}

async function undoLastDecision() {
  const pair = state.lastSubmittedPair;
  if (!pair?.group_id_a || !pair?.group_id_b) return;

  clearStatus();

  try {
    await submitMergePayload({
      group_id_a: pair.group_id_a,
      group_id_b: pair.group_id_b,
      verdict: "undo",
    });
    state.lastSubmittedPair = null;
    setStatus("Poslední hlas vrácen.", "success");
    rebuildPairs();
  } catch (error) {
    setStatus(error.message || "Vrácení hlasu selhalo", "error");
  }
}

async function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  state.focusGroupId = String(params.get("group_id") || "").trim();

  const config = await fetchJson("/api/config").catch(() => ({}));
  state.archiveBaseUrl = config.archiveBaseUrl || "";

  const rawPhotos = await fetchJson("/data/photos.geojson");
  const mediaFilter = window.OldPragueMediaFilter;
  const photos = mediaFilter?.filterPhotoCollection
    ? await mediaFilter.filterPhotoCollection(rawPhotos)
    : rawPhotos;
  state.features = photos.features || [];

  const reviewState = await fetchJson("/api/review-state").catch(() => ({}));
  applyReviewStatePayload(reviewState);

  const similarityData = await fetchJson("/data/similarity_candidates.json").catch(
    () => ({ pairs: [] }),
  );
  state.similarityPairs = similarityData.pairs || [];

  buildDecisionMap();
  renderFocusFilter();
  buildCandidates();
  pickNext();
  if (turnstileNote) {
    turnstileNote.textContent =
      "Při prvním hlasu může vyskočit ověření pro relaci.";
  }
}

if (skipBtn) skipBtn.addEventListener("click", () => pickNext());
if (prevBtn) prevBtn.addEventListener("click", () => pickPrev());
if (sameBtn) sameBtn.addEventListener("click", () => submitDecision("same"));
if (differentBtn)
  differentBtn.addEventListener("click", () => submitDecision("different"));
if (undoBtn) undoBtn.addEventListener("click", () => undoLastDecision());

bootstrap().catch((error) => {
  setStatus("Nepodařilo se načíst data.", "error");
  console.error(error);
});
