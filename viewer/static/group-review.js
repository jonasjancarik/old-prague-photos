const state = {
  features: [],
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
};

const REVIEWED_GROUPS_STORAGE_KEY = "old-prague-group-review-reviewed";
const REQUIRED_OK_VOTES = 2;

const groupCountEl = document.getElementById("group-count");
const remainingCountEl = document.getElementById("remaining-count");
const currentGroupEl = document.getElementById("current-group");
const groupSummaryEl = document.getElementById("group-summary");
const statusEl = document.getElementById("group-status");
const prevBtn = document.getElementById("prev-group");
const nextBtn = document.getElementById("next-group");
const actionTextEl = document.getElementById("group-action-text");
const markOkBtn = document.getElementById("group-mark-ok");
const openDedupeBtn = document.getElementById("group-open-dedupe");
const archiveLinkEl = document.getElementById("group-archive-link");
const resetProgressBtn = document.getElementById("reset-group-progress");
const detailsEl = document.getElementById("group-details");
const zoomWrap = document.getElementById("group-zoom")?.closest(".zoom-wrap");
const zoomViewerEl = document.getElementById("group-zoom");
const previewImgEl = document.getElementById("group-preview");

const zoomState = {
  viewer: null,
  lastKey: null,
  viewerEl: zoomViewerEl,
  wrapEl: zoomWrap,
  previewImgEl,
};

function normalizeGroupValue(value) {
  return String(value || "").trim();
}

function ensureGroupId(feature) {
  if (!feature?.properties) return;
  if (feature.properties.group_id) return;
  const parts = [
    normalizeGroupValue(feature.properties.description),
    normalizeGroupValue(feature.properties.author),
    normalizeGroupValue(feature.properties.date_label),
  ];
  const key = parts.join("\x1f").trim();
  if (key) {
    feature.properties.group_id = key;
  }
}

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
  const total = state.allGroups.length;
  const remaining = state.groups.length
    ? Math.max(0, state.groups.length - state.currentIndex - 1)
    : 0;
  const currentVoteState = getVoteState(state.currentGroup?.id || "");
  if (groupCountEl) {
    groupCountEl.textContent = total ? total.toLocaleString() : "0";
  }
  if (remainingCountEl) {
    remainingCountEl.textContent = remaining ? remaining.toLocaleString() : "0";
  }
  if (currentGroupEl) {
    currentGroupEl.textContent = state.currentGroup?.id
      ? shortId(state.currentGroup.id)
      : "—";
    currentGroupEl.title = state.currentGroup?.id || "";
  }
  if (prevBtn) prevBtn.disabled = state.currentIndex <= 0;
  if (nextBtn) nextBtn.disabled = state.currentIndex >= state.groups.length - 1;
  if (markOkBtn) {
    markOkBtn.disabled =
      !state.currentGroup ||
      state.submittingVote ||
      Boolean(currentVoteState?.current_user_voted);
  }
  if (openDedupeBtn) openDedupeBtn.disabled = !state.currentGroup;
  if (archiveLinkEl) archiveLinkEl.classList.toggle("is-disabled", !state.currentFeature);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Požadavek selhal: ${response.status}`);
  return response.json();
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
  if (target.previewImgEl) {
    target.previewImgEl.src = "";
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
  window.localStorage.setItem(
    REVIEWED_GROUPS_STORAGE_KEY,
    JSON.stringify(Array.from(state.reviewedGroupIds)),
  );
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
      done: Boolean(item?.done),
      current_user_voted: Boolean(item?.current_user_voted),
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
    actionTextEl.textContent = "Zkontrolujte verze/skeny této série a zvolte další krok.";
    return;
  }
  const voteState = getVoteState(group.id);
  if (voteState?.current_user_voted) {
    actionTextEl.textContent = `Pro sérii ${shortId(group.id)} už máte v této relaci aktivní hlas.`;
    return;
  }
  actionTextEl.textContent = `Pokud série míchá různé záběry, otevřete párové porovnání jen pro sérii ${shortId(
    group.id,
  )}.`;
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
  renderDetails(group, feature);

  if (groupSummaryEl) {
    const count = group?.items?.length || 0;
    const versions = state.versionClustersBySeries.get(group.id) || [];
    const voteState = getVoteState(group.id);
    const versionCount = versions.length || count;
    const scanCount = Math.max(
      0,
      ...group.items.map((item) => {
        const props = item?.properties || {};
        const count = Number(props.scan_count) || 0;
        const previews = Array.isArray(props.scan_previews)
          ? props.scan_previews.length
          : 0;
        return Math.max(count, previews);
      }),
    );
    const scanLabel = scanCount > 1 ? ` · ${scanCount} skeny` : "";
    const okVotes = voteState?.ok_votes || 0;
    const requiredVotes = voteState?.required_ok_votes || REQUIRED_OK_VOTES;
    const voteLabel = ` · ${okVotes}/${requiredVotes} hlasů`;
    groupSummaryEl.textContent = `Série ${shortId(
      group.id,
    )} · ${versionCount} verzí${scanLabel}${voteLabel}`;
    groupSummaryEl.title = group.id;
  }

  renderActionHint(group);
  updateCounts();
}

function showGroup(index) {
  if (!state.groups.length) {
    state.currentGroup = null;
    state.currentFeature = null;
    if (groupSummaryEl) {
      groupSummaryEl.textContent = "Série: —";
      groupSummaryEl.title = "";
    }
    if (archiveLinkEl) {
      archiveLinkEl.href = "#";
      archiveLinkEl.classList.add("is-disabled");
    }
    if (previewImgEl) {
      previewImgEl.src = "";
    }
    updateCounts();
    setStatus(
      !state.allGroups.length
        ? "Žádné série s více verzemi."
        : countCommunityPendingGroups() === 0
          ? "Pro tuto chvíli už jsou všechny série odhlasované."
          : "V tomto prohlížeči už nic nezbývá. Tlačítko nahoře znovu ukáže dříve prošlé série.",
      "success",
    );
    return;
  }
  const safeIndex = Math.max(0, Math.min(index, state.groups.length - 1));
  state.currentIndex = safeIndex;
  const group = state.groups[safeIndex];
  const feature = group?.primary || group?.items?.[0];
  clearStatus();
  setFeature(group, feature);
}

async function markCurrentGroupOk() {
  if (!state.currentGroup) return;
  state.submittingVote = true;
  updateCounts();
  clearStatus();

  try {
    await submitGroupReviewVoteRequest({
      group_id: state.currentGroup.id,
      verdict: "ok",
    });
    state.reviewedGroupIds.add(state.currentGroup.id);
    saveReviewedGroupIds();
    await refreshGroupReviewVoteState();
    const nextIndex = state.currentIndex;
    rebuildPendingGroups();
    if (!state.groups.length) {
      showGroup(0);
      return;
    }
    setStatus("Hlas uložen. Přecházím na další sérii.", "success");
    setTimeout(() => showGroup(Math.min(nextIndex, state.groups.length - 1)), 180);
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

function resetLocalProgress() {
  state.reviewedGroupIds.clear();
  saveReviewedGroupIds();
  rebuildPendingGroups();
  showGroup(0);
  setStatus("Lokální filtr byl vymazán.", "success");
}

async function bootstrap() {
  const config = await fetchJson("/api/config").catch(() => ({}));
  state.archiveBaseUrl = config.archiveBaseUrl || "";

  const rawPhotos = await fetchJson("/data/photos.geojson");
  const mediaFilter = window.OldPragueMediaFilter;
  const photos = mediaFilter?.filterPhotoCollection
    ? await mediaFilter.filterPhotoCollection(rawPhotos)
    : rawPhotos;
  state.features = photos.features || [];
  state.features.forEach((feature) => ensureGroupId(feature));

  const clusterData = await fetchJson("/data/series_version_clusters.json").catch(
    () => ({ clusters: [] }),
  );
  const clusters = clusterData.clusters || [];
  const versionClustersBySeries = new Map();
  const versionClusterByXid = new Map();
  clusters.forEach((cluster) => {
    const seriesId = String(cluster?.series_id || "").trim();
    if (!seriesId) return;
    const xids = Array.isArray(cluster?.xids)
      ? cluster.xids.map((xid) => String(xid || "").trim()).filter(Boolean)
      : [];
    if (!xids.length) return;
    const versionId = String(cluster?.version_id || "").trim();
    const normalized = {
      series_id: seriesId,
      version_id: versionId,
      xids,
      representative_xid: cluster?.representative_xid || "",
      max_distance: cluster?.max_distance ?? null,
    };
    if (!versionClustersBySeries.has(seriesId)) {
      versionClustersBySeries.set(seriesId, []);
    }
    versionClustersBySeries.get(seriesId).push(normalized);
    xids.forEach((xid) => {
      if (xid) versionClusterByXid.set(xid, normalized);
    });
  });
  versionClustersBySeries.forEach((items) => {
    items.sort((a, b) => {
      return String(a.version_id || "").localeCompare(
        String(b.version_id || ""),
        "cs",
      );
    });
  });
  state.versionClustersBySeries = versionClustersBySeries;
  state.versionClusterByXid = versionClusterByXid;

  const grouping = window.OldPragueGrouping;
  const groupIndex = grouping.buildGroups(state.features);
  state.allGroups = groupIndex.groups.filter((group) => group?.items?.length > 1);
  state.reviewedGroupIds = loadReviewedGroupIds();
  await refreshGroupReviewVoteState();
  rebuildPendingGroups();

  showGroup(0);
}

if (prevBtn) prevBtn.addEventListener("click", () => showGroup(state.currentIndex - 1));
if (nextBtn) nextBtn.addEventListener("click", () => showGroup(state.currentIndex + 1));
if (markOkBtn) markOkBtn.addEventListener("click", markCurrentGroupOk);
if (openDedupeBtn) openDedupeBtn.addEventListener("click", openCurrentGroupInDedupe);
if (resetProgressBtn) resetProgressBtn.addEventListener("click", resetLocalProgress);

bootstrap().catch((error) => {
  setStatus("Nepodařilo se načíst data.", "error");
  console.error(error);
});
