const state = {
  features: [],
  groups: [],
  groupById: new Map(),
  currentIndex: 0,
  currentGroup: null,
  currentFeature: null,
  archiveBaseUrl: "",
  versionClustersBySeries: new Map(),
  versionClusterByXid: new Map(),
  scanIndexByXid: new Map(),
};

const groupCountEl = document.getElementById("group-count");
const remainingCountEl = document.getElementById("remaining-count");
const currentGroupEl = document.getElementById("current-group");
const groupSummaryEl = document.getElementById("group-summary");
const statusEl = document.getElementById("group-status");
const prevBtn = document.getElementById("prev-group");
const nextBtn = document.getElementById("next-group");
const detailsEl = document.getElementById("group-details");
const zoomWrap = document.getElementById("group-iframe")?.closest(".zoom-wrap");
const zoomViewerEl = document.getElementById("group-zoom");
const iframeEl = document.getElementById("group-iframe");

const zoomState = {
  viewer: null,
  lastKey: null,
  viewerEl: zoomViewerEl,
  wrapEl: zoomWrap,
  iframeEl,
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

function updateCounts() {
  const total = state.groups.length;
  const remaining = Math.max(0, total - state.currentIndex - 1);
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
  if (nextBtn) nextBtn.disabled = state.currentIndex >= total - 1;
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

function setFeature(group, feature) {
  if (!group || !feature) return;
  const xid = feature.properties?.id;
  if (!xid) return;
  state.currentGroup = group;
  state.currentFeature = feature;

  const scanIndex = getScanIndex(xid);
  const url = getArchiveUrl(xid, scanIndex);
  if (iframeEl) iframeEl.src = url;
  loadZoomifyInto(zoomState, xid, scanIndex);
  renderDetails(group, feature);

  if (groupSummaryEl) {
    const count = group?.items?.length || 0;
    const versions = state.versionClustersBySeries.get(group.id) || [];
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
    groupSummaryEl.textContent = `Série ${shortId(
      group.id,
    )} · ${versionCount} verzí${scanLabel}`;
    groupSummaryEl.title = group.id;
  }

  updateCounts();
}

function showGroup(index) {
  if (!state.groups.length) {
    setStatus("Žádné série s více verzemi.", "success");
    return;
  }
  const safeIndex = Math.max(0, Math.min(index, state.groups.length - 1));
  state.currentIndex = safeIndex;
  const group = state.groups[safeIndex];
  const feature = group?.primary || group?.items?.[0];
  clearStatus();
  setFeature(group, feature);
}

async function bootstrap() {
  const config = await fetchJson("/api/config").catch(() => ({}));
  state.archiveBaseUrl = config.archiveBaseUrl || "";

  const photos = await fetchJson("/data/photos.geojson");
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
  state.groups = groupIndex.groups.filter((group) => group?.items?.length > 1);
  state.groupById = groupIndex.groupById;

  showGroup(0);
}

if (prevBtn) prevBtn.addEventListener("click", () => showGroup(state.currentIndex - 1));
if (nextBtn) nextBtn.addEventListener("click", () => showGroup(state.currentIndex + 1));

bootstrap().catch((error) => {
  setStatus("Nepodařilo se načíst data.", "error");
  console.error(error);
});
