const state = {
  allGroups: [],
  groups: [],
  groupById: new Map(),
  currentIndex: 0,
  currentGroup: null,
  currentFeature: null,
  archiveBaseUrl: "",
  versionClustersBySeries: new Map(),
  versionClusterByXid: new Map(),
  voteStateByGroup: new Map(),
  reviewedGroupIds: new Set(),
  scanIndexByXid: new Map(),
  submittingVote: false,
  voteStateReady: false,
  candidateTotal: 0,
  candidateNextCursor: "0",
  loadingCandidates: false,
  r2TilesBase: "",
  stripGroupId: "",
  sessionVotes: 0,
};

const REVIEWED_GROUPS_STORAGE_KEY = "old-prague-group-review-reviewed";
const REQUIRED_OK_VOTES = 2;

const sessionCountEl = document.getElementById("session-count");
const captionEl = document.getElementById("group-caption");
const groupStripEl = document.getElementById("group-strip");
const currentGroupEl = document.getElementById("current-group");
const groupSummaryEl = document.getElementById("group-summary");
const statusEl = document.getElementById("group-status");
const prevBtn = document.getElementById("prev-group");
const nextBtn = document.getElementById("next-group");
const actionTextEl = document.getElementById("group-action-text");
const markOkBtn = document.getElementById("group-mark-ok");
const markSplitBtn = document.getElementById("group-mark-split");
const openDedupeBtn = document.getElementById("group-open-dedupe");
const archiveLinkEl = document.getElementById("group-archive-link");
const resetProgressBtn = document.getElementById("reset-group-progress");
const detailsEl = document.getElementById("group-details");
const zoomWrap = document.getElementById("group-zoom")?.closest(".zoom-wrap");
const zoomViewerEl = document.getElementById("group-zoom");
const previewImgEl = document.getElementById("group-preview");
let statusClearTimer = null;

const zoomState = {
  viewer: null,
  lastKey: null,
  viewerEl: zoomViewerEl,
  wrapEl: zoomWrap,
  previewImgEl,
};

function clearGroupEvidence() {
  state.currentGroup = null;
  state.currentFeature = null;
  zoomState.lastKey = null;
  if (zoomState.viewer && typeof zoomState.viewer.close === "function") {
    zoomState.viewer.close();
  }
  zoomState.wrapEl?.classList.remove("is-fallback", "is-loading", "is-unavailable");
  if (previewImgEl) previewImgEl.removeAttribute("src");
  detailsEl?.replaceChildren();
  if (captionEl) captionEl.textContent = "";
  if (groupStripEl) {
    groupStripEl.replaceChildren();
    groupStripEl.hidden = true;
  }
  state.stripGroupId = "";
  if (groupSummaryEl) {
    groupSummaryEl.textContent = "Skupina: —";
    groupSummaryEl.title = "";
  }
  if (actionTextEl) actionTextEl.textContent = "Není vybraná žádná skupina.";
  if (archiveLinkEl) {
    archiveLinkEl.href = "#";
    archiveLinkEl.classList.add("is-disabled");
  }
  updateCounts();
}

function normalizeGroupValue(value) {
  return String(value || "").trim();
}

function clearStatusElement() {
  if (!statusEl) return;
  statusEl.textContent = "";
  statusEl.dataset.tone = "";
}

function setStatus(message, tone = "", options = {}) {
  if (statusClearTimer !== null) {
    window.clearTimeout(statusClearTimer);
    statusClearTimer = null;
  }
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
  const clearAfter = Number(options.clearAfter) || 0;
  if (clearAfter > 0) {
    statusClearTimer = window.setTimeout(() => {
      statusClearTimer = null;
      clearStatusElement();
    }, clearAfter);
  }
}

function clearStatus(options = {}) {
  if (statusClearTimer !== null && !options.force) return;
  if (statusClearTimer !== null) {
    window.clearTimeout(statusClearTimer);
    statusClearTimer = null;
  }
  clearStatusElement();
}

function shortId(value) {
  if (!value) return "—";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function buildDedupeUrl(groupId) {
  const url = new URL("./dup-review.html", window.location.href);
  url.searchParams.set("mode", "dedupe");
  if (groupId) {
    url.searchParams.set("group_id", groupId);
  }
  return url.toString();
}

function updateCounts() {
  const currentVoteState = getVoteState(state.currentGroup?.id || "");
  // Show what the visitor has done, not the size of the whole backlog.
  if (sessionCountEl) {
    sessionCountEl.textContent = state.sessionVotes.toLocaleString("cs-CZ");
  }
  if (currentGroupEl) {
    currentGroupEl.textContent = state.currentGroup?.id
      ? shortId(state.currentGroup.id)
      : "—";
    currentGroupEl.title = state.currentGroup?.id || "";
  }
  const interactionLocked = state.submittingVote || !state.voteStateReady;
  if (prevBtn) prevBtn.disabled = interactionLocked || state.currentIndex <= 0;
  if (nextBtn) {
    nextBtn.disabled =
      interactionLocked ||
      (state.currentIndex >= state.groups.length - 1 && !state.candidateNextCursor);
  }
  if (markOkBtn) {
    markOkBtn.disabled =
      !state.currentGroup ||
      interactionLocked ||
      Boolean(currentVoteState?.current_user_voted);
  }
  if (markSplitBtn) {
    markSplitBtn.disabled =
      !state.currentGroup ||
      interactionLocked ||
      Boolean(currentVoteState?.current_user_voted);
  }
  if (openDedupeBtn) {
    openDedupeBtn.disabled = interactionLocked || !state.currentGroup;
  }
  if (resetProgressBtn) resetProgressBtn.disabled = interactionLocked;
  if (archiveLinkEl) archiveLinkEl.classList.toggle("is-disabled", !state.currentFeature);
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

function registerVersionClusters(group) {
  const clusters = Array.isArray(group?.version_clusters)
    ? group.version_clusters
    : [];
  if (!group?.id || !clusters.length) return;
  const normalized = clusters.map((cluster) => ({
    series_id: group.id,
    version_id: String(cluster?.version_id || "").trim(),
    xids: Array.isArray(cluster?.xids)
      ? cluster.xids.map((xid) => String(xid || "").trim()).filter(Boolean)
      : [],
    representative_xid: cluster?.representative_xid || "",
    max_distance: cluster?.max_distance ?? null,
  })).filter((cluster) => cluster.xids.length > 0);
  normalized.sort((left, right) =>
    left.version_id.localeCompare(right.version_id, "cs")
  );
  state.versionClustersBySeries.set(group.id, normalized);
  normalized.forEach((cluster) => {
    cluster.xids.forEach((xid) => state.versionClusterByXid.set(xid, cluster));
  });
}

async function loadNextGroupPage({ reset = false } = {}) {
  if (state.loadingCandidates) return false;
  const cursor = reset ? "0" : state.candidateNextCursor;
  if (cursor === null) return false;
  state.loadingCandidates = true;
  updateCounts();
  try {
    let payload;
    try {
      payload = await fetchJson(
        `/api/community-candidates?flow=group&cursor=${encodeURIComponent(cursor)}&limit=40`,
      );
    } catch (error) {
      if (error?.status === 409 && !reset) {
        state.loadingCandidates = false;
        return loadNextGroupPage({ reset: true });
      }
      throw error;
    }
    if (reset) {
      state.allGroups = [];
      state.versionClustersBySeries = new Map();
      state.versionClusterByXid = new Map();
    }
    const knownIds = new Set(state.allGroups.map((group) => group.id));
    (Array.isArray(payload?.items) ? payload.items : []).forEach((group) => {
      if (!group?.id || knownIds.has(group.id)) return;
      knownIds.add(group.id);
      registerVersionClusters(group);
      state.allGroups.push(group);
    });
    state.candidateTotal = Number(payload?.total) || 0;
    state.candidateNextCursor = payload?.nextCursor ?? null;
    rebuildPendingGroups();
    return true;
  } finally {
    state.loadingCandidates = false;
    updateCounts();
  }
}

async function loadUntilPendingGroup({ reset = false } = {}) {
  let loaded = await loadNextGroupPage({ reset });
  while (!state.groups.length && state.candidateNextCursor) {
    loaded = (await loadNextGroupPage()) || loaded;
  }
  return loaded;
}

async function loadZoomifyMeta(xid, scanIndex) {
  const url = `/api/zoomify?xid=${encodeURIComponent(xid)}&scanIndex=${encodeURIComponent(
    String(scanIndex || 0),
  )}`;
  return fetchJson(url);
}

async function loadPreviewUrl(xid) {
  if (!xid) return "";
  const payload = await fetchJson(`/api/preview-url?xid=${encodeURIComponent(xid)}`);
  return String(payload?.url || "");
}

function getArchiveUrl(xid, scanIndex) {
  if (!state.archiveBaseUrl || !xid) return "";
  const scanParam = Number.isFinite(scanIndex) ? scanIndex + 1 : 1;
  return `${state.archiveBaseUrl.replace(/\/$/, "")}/permalink?xid=${encodeURIComponent(
    xid,
  )}&scan=${scanParam}#scan${scanParam}`;
}

function buildZoomKey(xid, scanIndex) {
  return `${xid || ""}::${scanIndex ?? 0}`;
}

async function loadZoomifyInto(target, xid, scanIndex) {
  if (!target.viewerEl || !target.wrapEl) return;
  const key = buildZoomKey(xid, scanIndex);
  if (target.lastKey === key) return;
  target.lastKey = key;
  target.wrapEl.classList.remove("is-fallback");
  target.wrapEl.classList.add("is-loading");
  const reveal = () => {
    if (target.lastKey === key) target.wrapEl.classList.remove("is-loading");
  };
  if (target.previewImgEl) {
    target.previewImgEl.removeAttribute("src");
  }

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
          "/vendor/openseadragon/images/",
        showNavigator: true,
        maxZoomPixelRatio: 2,
      });
      window.OldPragueZoomify?.styleControls?.(target.viewer);
    }

    if (!window.OldPragueZoomify?.createTileSource) {
      throw new Error("Chybí helper pro Zoomify");
    }
    if (target.lastKey !== key) return;
    target.viewer.addOnceHandler("tile-drawn", reveal);
    target.viewer.addOnceHandler("open-failed", reveal);
    target.viewer.open(window.OldPragueZoomify.createTileSource(meta));
  } catch (error) {
    if (target.lastKey !== key) return;
    console.warn("Zoom náhled selhal", error);
    reveal();
    if (target.previewImgEl) {
      try {
        const previewUrl = await loadPreviewUrl(xid);
        if (target.lastKey !== key) return;
        target.previewImgEl.src = previewUrl;
      } catch (previewError) {
        if (target.lastKey !== key) return;
        target.previewImgEl.src = "";
      }
    }
    target.wrapEl.classList.add("is-fallback");
  }
}

function loadReviewedGroupIds() {
  try {
    const raw = window.localStorage.getItem(REVIEWED_GROUPS_STORAGE_KEY) || "";
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((value) => normalizeGroupValue(value)).filter(Boolean));
  } catch (error) {
    return new Set();
  }
}

function saveReviewedGroupIds() {
  try {
    window.localStorage.setItem(
      REVIEWED_GROUPS_STORAGE_KEY,
      JSON.stringify(Array.from(state.reviewedGroupIds)),
    );
    return true;
  } catch (error) {
    console.warn("Lokální průběh kontroly se nepodařilo uložit", error);
    return false;
  }
}

function getVoteState(groupId) {
  const normalized = normalizeGroupValue(groupId);
  return normalized ? state.voteStateByGroup.get(normalized) || null : null;
}

function isGroupDone(groupId) {
  return Boolean(getVoteState(groupId)?.done);
}

function countCommunityPendingGroups() {
  return state.allGroups.filter((group) => group?.id && !isGroupDone(group.id)).length;
}

function applyGroupReviewVoteState(payload) {
  const next = new Map();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  items.forEach((item) => {
    const groupId = normalizeGroupValue(item?.group_id);
    if (!groupId) return;
    next.set(groupId, {
      group_id: groupId,
      ok_votes: Number(item?.ok_votes) || 0,
      required_ok_votes: Number(item?.required_ok_votes) || REQUIRED_OK_VOTES,
      split_votes: Number(item?.split_votes) || 0,
      required_split_votes: Number(item?.required_split_votes) || 2,
      done: Boolean(item?.done),
      needs_split: Boolean(item?.needs_split),
      current_user_voted: Boolean(item?.current_user_voted),
      current_user_verdict: item?.current_user_verdict || null,
      current_user_vote_at: item?.current_user_vote_at || null,
      last_vote_at: item?.last_vote_at || null,
    });
  });
  state.voteStateByGroup = next;
}

function rebuildPendingGroups() {
  state.groups = state.allGroups.filter(
    (group) =>
      group?.id &&
      !state.reviewedGroupIds.has(group.id) &&
      !isGroupDone(group.id),
  );
  state.groupById = new Map(state.groups.map((group) => [group.id, group]));
}

async function refreshGroupReviewVoteState() {
  const payload = await fetchJson("/api/group-review-votes");
  applyGroupReviewVoteState(payload);
  state.voteStateReady = true;
}

async function submitGroupReviewVoteRequest(payload) {
  const sendRequest = () =>
    fetch("/api/group-review-votes", {
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

function renderDetails(group, feature) {
  if (!detailsEl || !window.OldPragueMeta?.renderDetails) return;
  const groupId = group?.id;
  const versionClusters = groupId
    ? state.versionClustersBySeries.get(groupId) || []
    : [];
  const selectedId = feature?.properties?.id || "";
  const activeCluster = state.versionClusterByXid.get(selectedId);
  const scanIndex = getScanIndex(selectedId);
  window.OldPragueMeta.renderDetails(detailsEl, feature, state.archiveBaseUrl, {
    groupItems: group?.items || [],
    // The caption and the contact sheet above already cover these.
    omitDescription: Boolean(captionEl),
    showGroupItems: !groupStripEl,
    showCorrectionScope: false,
    selectedId,
    versionClusters,
    selectedVersionId: activeCluster?.version_id || "",
    selectedScanIndex: scanIndex,
    onSelectVersion: (xid) => {
      const nextFeature = group?.items?.find(
        (item) => item?.properties?.id === xid,
      );
      if (nextFeature) {
        setFeature(group, nextFeature);
      }
    },
    onSelectScan: (nextScan) => {
      setScanIndex(selectedId, nextScan);
      setFeature(group, feature);
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

function renderActionHint(group) {
  if (!actionTextEl) return;
  if (!group?.id) {
    actionTextEl.textContent = "";
    return;
  }
  const voteState = getVoteState(group.id);
  if (voteState?.current_user_voted) {
    const choice = voteState.current_user_verdict === "split"
      ? "že skupina míchá různé fotografie"
      : "že skupina je správně";
    actionTextEl.textContent = `U této skupiny už máte uložený hlas ${choice}.`;
    return;
  }
  actionTextEl.textContent = "Nejste si jistí?";
}

function getThumbnailSources(feature) {
  const props = feature?.properties || {};
  const xid = String(props.id || "").trim();
  const sources = [];
  if (state.r2TilesBase && xid) {
    const base = `${state.r2TilesBase}/${encodeURIComponent(xid)}/scan_0/TileGroup0`;
    sources.push(`${base}/1-0-0.jpg`, `${base}/0-0-0.jpg`);
  }
  const zoomifyPath = Array.isArray(props.scan_zoomify_paths)
    ? props.scan_zoomify_paths.find((item) => typeof item === "string" && item.trim())
    : "";
  if (zoomifyPath) {
    sources.push(`${zoomifyPath.trim().replace(/\/$/, "")}/TileGroup0/1-0-0.jpg`);
  }
  if (Array.isArray(props.scan_previews) && props.scan_previews[0]) {
    sources.push(String(props.scan_previews[0]));
  }
  return sources;
}

function renderGroupStrip(group) {
  if (!groupStripEl) return;
  const items = Array.isArray(group?.items) ? group.items : [];
  if (state.stripGroupId === group?.id) return;
  state.stripGroupId = group?.id || "";
  groupStripEl.replaceChildren();
  groupStripEl.hidden = items.length < 2;

  items.forEach((item, index) => {
    const props = item?.properties || {};
    const xid = String(props.id || "");
    if (!xid) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "group-thumb";
    button.dataset.xid = xid;
    button.title = props.description || "";

    const media = document.createElement("span");
    media.className = "group-thumb-media";
    const image = document.createElement("img");
    image.alt = `Fotografie ${index + 1}`;
    image.loading = "lazy";
    const sources = getThumbnailSources(item);
    let sourceIndex = 0;
    const tryNextSource = () => {
      if (sourceIndex < sources.length) {
        image.src = sources[sourceIndex];
        sourceIndex += 1;
        return;
      }
      image.remove();
      media.textContent = "Bez náhledu";
    };
    image.addEventListener("error", tryNextSource);
    media.appendChild(image);
    tryNextSource();

    const label = document.createElement("span");
    label.className = "group-thumb-label";
    label.textContent =
      [props.date_label, props.signature].filter(Boolean).join(" · ") ||
      `Fotografie ${index + 1}`;

    button.append(media, label);
    button.addEventListener("click", () => setFeature(group, item));
    groupStripEl.appendChild(button);
  });
}

function markActiveThumb(xid) {
  groupStripEl?.querySelectorAll(".group-thumb").forEach((button) => {
    const active = button.dataset.xid === xid;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setFeature(group, feature) {
  if (!group || !feature) return;
  const xid = feature.properties?.id;
  if (!xid) return;
  state.currentGroup = group;
  state.currentFeature = feature;

  const scanIndex = getScanIndex(xid);
  const url = getArchiveUrl(xid, scanIndex);
  if (archiveLinkEl) {
    archiveLinkEl.href = url || "#";
    archiveLinkEl.classList.toggle("is-disabled", !url);
  }
  loadZoomifyInto(zoomState, xid, scanIndex);
  renderGroupStrip(group);
  markActiveThumb(xid);
  if (captionEl) {
    const props = feature.properties || {};
    const context = [props.date_label, props.author].filter(Boolean).join(" · ");
    captionEl.textContent = [props.description || "Bez popisu", context]
      .filter(Boolean)
      .join(" — ");
  }
  renderDetails(group, feature);

  if (groupSummaryEl) {
    const count = group?.items?.length || 0;
    const voteState = getVoteState(group.id);
    const okVotes = voteState?.ok_votes || 0;
    const requiredVotes = voteState?.required_ok_votes || REQUIRED_OK_VOTES;
    const parts = [
      `Ve skupině ${count === 1 ? "je" : "jsou"} ${window.OldPragueMeta.formatPhotoCount(count)}`,
    ];
    parts.push(
      okVotes ? `potvrzení ${okVotes} z ${requiredVotes}` : "zatím bez potvrzení",
    );
    if (voteState?.split_votes) {
      parts.push(`návrhy na rozdělení: ${voteState.split_votes}`);
    }
    groupSummaryEl.textContent = parts.join(" · ");
    groupSummaryEl.title = group.id;
  }

  renderActionHint(group);
  updateCounts();
}

function showGroup(index) {
  if (!state.groups.length) {
    clearGroupEvidence();
    if (statusClearTimer === null) {
      setStatus(
        !state.allGroups.length
          ? "Žádné skupiny s více fotografiemi."
          : countCommunityPendingGroups() === 0
            ? "Pro tuto chvíli už jsou všechny skupiny odhlasované."
            : "V tomto prohlížeči už nic nezbývá. Dříve prošlé skupiny ukáže tlačítko „Zobrazit znovu prošlé“ dole.",
        "success",
      );
    }
    return;
  }
  const safeIndex = Math.max(0, Math.min(index, state.groups.length - 1));
  state.currentIndex = safeIndex;
  const group = state.groups[safeIndex];
  const feature = group?.primary || group?.items?.[0];
  clearStatus();
  setFeature(group, feature);
}

async function submitCurrentGroupVote(verdict) {
  if (
    !state.currentGroup ||
    state.submittingVote ||
    !state.voteStateReady
  ) return;
  const submittedGroupId = state.currentGroup.id;
  const submittedIndex = state.currentIndex;
  state.submittingVote = true;
  updateCounts();
  clearStatus({ force: true });

  try {
    await submitGroupReviewVoteRequest({
      group_id: submittedGroupId,
      verdict,
    });
    state.reviewedGroupIds.add(submittedGroupId);
    state.sessionVotes += 1;
    saveReviewedGroupIds();
    try {
      await refreshGroupReviewVoteState();
    } catch (refreshError) {
      state.voteStateReady = false;
      setStatus(
        "Hlas je uložený, ale seznam se nepodařilo obnovit. Obnovte stránku.",
        "error",
      );
      return;
    }
    rebuildPendingGroups();
    if (!state.groups.length && state.candidateNextCursor) {
      await loadUntilPendingGroup();
    }
    if (!state.groups.length) {
      showGroup(0);
      setStatus(
        verdict === "split"
          ? "Návrh rozdělit skupinu je uložený. Pro tuto chvíli už nic dalšího nezbývá."
          : "Potvrzení skupiny je uložené. Pro tuto chvíli už nic dalšího nezbývá.",
        "success",
      );
      return;
    }
    setStatus(
      verdict === "split"
        ? "Návrh rozdělit skupinu je uložený. Načítám další skupinu."
        : "Potvrzení skupiny je uložené. Načítám další skupinu.",
      "success",
      { clearAfter: 2600 },
    );
    setTimeout(
      () => showGroup(Math.min(submittedIndex, state.groups.length - 1)),
      180,
    );
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
  } finally {
    state.submittingVote = false;
    updateCounts();
  }
}

function openCurrentGroupInDedupe() {
  if (!state.currentGroup?.id) return;
  window.location.href = buildDedupeUrl(state.currentGroup.id);
}

async function resetLocalProgress() {
  state.reviewedGroupIds.clear();
  saveReviewedGroupIds();
  state.currentIndex = 0;
  await loadUntilPendingGroup({ reset: true });
  showGroup(0);
  setStatus("Lokální filtr byl vymazán.", "success");
}

async function showNextGroup() {
  if (state.currentIndex < state.groups.length - 1) {
    showGroup(state.currentIndex + 1);
    return;
  }
  const currentGroupId = state.currentGroup?.id || "";
  while (state.candidateNextCursor) {
    if (!(await loadNextGroupPage())) break;
    const currentIndex = state.groups.findIndex(
      (group) => group?.id === currentGroupId,
    );
    if (currentIndex < 0 && state.groups.length) {
      showGroup(0);
      return;
    }
    if (currentIndex >= 0 && currentIndex < state.groups.length - 1) {
      showGroup(currentIndex + 1);
      return;
    }
  }
}

async function bootstrap() {
  const config = await fetchJson("/api/config").catch(() => ({}));
  state.archiveBaseUrl = config.archiveBaseUrl || "";
  state.r2TilesBase = String(config.r2TilesBase || "").trim().replace(/\/$/, "");

  state.reviewedGroupIds = loadReviewedGroupIds();
  await refreshGroupReviewVoteState();
  await loadUntilPendingGroup({ reset: true });

  showGroup(0);
}

const REVIEW_SHORTCUTS = {
  a: markOkBtn,
  n: markSplitBtn,
  ArrowRight: nextBtn,
  ArrowLeft: prevBtn,
};

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target.closest?.("input, textarea, select, [contenteditable], .openseadragon-container")) {
    return;
  }
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const button = REVIEW_SHORTCUTS[key];
  if (!button || button.disabled) return;
  event.preventDefault();
  button.click();
});

if (prevBtn) prevBtn.addEventListener("click", () => showGroup(state.currentIndex - 1));
if (nextBtn) nextBtn.addEventListener("click", showNextGroup);
if (markOkBtn) {
  markOkBtn.addEventListener("click", () => submitCurrentGroupVote("ok"));
}
if (markSplitBtn) {
  markSplitBtn.addEventListener("click", () => submitCurrentGroupVote("split"));
}
if (openDedupeBtn) openDedupeBtn.addEventListener("click", openCurrentGroupInDedupe);
if (resetProgressBtn) resetProgressBtn.addEventListener("click", resetLocalProgress);

bootstrap().catch((error) => {
  clearGroupEvidence();
  state.voteStateReady = false;
  updateCounts();
  setStatus("Nepodařilo se načíst data.", "error");
  console.error(error);
});
