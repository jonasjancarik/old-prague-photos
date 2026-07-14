const state = {
  candidates: [],
  remaining: [],
  history: [],
  currentPair: null,
  lastSubmittedPair: null,
  leftGroup: null,
  rightGroup: null,
  leftFeature: null,
  rightFeature: null,
  archiveBaseUrl: "",
  scanIndexByXid: new Map(),
  lastPickedSource: "",
  focusGroupId: "",
  reviewStateReady: false,
  submitting: false,
  candidateTotal: 0,
  candidateNextCursor: "0",
  loadingCandidates: false,
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
    candidateCountEl.textContent = state.candidateTotal
      ? state.candidateTotal.toLocaleString()
      : "0";
  }
  if (remainingCountEl) {
    const reviewedThisSession = state.history.length + (state.currentPair ? 1 : 0);
    remainingCountEl.textContent = Math.max(
      0,
      state.candidateTotal - reviewedThisSession,
    ).toLocaleString();
  }
  if (prevBtn) {
    prevBtn.disabled =
      !state.reviewStateReady || state.submitting || state.history.length === 0;
  }
  if (skipBtn) skipBtn.disabled = !state.reviewStateReady || state.submitting;
}

function updateActionState() {
  const canInteract = state.reviewStateReady && !state.submitting;
  const canSubmit = canInteract && !!state.currentPair;
  const canUndo = Boolean(
    canInteract &&
      state.lastSubmittedPair?.group_id_a &&
      state.lastSubmittedPair?.group_id_b,
  );
  if (sameBtn) sameBtn.disabled = !canSubmit;
  if (differentBtn) differentBtn.disabled = !canSubmit;
  if (undoBtn) undoBtn.disabled = !canUndo;
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

async function loadDuplicateCandidatePage({ reset = false } = {}) {
  if (state.loadingCandidates) return false;
  const cursor = reset ? "0" : state.candidateNextCursor;
  if (cursor === null) return false;
  state.loadingCandidates = true;
  updateCounts();
  try {
    const params = new URLSearchParams({
      flow: "duplicate",
      cursor,
      limit: "24",
    });
    if (state.focusGroupId) params.set("group_id", state.focusGroupId);
    let payload;
    try {
      payload = await fetchJson(`/api/community-candidates?${params}`);
    } catch (error) {
      if (error?.status === 409 && !reset) {
        state.loadingCandidates = false;
        return loadDuplicateCandidatePage({ reset: true });
      }
      throw error;
    }
    if (reset) {
      state.candidates = [];
      state.remaining = [];
    }
    const knownKeys = new Set(state.candidates.map((item) => item.key));
    (Array.isArray(payload?.items) ? payload.items : []).forEach((pair) => {
      if (!pair?.key || knownKeys.has(pair.key)) return;
      knownKeys.add(pair.key);
      state.candidates.push(pair);
      state.remaining.push(pair);
    });
    state.candidateTotal = Number(payload?.total) || 0;
    state.candidateNextCursor = payload?.nextCursor ?? null;
    state.reviewStateReady = true;
    return true;
  } finally {
    state.loadingCandidates = false;
    updateCounts();
    updateActionState();
  }
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
    if (target.lastKey !== key) return;

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
    if (target.lastKey !== key) return;
    target.viewer.open(window.OldPragueZoomify.createTileSource(meta));
  } catch (error) {
    if (target.lastKey !== key) return;
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
  const focusId = state.focusGroupId;
  if (!focusId) {
    pairFilterEl.classList.add("is-hidden");
    pairFilterEl.textContent = "";
    return;
  }
  pairFilterEl.textContent = `Jen páry ze skupiny ${shortId(focusId)}`;
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
        ? "Vybráno podle vizuální podobnosti"
        : "Vybráno podle stejné polohy";
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

async function pickNext() {
  if (!state.remaining.length) {
    await loadDuplicateCandidatePage();
  }
  if (!state.remaining.length) {
    const suffix = state.focusGroupId ? " pro vybranou skupinu." : ".";
    setStatus(`Už tu nejsou žádné páry${suffix}`, "success");
    state.currentPair = null;
    if (pairSourceEl) pairSourceEl.textContent = "Vybráno podle: —";
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

async function submitDecision(verdict) {
  if (!state.currentPair || state.submitting || !state.reviewStateReady) return;

  const submittedPair = {
    group_id_a: state.currentPair.groupA.id,
    group_id_b: state.currentPair.groupB.id,
  };
  state.submitting = true;
  updateCounts();
  updateActionState();
  clearStatus();

  const payload = {
    ...submittedPair,
    verdict,
  };

  try {
    const result = await submitMergePayload(payload);
    state.lastSubmittedPair = result.decision;
    if (result.refreshError) {
      state.reviewStateReady = false;
      setStatus(
        "Rozhodnutí je uložené, ale seznam se nepodařilo obnovit. Obnovte stránku.",
        "error",
      );
    } else {
      setStatus("Uloženo.", "success");
      state.history = [];
      state.currentPair = null;
      state.lastPickedSource = "";
      await pickNext();
    }
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
  } finally {
    state.submitting = false;
    updateCounts();
    updateActionState();
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
  const response = submitWithRetry
    ? await submitWithRetry(sendRequest)
    : await sendRequest();
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || "Odeslání selhalo");
  }
  const saved = await response.json().catch(() => ({}));
  const decision = {
    group_id_a: String(saved?.decision?.group_id_a || payload.group_id_a || "").trim(),
    group_id_b: String(saved?.decision?.group_id_b || payload.group_id_b || "").trim(),
  };

  try {
    await loadDuplicateCandidatePage({ reset: true });
    return { decision, refreshError: null };
  } catch (refreshError) {
    return { decision, refreshError };
  }
}

async function undoLastDecision() {
  const pair = state.lastSubmittedPair;
  if (
    !pair?.group_id_a ||
    !pair?.group_id_b ||
    state.submitting ||
    !state.reviewStateReady
  ) return;

  const submittedPair = { ...pair };
  state.submitting = true;
  updateCounts();
  updateActionState();
  clearStatus();

  try {
    const result = await submitMergePayload({
      group_id_a: submittedPair.group_id_a,
      group_id_b: submittedPair.group_id_b,
      verdict: "undo",
    });
    state.lastSubmittedPair = null;
    if (result.refreshError) {
      state.reviewStateReady = false;
      setStatus(
        "Vrácení je uložené, ale seznam se nepodařilo obnovit. Obnovte stránku.",
        "error",
      );
    } else {
      setStatus("Poslední hlas vrácen.", "success");
      state.history = [];
      state.currentPair = null;
      state.lastPickedSource = "";
      await pickNext();
    }
  } catch (error) {
    setStatus(error.message || "Vrácení hlasu selhalo", "error");
  } finally {
    state.submitting = false;
    updateCounts();
    updateActionState();
  }
}

async function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  state.focusGroupId = String(params.get("group_id") || "").trim();

  const config = await fetchJson("/api/config").catch(() => ({}));
  state.archiveBaseUrl = config.archiveBaseUrl || "";

  renderFocusFilter();
  await loadDuplicateCandidatePage({ reset: true });
  await pickNext();
  if (turnstileNote) {
    turnstileNote.textContent =
      "Při prvním hlasu se může zobrazit ověření.";
  }
}

if (skipBtn) skipBtn.addEventListener("click", () => pickNext());
if (prevBtn) prevBtn.addEventListener("click", () => pickPrev());
if (sameBtn) sameBtn.addEventListener("click", () => submitDecision("same"));
if (differentBtn)
  differentBtn.addEventListener("click", () => submitDecision("different"));
if (undoBtn) undoBtn.addEventListener("click", () => undoLastDecision());

bootstrap().catch((error) => {
  state.reviewStateReady = false;
  updateCounts();
  updateActionState();
  setStatus("Nepodařilo se načíst data.", "error");
  console.error(error);
});
