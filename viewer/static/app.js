// MAPY_CZ_API_KEY is defined in correction-ui.js

const state = {
  map: null,
  cluster: null,
  selectedGroup: null,
  selectedFeature: null,
  archiveBaseUrl: "",
  turnstileSiteKey: "",
  turnstileBypass: false,
  turnstileReady: false,
  turnstileWidgetId: null,
  turnstileToken: "",
  featuresById: new Map(),
  groupById: new Map(),
  groupByXid: new Map(),
  groupIdByXid: new Map(),
  resolveGroupId: (id) => id,
  correctionsByGroup: new Map(),
  overlapCluster: null,
  clusteringEnabled: true,
  correctionLat: null,
  correctionLon: null,
  correctionMap: null,
  correctionMarker: null,
  features: [],
  groups: [],
  filteredGroups: [],
  yearMin: null,
  yearMax: null,
  yearFilterMin: null,
  yearFilterMax: null,
  yearUnknownGroups: 0,
  yearIncludeUnknown: true,
  previewPopup: null,
  previewByXid: new Map(),
  previewPromiseByXid: new Map(),
  previewHoverToken: 0,
  previewHideTimer: null,
  previewActiveXid: "",
};

const detailContainer = document.getElementById("photo-details");
const photoCount = document.getElementById("photo-count");
const feedbackForm = document.getElementById("feedback-form");
const formStatus = document.getElementById("form-status");
const turnstileNote = document.getElementById("turnstile-note");
const archiveModal = document.getElementById("archive-modal");
const archiveIframe = document.getElementById("archive-iframe");
const archiveFallback = document.getElementById("archive-fallback");
const zoomWrap = archiveIframe?.closest(".zoom-wrap");
const zoomViewerEl = document.getElementById("zoom-viewer");
const reportCta = document.getElementById("report-cta");
const reportCtaWrap = document.getElementById("report-cta-container");
const correctionMapEl = document.getElementById("correction-map");
const cancelCorrectionBtn = document.getElementById("cancel-correction");
const metaView = document.getElementById("modal-meta-view");
const correctionView = document.getElementById("modal-correction-view");
const yearMinInput = document.getElementById("year-min");
const yearMaxInput = document.getElementById("year-max");
const yearRangeLabel = document.getElementById("year-range-label");
const yearMinValue = document.getElementById("year-min-value");
const yearMaxValue = document.getElementById("year-max-value");
const yearSliderWrap = document.getElementById("year-slider-wrap");
const yearUnknownToggle = document.getElementById("year-unknown-toggle");
const yearUnknownCount = document.getElementById("year-unknown-count");
const yearUnknownToggleWrap = yearUnknownToggle?.closest(".year-filter-toggle");
const YEAR_SLIDER_EDGE_PX = 9;

const infoModal = document.getElementById("info-modal");
const infoOpenBtn = document.getElementById("info-open");

const correctionLatInput = feedbackForm?.querySelector(
  "input[name='correction_lat']",
);
const correctionLonInput = feedbackForm?.querySelector(
  "input[name='correction_lon']",
);

const pragueFallback = [50.0755, 14.4378];

function setStatus(message, tone = "") {
  formStatus.textContent = message;
  formStatus.dataset.tone = tone;
}

function clearStatus() {
  formStatus.textContent = "";
  formStatus.dataset.tone = "";
}

function updatePhotoCount(filteredCount) {
  if (!photoCount) return;
  const totalCount = Array.isArray(state.groups) ? state.groups.length : 0;
  if (!totalCount) {
    photoCount.textContent = "—";
    return;
  }
  const visibleCount = Number.isFinite(filteredCount)
    ? filteredCount
    : totalCount;
  if (visibleCount === totalCount) {
    photoCount.textContent = totalCount.toLocaleString();
    return;
  }
  photoCount.textContent = `${visibleCount.toLocaleString()} / ${totalCount.toLocaleString()}`;
}

function parseYear(value) {
  if (!value) return null;
  const match = String(value).match(/\d{4}/);
  if (!match) return null;
  const year = Number(match[0]);
  return Number.isFinite(year) ? year : null;
}

function getFeatureYearRange(feature) {
  const props = feature?.properties || {};
  const years = [];
  const start = parseYear(props.start_date);
  const end = parseYear(props.end_date);
  if (Number.isFinite(start)) years.push(start);
  if (Number.isFinite(end)) years.push(end);

  if (!years.length) {
    const label = String(props.date_label || "");
    const matches = label.match(/\d{4}/g);
    if (matches) {
      matches.forEach((match) => {
        const year = Number(match);
        if (Number.isFinite(year)) years.push(year);
      });
    }
  }

  if (!years.length) return null;
  let min = years[0];
  let max = years[0];
  years.forEach((year) => {
    if (year < min) min = year;
    if (year > max) max = year;
  });
  return { min, max };
}

function getGroupYearRange(group) {
  if (!group?.items?.length) return null;
  let minYear = Infinity;
  let maxYear = -Infinity;
  let hasYear = false;

  group.items.forEach((feature) => {
    const range = getFeatureYearRange(feature);
    if (!range) return;
    hasYear = true;
    if (range.min < minYear) minYear = range.min;
    if (range.max > maxYear) maxYear = range.max;
  });

  if (!hasYear) return null;
  return { min: minYear, max: maxYear };
}

function computeGroupYearStats(groups) {
  let minYear = Infinity;
  let maxYear = -Infinity;
  let unknownGroups = 0;

  (groups || []).forEach((group) => {
    const range = getGroupYearRange(group);
    if (!range) {
      group.yearMin = null;
      group.yearMax = null;
      unknownGroups += 1;
      return;
    }
    group.yearMin = range.min;
    group.yearMax = range.max;
    if (range.min < minYear) minYear = range.min;
    if (range.max > maxYear) maxYear = range.max;
  });

  if (!Number.isFinite(minYear) || !Number.isFinite(maxYear)) {
    return null;
  }
  return { minYear, maxYear, unknownGroups };
}

function updateYearRangeUi() {
  const minYear = state.yearFilterMin;
  const maxYear = state.yearFilterMax;
  const hasRange = Number.isFinite(minYear) && Number.isFinite(maxYear);
  if (yearRangeLabel) {
    yearRangeLabel.textContent = hasRange ? `${minYear}-${maxYear}` : "—";
  }
  if (yearMinValue) yearMinValue.textContent = hasRange ? String(minYear) : "—";
  if (yearMaxValue) yearMaxValue.textContent = hasRange ? String(maxYear) : "—";
}

function updateYearSliderTrack() {
  if (!yearSliderWrap) return;
  const minYear = state.yearMin;
  const maxYear = state.yearMax;
  const valueMin = state.yearFilterMin;
  const valueMax = state.yearFilterMax;
  if (
    !Number.isFinite(minYear) ||
    !Number.isFinite(maxYear) ||
    !Number.isFinite(valueMin) ||
    !Number.isFinite(valueMax) ||
    maxYear <= minYear
  ) {
    return;
  }
  const range = maxYear - minYear;
  const startRatio = (valueMin - minYear) / range;
  const endRatio = (valueMax - minYear) / range;
  const start = startRatio * 100;
  const end = endRatio * 100;
  yearSliderWrap.style.setProperty("--range-start", `${start}%`);
  yearSliderWrap.style.setProperty("--range-end", `${end}%`);

  const wrapRect = yearSliderWrap.getBoundingClientRect();
  const usableWidth = Math.max(0, wrapRect.width - YEAR_SLIDER_EDGE_PX * 2);
  const startPx = YEAR_SLIDER_EDGE_PX + usableWidth * startRatio;
  const endPx = YEAR_SLIDER_EDGE_PX + usableWidth * endRatio;
  yearSliderWrap.style.setProperty("--range-start-px", `${startPx}px`);
  yearSliderWrap.style.setProperty("--range-end-px", `${endPx}px`);
}

function updateYearSliderZ() {
  if (!yearMinInput || !yearMaxInput) return;
  const minValue = Number(yearMinInput.value);
  const maxValue = Number(yearMaxInput.value);
  if (minValue >= maxValue) {
    yearMinInput.style.zIndex = "4";
    yearMaxInput.style.zIndex = "3";
    return;
  }
  yearMinInput.style.zIndex = "2";
  yearMaxInput.style.zIndex = "3";
}

function filterGroupsByYear(groups, minYear, maxYear) {
  if (!Array.isArray(groups)) return [];
  if (!Number.isFinite(minYear) || !Number.isFinite(maxYear)) {
    return groups;
  }

  return groups.filter((group) => {
    const groupMin = group?.yearMin;
    const groupMax = group?.yearMax;
    if (!Number.isFinite(groupMin) || !Number.isFinite(groupMax)) {
      return state.yearIncludeUnknown;
    }
    return groupMax >= minYear && groupMin <= maxYear;
  });
}

function applyYearFilter(options = {}) {
  const { fitBounds = false } = options;
  if (!Array.isArray(state.groups) || !state.groups.length) {
    state.filteredGroups = [];
    updatePhotoCount(0);
    return;
  }
  const minYear = state.yearFilterMin;
  const maxYear = state.yearFilterMax;
  const filtered = filterGroupsByYear(state.groups, minYear, maxYear);
  state.filteredGroups = filtered;
  addMarkers(filtered, { fitBounds });
  updatePhotoCount(filtered.length);
}

let yearFilterTimer = null;
const YEAR_FILTER_DEBOUNCE_MS = 500;

function scheduleYearFilter() {
  if (yearFilterTimer) clearTimeout(yearFilterTimer);
  yearFilterTimer = setTimeout(() => {
    yearFilterTimer = null;
    applyYearFilter({ fitBounds: false });
  }, YEAR_FILTER_DEBOUNCE_MS);
}

function flushYearFilter() {
  if (yearFilterTimer) {
    clearTimeout(yearFilterTimer);
    yearFilterTimer = null;
  }
  applyYearFilter({ fitBounds: false });
}

function handleYearInput(source, options = {}) {
  if (!yearMinInput || !yearMaxInput) return;
  const { flush = false } = options;
  let minValue = Number(yearMinInput.value);
  let maxValue = Number(yearMaxInput.value);
  if (minValue > maxValue) {
    if (source === "min") {
      maxValue = minValue;
      yearMaxInput.value = String(maxValue);
    } else {
      minValue = maxValue;
      yearMinInput.value = String(minValue);
    }
  }
  state.yearFilterMin = minValue;
  state.yearFilterMax = maxValue;
  updateYearRangeUi();
  updateYearSliderTrack();
  updateYearSliderZ();
  if (flush) {
    flushYearFilter();
  } else {
    scheduleYearFilter();
  }
}

function getYearFromClientX(clientX) {
  if (!yearSliderWrap) return null;
  if (!Number.isFinite(state.yearMin) || !Number.isFinite(state.yearMax)) {
    return null;
  }
  const rect = yearSliderWrap.getBoundingClientRect();
  if (!rect.width) return null;
  const usableWidth = Math.max(0, rect.width - YEAR_SLIDER_EDGE_PX * 2);
  if (!usableWidth) return null;
  const ratio = (clientX - rect.left - YEAR_SLIDER_EDGE_PX) / usableWidth;
  const clamped = Math.min(1, Math.max(0, ratio));
  const year = Math.round(
    state.yearMin + clamped * (state.yearMax - state.yearMin),
  );
  return Number.isFinite(year) ? year : null;
}

function initYearFilter() {
  state.filteredGroups = state.groups;
  const stats = computeGroupYearStats(state.groups);
  if (!yearMinInput || !yearMaxInput || !stats) {
    addMarkers(state.groups);
    updatePhotoCount(state.groups.length);
    return;
  }

  state.yearMin = stats.minYear;
  state.yearMax = stats.maxYear;
  state.yearFilterMin = stats.minYear;
  state.yearFilterMax = stats.maxYear;
  state.yearUnknownGroups = stats.unknownGroups;

  yearMinInput.min = String(stats.minYear);
  yearMinInput.max = String(stats.maxYear);
  yearMaxInput.min = String(stats.minYear);
  yearMaxInput.max = String(stats.maxYear);
  yearMinInput.value = String(stats.minYear);
  yearMaxInput.value = String(stats.maxYear);

  updateYearRangeUi();
  updateYearSliderTrack();
  updateYearSliderZ();

  if (yearUnknownToggle) {
    const hasUnknown = stats.unknownGroups > 0;
    yearUnknownToggle.checked = hasUnknown;
    yearUnknownToggle.disabled = !hasUnknown;
    state.yearIncludeUnknown = hasUnknown;
    if (yearUnknownToggleWrap) {
      yearUnknownToggleWrap.classList.toggle("is-hidden", !hasUnknown);
    }
  }
  if (yearUnknownCount) {
    yearUnknownCount.textContent = stats.unknownGroups
      ? `(${stats.unknownGroups.toLocaleString()})`
      : "";
  }

  yearMinInput.addEventListener("input", () => handleYearInput("min"));
  yearMaxInput.addEventListener("input", () => handleYearInput("max"));
  yearMinInput.addEventListener("change", () =>
    handleYearInput("min", { flush: true }),
  );
  yearMaxInput.addEventListener("change", () =>
    handleYearInput("max", { flush: true }),
  );
  if (yearSliderWrap) {
    let dragActive = false;
    let dragSource = "min";
    const setDragValue = (clientX, options = {}) => {
      const value = getYearFromClientX(clientX);
      if (value === null) return;
      if (dragSource === "min") {
        yearMinInput.value = String(value);
      } else {
        yearMaxInput.value = String(value);
      }
      handleYearInput(dragSource, options);
    };

    yearSliderWrap.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const value = getYearFromClientX(event.clientX);
      if (value === null) return;
      const distMin = Math.abs(value - state.yearFilterMin);
      const distMax = Math.abs(value - state.yearFilterMax);
      dragSource = distMin <= distMax ? "min" : "max";
      dragActive = true;
      yearSliderWrap.setPointerCapture(event.pointerId);
      setDragValue(event.clientX);
      event.preventDefault();
    });

    yearSliderWrap.addEventListener("pointermove", (event) => {
      if (!dragActive) return;
      setDragValue(event.clientX);
      event.preventDefault();
    });

    const stopDrag = (event) => {
      if (!dragActive) return;
      dragActive = false;
      yearSliderWrap.releasePointerCapture(event.pointerId);
      setDragValue(event.clientX, { flush: true });
    };
    yearSliderWrap.addEventListener("pointerup", stopDrag);
    yearSliderWrap.addEventListener("pointercancel", stopDrag);
    yearSliderWrap.addEventListener("pointerleave", (event) => {
      if (!dragActive) return;
      stopDrag(event);
    });
  }
  if (yearUnknownToggle) {
    yearUnknownToggle.addEventListener("change", () => {
      state.yearIncludeUnknown = yearUnknownToggle.checked;
      applyYearFilter({ fitBounds: false });
    });
  }

  applyYearFilter({ fitBounds: true });
}

let zoomViewer = null;
let zoomLastXid = null;

async function loadZoomifyMeta(xid) {
  const url = `/api/zoomify?xid=${encodeURIComponent(xid)}`;
  return fetchJson(url);
}

async function loadZoomifyInto(viewerEl, wrapEl, fallbackIframe, xid) {
  if (!viewerEl || !wrapEl) return;
  if (zoomLastXid === xid) return;

  zoomLastXid = xid;
  wrapEl.classList.remove("is-fallback");

  try {
    if (!window.OpenSeadragon) {
      throw new Error("OpenSeadragon chybí");
    }

    const meta = await loadZoomifyMeta(xid);

    if (!zoomViewer) {
      zoomViewer = window.OpenSeadragon({
        element: viewerEl,
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
    wrapEl.classList.add("is-fallback");
  }
}

function updateSubmitState() {
  if (window.CorrectionUI) {
    window.CorrectionUI.updateSubmitState();
    return;
  }
  const button = feedbackForm.querySelector("button[type='submit']");
  const canSubmit = Boolean(
    state.selectedFeature &&
    (state.turnstileBypass || state.turnstileToken),
  );
  button.disabled = !canSubmit;
}

function getArchiveUrl(feature) {
  if (!feature || !state.archiveBaseUrl) return "";
  return `${state.archiveBaseUrl}/permalink?xid=${feature.properties.id}&scan=1#scan1`;
}

function setUrlXid(xid, mode = "push") {
  const current = new URLSearchParams(window.location.search).get("xid");
  if (xid === current) return;

  const url = new URL(window.location.href);
  if (xid) {
    url.searchParams.set("xid", xid);
  } else {
    url.searchParams.delete("xid");
  }

  if (mode === "replace") {
    history.replaceState({ xid }, "", url);
  } else {
    history.pushState({ xid }, "", url);
  }
}

function setCorrection(lat, lon) {
  state.correctionLat = lat;
  state.correctionLon = lon;
  if (correctionLatInput) correctionLatInput.value = String(lat);
  if (correctionLonInput) correctionLonInput.value = String(lon);
  updateSubmitState();
}

function clearCorrection() {
  state.correctionLat = null;
  state.correctionLon = null;
  if (correctionLatInput) correctionLatInput.value = "";
  if (correctionLonInput) correctionLonInput.value = "";
  updateSubmitState();
}

function ensureCorrectionMap() {
  if (!correctionMapEl || state.correctionMap) return;
  state.correctionMap = L.map(correctionMapEl, {
    zoomControl: false,
    scrollWheelZoom: false,
  }).setView(pragueFallback, 13);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap přispěvatelé",
  }).addTo(state.correctionMap);

  state.correctionMap.on("click", (event) => {
    const { lat, lng } = event.latlng;
    updateCorrectionMarker(lat, lng);
  });
}

function updateCorrectionMarker(lat, lng) {
  if (!state.correctionMarker) {
    state.correctionMarker = L.marker([lat, lng], {
      draggable: true
    }).addTo(state.correctionMap);

    state.correctionMarker.on("dragend", (event) => {
      const marker = event.target;
      const position = marker.getLatLng();
      setCorrection(Number(position.lat.toFixed(6)), Number(position.lng.toFixed(6)));
    });
  } else {
    state.correctionMarker.setLatLng([lat, lng]);
  }
  setCorrection(Number(lat.toFixed(6)), Number(lng.toFixed(6)));
}

function resetCorrectionMap(feature) {
  if (!state.correctionMap || !feature) return;
  const [lon, lat] = feature.geometry.coordinates;
  state.correctionMap.setView([lat, lon], 15);

  if (feature.properties?.corrected) {
    const { lat: cLat, lon: cLon } = feature.properties.corrected;
    updateCorrectionMarker(cLat, cLon);
    return;
  }

  if (state.correctionMarker) {
    state.correctionMap.removeLayer(state.correctionMarker);
    state.correctionMarker = null;
  }
  clearCorrection();
}

function openArchiveModal(url, xid, options = {}) {
  if (!archiveModal || !archiveIframe || !archiveFallback) return;
  const { updateHistory = true } = options;
  archiveModal.style.display = "grid";
  archiveIframe.style.pointerEvents = "";
  if (url) {
    archiveIframe.src = url;
    archiveFallback.href = url;
    archiveFallback.style.display = "inline-flex";
  } else {
    archiveIframe.src = "";
    archiveFallback.href = "#";
    archiveFallback.style.display = "none";
  }
  archiveModal.classList.add("is-open");
  archiveModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  renderTurnstile();
  if (metaView) metaView.classList.remove("is-hidden");
  if (correctionView) correctionView.classList.add("is-hidden");

  if (feedbackForm) {
    feedbackForm.classList.remove("is-open");
  }
  clearCorrection();
  if (reportCtaWrap) {
    reportCtaWrap.classList.remove("is-hidden");
  }
  if (updateHistory && xid) {
    setUrlXid(xid);
  }

  if (xid) {
    loadZoomifyInto(zoomViewerEl, zoomWrap, archiveIframe, xid);
  }
}

function closeArchiveModal(options = {}) {
  if (!archiveModal || !archiveIframe) return;
  const { updateHistory = true } = options;
  archiveModal.classList.remove("is-open");
  archiveModal.setAttribute("aria-hidden", "true");
  archiveIframe.src = "";
  archiveIframe.style.pointerEvents = "none";
  zoomLastXid = null;
  document.body.style.overflow = "";
  if (window.CorrectionUI) {
    window.CorrectionUI.close();
  }
  if (metaView) metaView.classList.remove("is-hidden");
  if (correctionView) correctionView.classList.add("is-hidden");
  if (feedbackForm) feedbackForm.classList.remove("is-open");

  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  setTimeout(() => {
    if (!archiveModal.classList.contains("is-open")) {
      archiveModal.style.display = "none";
    }
  }, 200);

  if (updateHistory) {
    setUrlXid(null, "replace");
  }

  // Ensure map recalculates its size after the modal is gone
  if (state.map) {
    setTimeout(() => {
      state.map.invalidateSize({ animate: true });
    }, 250);
  }
}

function renderDetails(feature) {
  if (!detailContainer) return;
  if (!window.OldPragueMeta?.renderDetails) return;
  const group = state.selectedGroup;
  window.OldPragueMeta.renderDetails(detailContainer, feature, state.archiveBaseUrl, {
    groupItems: group?.items || [],
    selectedId: feature?.properties?.id || "",
    onSelectVersion: (xid) => {
      if (!xid || !state.featuresById.has(xid)) return;
      const nextGroup = state.groupByXid.get(xid);
      if (nextGroup) state.selectedGroup = nextGroup;
      selectFeature(state.featuresById.get(xid), {
        openModal: true,
        updateHistory: true,
        panTo: false,
      });
    },
  });
}

function buildMarkerIcon() {
  return L.divIcon({
    className: "marker-dot",
    html: "<span></span>",
    iconSize: [18, 18],
  });
}

function getPreviewFromFeature(feature) {
  const props = feature?.properties || {};
  const previews = props.scan_previews;
  if (Array.isArray(previews) && previews.length) {
    return String(previews[0]);
  }
  return "";
}

function buildZoomifyTiers(width, height, tileSize) {
  const tiers = [];
  let w = width;
  let h = height;
  while (w > tileSize || h > tileSize) {
    tiers.push([w, h]);
    w = Math.floor((w + 1) / 2);
    h = Math.floor((h + 1) / 2);
  }
  tiers.push([w, h]);
  tiers.reverse();
  return tiers;
}

function zoomifyTilesFor([w, h], tileSize) {
  return [Math.ceil(w / tileSize), Math.ceil(h / tileSize)];
}

function zoomifyTileGroupIndex(tiers, tileSize, level, x, y) {
  let offset = 0;
  for (let i = 0; i < level; i += 1) {
    const [tilesX, tilesY] = zoomifyTilesFor(tiers[i], tileSize);
    offset += tilesX * tilesY;
  }
  const [tilesX] = zoomifyTilesFor(tiers[level], tileSize);
  return Math.floor((offset + y * tilesX + x) / 256);
}

function buildZoomifyPreviewUrl(meta) {
  const base = String(meta?.zoomifyImgPath || "").replace(/\/$/, "");
  const width = Number(meta?.width);
  const height = Number(meta?.height);
  const tileSize = Number(meta?.tileSize || 256);
  if (!base) return "";
  if (!Number.isFinite(width) || !Number.isFinite(height)) return "";
  if (!Number.isFinite(tileSize) || tileSize <= 0) return "";
  const tiers = buildZoomifyTiers(width, height, tileSize);
  const level = 0;
  const group = zoomifyTileGroupIndex(tiers, tileSize, level, 0, 0);
  return `${base}/TileGroup${group}/${level}-0-0.jpg`;
}

async function resolvePreviewUrl(feature) {
  if (!feature) return "";
  const props = feature.properties || {};
  const xid = String(props.id || "").trim();
  if (!xid) return "";

  const cached = state.previewByXid.get(xid);
  if (cached !== undefined) {
    return cached || "";
  }

  if (state.previewPromiseByXid.has(xid)) {
    return state.previewPromiseByXid.get(xid);
  }

  const promise = (async () => {
    const local = getPreviewFromFeature(feature);
    if (local) {
      state.previewByXid.set(xid, local);
      return local;
    }
    try {
      const meta = await loadZoomifyMeta(xid);
      const url = buildZoomifyPreviewUrl(meta);
      state.previewByXid.set(xid, url || null);
      return url || "";
    } catch (error) {
      state.previewByXid.set(xid, null);
      return "";
    } finally {
      state.previewPromiseByXid.delete(xid);
    }
  })();

  state.previewPromiseByXid.set(xid, promise);
  return promise;
}

function ensurePreviewPopup() {
  if (state.previewPopup || !state.map) return;
  state.previewPopup = L.popup({
    closeButton: false,
    autoPan: false,
    className: "photo-preview-popup",
    offset: L.point(0, -12),
  });
}

function renderPreviewContent(url, options = {}) {
  const { loading = false } = options;
  if (!url) {
    return `<div class="photo-preview">${loading ? '<div class="preview-loading"></div>' : '<div class="preview-empty">Bez náhledu</div>'}</div>`;
  }
  return `<div class="photo-preview"><img src="${url}" alt="Náhled fotografie" loading="lazy" /></div>`;
}

function showPreviewAt(latlng, content) {
  if (!state.map || !state.previewPopup) return;
  state.previewPopup.setLatLng(latlng);
  state.previewPopup.setContent(content);
  state.previewPopup.openOn(state.map);
}

function clearPreviewHideTimer() {
  if (state.previewHideTimer) {
    clearTimeout(state.previewHideTimer);
    state.previewHideTimer = null;
  }
}

function schedulePreviewHide() {
  clearPreviewHideTimer();
  state.previewHideTimer = setTimeout(() => {
    state.previewHideTimer = null;
    hidePreview();
  }, 80);
}

function hidePreview() {
  clearPreviewHideTimer();
  state.previewHoverToken += 1;
  state.previewActiveXid = "";
  if (state.map && state.previewPopup) {
    state.map.closePopup(state.previewPopup);
  }
}

function handleMarkerHover(group, latlng) {
  const feature = group?.primary;
  if (!feature) return;
  const xid = String(feature?.properties?.id || "").trim();
  clearPreviewHideTimer();
  ensurePreviewPopup();
  if (!state.previewPopup || !state.map) return;

  const popupOpen = state.map.hasLayer(state.previewPopup);
  if (popupOpen && xid && state.previewActiveXid === xid) {
    return;
  }
  state.previewActiveXid = xid;

  const hoverToken = (state.previewHoverToken += 1);
  const localUrl = getPreviewFromFeature(feature);
  showPreviewAt(latlng, renderPreviewContent(localUrl, { loading: !localUrl }));

  if (localUrl) return;
  resolvePreviewUrl(feature).then((url) => {
    if (hoverToken !== state.previewHoverToken) return;
    if (!url) {
      showPreviewAt(latlng, renderPreviewContent("", { loading: false }));
      return;
    }
    showPreviewAt(latlng, renderPreviewContent(url, { loading: false }));
  });
}

function initMap() {
  state.map = L.map("map", {
    zoomControl: true,
    scrollWheelZoom: true,
  }).setView(pragueFallback, 12);

  const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> přispěvatelé';
  const mapyAttr = '&copy; <a href="https://www.mapy.cz">Mapy.cz</a>';

  if (MAPY_CZ_API_KEY) {
    const mapyLayer = L.tileLayer(`https://api.mapy.cz/v1/maptiles/basic/256/{z}/{x}/{y}?apikey=${MAPY_CZ_API_KEY}`, {
      maxZoom: 19,
      attribution: `${mapyAttr}, ${osmAttr}`
    });
    mapyLayer.addTo(state.map);

    // Fallback: If mapy.cz tiles fail to load, we could add OSM under it or handle errors, 
    // but usually we just add OSM as a backup layer in case the key is invalid
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

  const clusterToggle = document.getElementById("cluster-toggle");
  if (clusterToggle) {
    state.clusteringEnabled = clusterToggle.checked;
    clusterToggle.addEventListener("change", (e) => {
      toggleClustering(e.target.checked);
    });
  }

  state.cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 46,
    iconCreateFunction: (cluster) =>
      L.divIcon({
        html: `<div class="cluster-badge">${cluster.getChildCount()}</div>`,
        className: "cluster-wrapper",
        iconSize: [44, 44],
      }),
  });

  // "Smart Clustering" for overlapping points (very small radius)
  state.overlapCluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 2, // Only group very close or identical coordinates
    iconCreateFunction: (cluster) =>
      L.divIcon({
        html: `<div class="cluster-badge tiny">${cluster.getChildCount()}</div>`,
        className: "cluster-wrapper",
        iconSize: [24, 24],
      }),
  });

  if (state.clusteringEnabled) {
    state.map.addLayer(state.cluster);
  } else {
    state.map.addLayer(state.overlapCluster);
  }
}

function toggleClustering(enabled) {
  if (!enabled && !localStorage.getItem("cluster-warning-shown")) {
    const proceed = confirm(
      "Vypnutí seskupování může při velkém počtu fotek výrazně zpomalit prohlížeč. Chcete pokračovat?\n\n(Body se stejnou polohou zůstanou seskupené i tak, aby byly přístupné.)"
    );
    if (!proceed) {
      const toggle = document.getElementById("cluster-toggle");
      if (toggle) toggle.checked = true;
      return;
    }
    localStorage.setItem("cluster-warning-shown", "true");
  }

  state.clusteringEnabled = enabled;
  if (!state.map) return;

  if (enabled) {
    if (state.map.hasLayer(state.overlapCluster)) state.map.removeLayer(state.overlapCluster);
    state.map.addLayer(state.cluster);
  } else {
    if (state.map.hasLayer(state.cluster)) state.map.removeLayer(state.cluster);
    state.map.addLayer(state.overlapCluster);
  }
}

function addMarkers(groups, options = {}) {
  const { fitBounds = true } = options;
  state.cluster.clearLayers();
  state.overlapCluster.clearLayers();

  const bounds = L.latLngBounds();
  const icon = buildMarkerIcon();

  groups.forEach((group) => {
    if (!group) return;
    const lat = Number(group.lat);
    const lon = Number(group.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const markerParams = { icon, interactive: true };

    // We create separate marker instances for each cluster group
    const m1 = L.marker([lat, lon], markerParams);
    const m2 = L.marker([lat, lon], markerParams);

    const setup = (m) => {
      m.on("click", () => {
        selectGroup(group, { openModal: true, updateHistory: true, panTo: true });
      });
      m.on("mouseover", () => handleMarkerHover(group, m.getLatLng()));
      m.on("mousemove", () => handleMarkerHover(group, m.getLatLng()));
      m.on("mouseout", () => schedulePreviewHide());
    };
    setup(m1);
    setup(m2);

    bounds.extend([lat, lon]);
    state.cluster.addLayer(m1);
    state.overlapCluster.addLayer(m2);
  });

  if (groups.length && fitBounds) {
    state.map.fitBounds(bounds, { padding: [40, 40] });
  }
}

function selectGroup(group, options = {}) {
  if (!group) return;
  state.selectedGroup = group;
  const selectedXid = options.selectedXid;
  let feature = group.primary;
  if (selectedXid && state.featuresById.has(selectedXid)) {
    const candidate = state.featuresById.get(selectedXid);
    if (candidate?.properties?.group_root === group.id) {
      feature = candidate;
    }
  }
  selectFeature(feature, options);
}

function selectFeature(feature, options = {}) {
  if (!feature) return;
  const { openModal = false, updateHistory = false, panTo = false } = options;
  state.selectedFeature = feature;
  renderDetails(feature);
  clearStatus();
  updateSubmitState();

  if (panTo && state.map) {
    const [lon, lat] = feature.geometry.coordinates;
    state.map.setView([lat, lon], Math.max(state.map.getZoom(), 14), {
      animate: true,
    });
  }

  if (openModal) {
    const url = getArchiveUrl(feature);
    openArchiveModal(url, feature.properties.id, { updateHistory });
  }
}

function renderTurnstile() {
  if (window.CorrectionUI) {
    window.CorrectionUI.renderTurnstile();
    return;
  }

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

  if (state.turnstileWidgetId !== null) {
    return;
  }

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

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Požadavek selhal: ${response.status}`);
  }
  return response.json();
}

async function bootstrap() {
  const config = await fetchJson("/api/config").catch(() => ({}));
  state.turnstileSiteKey = config.turnstileSiteKey || "";
  state.turnstileBypass = Boolean(config.turnstileBypass);
  state.archiveBaseUrl = config.archiveBaseUrl || "";

  let photos;
  try {
    photos = await fetchJson("/data/photos.geojson");
  } catch (error) {
    photos = await fetchJson("/api/photos");
  }

  initMap();

  renderTurnstile();

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
  state.correctionsByGroup = grouping.applyCorrections(
    features,
    corrections.items || [],
    groupIdByXid,
    state.resolveGroupId,
  );

  const groupIndex = grouping.buildGroups(features, state.resolveGroupId);
  state.groups = groupIndex.groups;
  state.groupById = groupIndex.groupById;
  state.groupByXid = groupIndex.groupByXid;
  state.featuresById = groupIndex.featureById;

  initYearFilter();
  renderDetails(null);

  const verifiedCount = document.getElementById("verified-count");
  if (verifiedCount) {
    verifiedCount.textContent = state.correctionsByGroup.size
      ? state.correctionsByGroup.size.toLocaleString()
      : "0";
  }

  const xid = new URLSearchParams(window.location.search).get("xid");
  if (xid && state.featuresById.has(xid)) {
    const group = state.groupByXid.get(xid);
    if (group) {
      selectGroup(group, {
        openModal: true,
        updateHistory: false,
        panTo: true,
        selectedXid: xid,
      });
    }
  }

  // Initialize shared Correction UI
  if (window.CorrectionUI) {
    window.CorrectionUI.init({
      container: correctionView,
      mapEl: correctionMapEl,
      submitBtn: feedbackForm?.querySelector("button[type='submit']"),
      cancelBtn: cancelCorrectionBtn,
      messageEl: feedbackForm?.querySelector("textarea[name='message']"),
      emailEl: feedbackForm?.querySelector("input[name='email']"),
      statusEl: formStatus,
      turnstileContainerEl: document.getElementById("turnstile"),
      turnstileNoteEl: turnstileNote,
      turnstileSiteKey: state.turnstileSiteKey,
      turnstileBypass: state.turnstileBypass,
      onSubmit: (feature, proposedCoords) => {
        if (metaView) metaView.classList.remove("is-hidden");
        if (correctionView) correctionView.classList.add("is-hidden");
        if (reportCtaWrap) reportCtaWrap.classList.remove("is-hidden");
        if (feature && proposedCoords) {
          const lat = Number(proposedCoords.lat);
          const lon = Number(proposedCoords.lon);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            const groupId =
              feature.properties?.group_root || feature.properties?.group_id;
            const group = groupId ? state.groupById.get(groupId) : null;
            const targets = group?.items?.length ? group.items : [feature];
            targets.forEach((item) => {
              item.geometry.coordinates = [lon, lat];
              item.properties = item.properties || {};
              item.properties.corrected = { lat, lon };
            });
            if (group) {
              group.lat = lat;
              group.lon = lon;
              group.primary = group.items[0] || feature;
            }
            const activeGroups = Array.isArray(state.filteredGroups)
              ? state.filteredGroups
              : state.groups;
            if (Array.isArray(activeGroups)) {
              addMarkers(activeGroups, { fitBounds: false });
            }
            if (state.map) {
              state.map.setView([lat, lon], Math.max(state.map.getZoom(), 14), {
                animate: true,
              });
            }
          }
        }
      },
      onCancel: () => {
        if (metaView) metaView.classList.remove("is-hidden");
        if (correctionView) correctionView.classList.add("is-hidden");
      },
    });

    if (window.turnstile) {
      window.CorrectionUI.renderTurnstile();
    }
  }

  initSearch();
}

function initSearch() {
  const searchInput = document.getElementById("map-search");
  const searchResults = document.getElementById("search-results");
  if (!searchInput || !searchResults) return;

  let debounceTimer;
  searchInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const query = searchInput.value.trim();
    if (query.length < 3) {
      searchResults.classList.add("is-hidden");
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const results = await fetchGeocode(query);
        renderSearchResults(results, searchResults);
      } catch (err) {
        console.error("Vyhledávání selhalo", err);
      }
    }, 400);
  });

  document.addEventListener("click", (e) => {
    if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
      searchResults.classList.add("is-hidden");
    }
  });
}

async function fetchGeocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query + ", Praha")}&limit=5`;
  const response = await fetch(url, {
    headers: { "Accept-Language": "cs-CZ" }
  });
  if (!response.ok) throw new Error("Chyba při hledání");
  return response.json();
}

function renderSearchResults(results, container) {
  if (!results.length) {
    container.classList.add("is-hidden");
    return;
  }

  container.innerHTML = results.map(res => `
    <div class="search-item" data-lat="${res.lat}" data-lon="${res.lon}">
      ${res.display_name.split(",").slice(0, 3).join(",")}
    </div>
  `).join("");

  container.classList.remove("is-hidden");

  container.querySelectorAll(".search-item").forEach(item => {
    item.addEventListener("click", () => {
      const lat = parseFloat(item.dataset.lat);
      const lon = parseFloat(item.dataset.lon);
      state.map.setView([lat, lon], 16, { animate: true });
      container.classList.add("is-hidden");
      document.getElementById("map-search").value = item.textContent.trim();
    });
  });
}

feedbackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (window.CorrectionUI) {
    window.CorrectionUI.submit();
    return;
  }
  clearStatus();

  if (!state.selectedFeature) {
    setStatus("Nejprve vyberte bod na mapě.", "error");
    return;
  }

  if (!state.turnstileToken) {
    if (!state.turnstileBypass) {
      setStatus("Dokončete Turnstile kontrolu.", "error");
      return;
    }
  }

  const formData = new FormData(feedbackForm);
  const rawMessage = String(formData.get("message") || "").trim();
  const hasCoordinates = state.correctionLat !== null && state.correctionLon !== null;
  const groupId =
    state.selectedGroup?.id ||
    state.selectedFeature?.properties?.group_root ||
    state.selectedFeature?.properties?.group_id ||
    null;
  const payload = {
    xid: state.selectedFeature.properties.id,
    group_id: groupId,
    lat: state.correctionLat ?? null,
    lon: state.correctionLon ?? null,
    verdict: hasCoordinates ? "wrong" : "flag",
    message: rawMessage || "Nahlášena špatná poloha.",
    email: formData.get("email"),
    token: state.turnstileToken || "",
  };

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

    setStatus("Děkujeme! Zpětná vazba byla přijata.", "success");
    feedbackForm.reset();
    feedbackForm.classList.remove("is-open");
    if (state.correctionMarker && state.correctionMap) {
      state.correctionMap.removeLayer(state.correctionMarker);
      state.correctionMarker = null;
    }
    clearCorrection();
    if (correctionToggle) {
      correctionToggle.checked = false;
      correctionMapEl?.parentElement?.classList.add("is-hidden");
    }
    if (reportCtaWrap) {
      reportCtaWrap.classList.remove("is-hidden");
    }
    state.turnstileToken = "";
    if (state.turnstileWidgetId !== null && window.turnstile) {
      window.turnstile.reset(state.turnstileWidgetId);
    }
    updateSubmitState();
  } catch (err) {
    setStatus(err.message || "Odeslání selhalo", "error");
  }
});

if (reportCta) {
  reportCta.addEventListener("click", () => {
    if (!state.selectedFeature) return;
    if (metaView) metaView.classList.add("is-hidden");
    if (correctionView) correctionView.classList.remove("is-hidden");
    if (feedbackForm) feedbackForm.classList.add("is-open");
    if (window.CorrectionUI) {
      window.CorrectionUI.open(state.selectedFeature);
    }
  });
}

// Cancel button is now handled by CorrectionUI

// Correction toggle removed - replaced by view switching

if (infoOpenBtn && infoModal) {
  infoOpenBtn.addEventListener("click", () => {
    infoModal.classList.add("is-open");
    infoModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  });
}

const closeInfoModal = () => {
  if (!infoModal) return;
  infoModal.classList.remove("is-open");
  infoModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
};

document.querySelectorAll("[data-info-close]").forEach((el) => {
  el.addEventListener("click", closeInfoModal);
});

document.querySelectorAll("[data-modal-close]").forEach((el) => {
  el.addEventListener("click", () => closeArchiveModal({ updateHistory: true }));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && archiveModal?.classList.contains("is-open")) {
    closeArchiveModal({ updateHistory: true });
  }
});

window.addEventListener("popstate", () => {
  const xid = new URLSearchParams(window.location.search).get("xid");
  if (xid && state.featuresById.has(xid)) {
    const group = state.groupByXid.get(xid);
    if (group) {
      selectGroup(group, {
        openModal: true,
        updateHistory: false,
        panTo: false,
        selectedXid: xid,
      });
    }
  } else if (archiveModal?.classList.contains("is-open")) {
    closeArchiveModal({ updateHistory: false });
  }
});

bootstrap().catch((err) => {
  setStatus("Nepodařilo se načíst data.", "error");
  console.error(err);
});
