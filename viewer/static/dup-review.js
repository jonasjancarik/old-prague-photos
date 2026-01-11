const state = {
  features: [],
  groups: [],
  groupById: new Map(),
  groupByXid: new Map(),
  groupIdByXid: new Map(),
  groupIds: new Set(),
  resolveGroupId: (id) => id,
  decisions: [],
  decisionsByPair: new Map(),
  candidates: [],
  remaining: [],
  history: [],
  currentPair: null,
  leftGroup: null,
  rightGroup: null,
  leftFeature: null,
  rightFeature: null,
  archiveBaseUrl: "",
  turnstileSiteKey: "",
  turnstileBypass: false,
  turnstileReady: false,
  turnstileWidgetId: null,
  turnstileToken: "",
};

const candidateCountEl = document.getElementById("candidate-count");
const remainingCountEl = document.getElementById("remaining-count");
const prevBtn = document.getElementById("prev-pair");
const skipBtn = document.getElementById("skip-pair");
const sameBtn = document.getElementById("mark-same");
const differentBtn = document.getElementById("mark-different");
const statusEl = document.getElementById("review-status");
const turnstileNote = document.getElementById("turnstile-note");

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
  const canSubmit =
    !!state.currentPair && (state.turnstileBypass || state.turnstileToken);
  if (sameBtn) sameBtn.disabled = !canSubmit;
  if (differentBtn) differentBtn.disabled = !canSubmit;
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

function getArchiveUrl(xid) {
  if (!state.archiveBaseUrl || !xid) return "";
  return `${state.archiveBaseUrl.replace(/\/$/, "")}/permalink?xid=${encodeURIComponent(xid)}&scan=1#scan1`;
}

function createZoomState(viewerEl, wrapEl, iframeEl) {
  return {
    viewer: null,
    lastXid: null,
    viewerEl,
    wrapEl,
    iframeEl,
  };
}

const leftZoom = createZoomState(leftZoomEl, leftWrap, leftIframe);
const rightZoom = createZoomState(rightZoomEl, rightWrap, rightIframe);

async function loadZoomifyInto(target, xid) {
  if (!target.viewerEl || !target.wrapEl) return;
  if (target.lastXid === xid) return;
  target.lastXid = xid;
  target.wrapEl.classList.remove("is-fallback");

  try {
    if (!window.OpenSeadragon) {
      throw new Error("OpenSeadragon chybí");
    }

    const meta = await loadZoomifyMeta(xid);

    if (!target.viewer) {
      target.viewer = window.OpenSeadragon({
        element: target.viewerEl,
        prefixUrl:
          "https://unpkg.com/openseadragon@4.1.1/build/openseadragon/images/",
        showNavigator: true,
        maxZoomPixelRatio: 2,
      });
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
  });
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

  const url = getArchiveUrl(xid);
  const iframe = side === "left" ? leftIframe : rightIframe;
  if (iframe) iframe.src = url;

  const zoomTarget = side === "left" ? leftZoom : rightZoom;
  loadZoomifyInto(zoomTarget, xid);

  renderSideDetails(side, group, feature);
}

function showPair(pair) {
  if (!pair) return;
  state.currentPair = pair;
  state.leftGroup = pair.groupA;
  state.rightGroup = pair.groupB;

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
    const resolvedA = state.resolveGroupId ? state.resolveGroupId(a) : a;
    const resolvedB = state.resolveGroupId ? state.resolveGroupId(b) : b;
    if (!resolvedA || !resolvedB || resolvedA === resolvedB) return;
    const key = pairKey(resolvedA, resolvedB);
    if (key) state.decisionsByPair.set(key, verdict);
  });
}

function buildCandidates() {
  const coordMap = new Map();
  state.groups.forEach((group) => {
    const lat = Number(group.lat);
    const lon = Number(group.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    if (!coordMap.has(key)) coordMap.set(key, []);
    coordMap.get(key).push(group);
  });

  const candidates = [];
  coordMap.forEach((groups) => {
    if (groups.length < 2) return;
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const groupA = groups[i];
        const groupB = groups[j];
        const key = pairKey(groupA.id, groupB.id);
        if (!key || state.decisionsByPair.has(key)) continue;
        candidates.push({ groupA, groupB, key });
      }
    }
  });

  state.candidates = candidates;
  state.remaining = [...candidates];
  updateCounts();
}

function pickNext() {
  if (!state.remaining.length) {
    state.remaining = [...state.candidates];
  }
  if (!state.remaining.length) {
    setStatus("Žádné další páry k porovnání.", "success");
    state.currentPair = null;
    updateActionState();
    updateCounts();
    return;
  }

  const idx = Math.floor(Math.random() * state.remaining.length);
  const pair = state.remaining.splice(idx, 1)[0];
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
  const grouping = window.OldPragueGrouping;
  state.resolveGroupId = grouping.buildMergeResolver(
    state.groupIds,
    state.decisions,
  );
  buildDecisionMap();
  const groupIndex = grouping.buildGroups(state.features, state.resolveGroupId);
  state.groups = groupIndex.groups;
  state.groupById = groupIndex.groupById;
  state.groupByXid = groupIndex.groupByXid;
  buildCandidates();
  pickNext();
}

async function submitDecision(verdict) {
  if (!state.currentPair) return;
  if (!state.turnstileToken && !state.turnstileBypass) {
    setStatus("Dokončete Turnstile kontrolu.", "error");
    return;
  }

  clearStatus();

  const payload = {
    group_id_a: state.currentPair.groupA.id,
    group_id_b: state.currentPair.groupB.id,
    verdict,
    token: state.turnstileToken || "",
  };

  try {
    const response = await fetch("/api/merges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Odeslání selhalo");
    }

    state.decisions.push(payload);
    const key = pairKey(payload.group_id_a, payload.group_id_b);
    if (key) state.decisionsByPair.set(key, verdict);

    setStatus("Uloženo.", "success");
    state.turnstileToken = "";
    if (state.turnstileWidgetId !== null && window.turnstile) {
      window.turnstile.reset(state.turnstileWidgetId);
    }
    updateActionState();
    rebuildPairs();
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
  }
}

function renderTurnstile() {
  if (state.turnstileBypass) {
    if (turnstileNote) {
      turnstileNote.textContent = "Turnstile je vypnutý pro lokální vývoj.";
    }
    updateActionState();
    return;
  }

  if (!state.turnstileReady || !state.turnstileSiteKey) {
    if (turnstileNote && !state.turnstileSiteKey) {
      turnstileNote.textContent = "Chybí Turnstile klíč.";
    }
    return;
  }

  if (state.turnstileWidgetId !== null) return;

  state.turnstileWidgetId = window.turnstile.render("#review-turnstile", {
    sitekey: state.turnstileSiteKey,
    callback: (token) => {
      state.turnstileToken = token;
      updateActionState();
    },
    "expired-callback": () => {
      state.turnstileToken = "";
      updateActionState();
    },
    "error-callback": () => {
      state.turnstileToken = "";
      updateActionState();
    },
  });
}

window.turnstileOnload = () => {
  state.turnstileReady = true;
  renderTurnstile();
};

async function bootstrap() {
  const config = await fetchJson("/api/config").catch(() => ({}));
  state.turnstileSiteKey = config.turnstileSiteKey || "";
  state.turnstileBypass = Boolean(config.turnstileBypass);
  state.archiveBaseUrl = config.archiveBaseUrl || "";

  const photos = await fetchJson("/data/photos.geojson");
  state.features = photos.features || [];

  const mergeData = await fetchJson("/api/merges").catch(() => ({ items: [] }));
  state.decisions = mergeData.items || [];

  const grouping = window.OldPragueGrouping;
  const { map: groupIdByXid, groupIds } = grouping.buildGroupIdByXid(state.features);
  state.groupIdByXid = groupIdByXid;
  state.groupIds = groupIds;
  state.resolveGroupId = grouping.buildMergeResolver(groupIds, state.decisions);
  buildDecisionMap();

  const corrections = await fetchJson("/api/corrections").catch(() => ({
    items: [],
  }));
  grouping.applyCorrections(
    state.features,
    corrections.items || [],
    groupIdByXid,
    state.resolveGroupId,
  );

  const groupIndex = grouping.buildGroups(state.features, state.resolveGroupId);
  state.groups = groupIndex.groups;
  state.groupById = groupIndex.groupById;
  state.groupByXid = groupIndex.groupByXid;

  buildCandidates();
  pickNext();
  renderTurnstile();
}

if (skipBtn) skipBtn.addEventListener("click", () => pickNext());
if (prevBtn) prevBtn.addEventListener("click", () => pickPrev());
if (sameBtn) sameBtn.addEventListener("click", () => submitDecision("same"));
if (differentBtn)
  differentBtn.addEventListener("click", () => submitDecision("different"));

bootstrap().catch((error) => {
  setStatus("Nepodařilo se načíst data.", "error");
  console.error(error);
});
