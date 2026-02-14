// MAPY_CZ_API_KEY is defined in correction-ui.js

const state = {
  map: null,
  cluster: null,
  selectedGroup: null,
  selectedFeature: null,
  archiveBaseUrl: "",
  featuresById: new Map(),
  groupById: new Map(),
  groupByXid: new Map(),
  correctionsByGroup: new Map(),
  reviewCounts: {},
  overlapCluster: null,
  clusteringEnabled: true,
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
  gridVisibleCount: 24,
  gridPageSize: 24,
  nearbyGroupIds: [],
  nearbyIndex: -1,
  nearbyAnchorGroupId: "",
  detailMiniMap: null,
  detailMiniMarker: null,
};

const detailContainer = document.getElementById("photo-details");
const photoCount = document.getElementById("photo-count");
const feedbackForm = document.getElementById("feedback-form");
const formStatus = document.getElementById("form-status");
const turnstileNote = document.getElementById("turnstile-note");
const archiveModal = document.getElementById("archive-modal");
const archiveIframe = document.getElementById("archive-iframe");
const archivePreview = document.getElementById("archive-preview");
const archiveUnavailable = document.getElementById("archive-unavailable");
const archiveFallback = document.getElementById("archive-fallback");
const zoomWrap = archiveIframe?.closest(".zoom-wrap");
const zoomViewerEl = document.getElementById("zoom-viewer");
const reportCta = document.getElementById("report-cta");
const reportCtaWrap = document.getElementById("report-cta-container");
const reportFlagBtn = document.getElementById("report-flag");
const consensusBanner = document.getElementById("consensus-banner");
const consensusText = document.getElementById("consensus-text");
const confirmCta = document.getElementById("confirm-cta");
const correctionScopeHint = document.getElementById("correction-scope-hint");
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
const photoGrid = document.getElementById("photo-grid");
const photoGridCount = document.getElementById("photo-grid-count");
const photoGridEmpty = document.getElementById("photo-grid-empty");
const photoGridLoadMore = document.getElementById("photo-grid-load-more");
const nearbyPrevBtn = document.getElementById("nearby-prev");
const nearbyNextBtn = document.getElementById("nearby-next");
const nearbyState = document.getElementById("nearby-state");
const photoMinimapWrap = document.getElementById("photo-minimap-wrap");
const photoMinimapEl = document.getElementById("photo-minimap");

const infoModal = document.getElementById("info-modal");
const infoOpenBtn = document.getElementById("info-open");

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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function escapeSelectorValue(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(String(value));
  }
  return String(value).replace(/["\\]/g, "\\$&");
}

function getActiveGroups() {
  return Array.isArray(state.filteredGroups) ? state.filteredGroups : state.groups;
}

function getMapVisibleGroups(groups = getActiveGroups()) {
  const source = Array.isArray(groups) ? groups : [];
  if (!state.map || typeof state.map.getBounds !== "function") return source;
  const bounds = state.map.getBounds();
  if (!bounds || typeof bounds.contains !== "function") return source;
  return source.filter((group) => {
    const lat = Number(group?.lat);
    const lon = Number(group?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    return bounds.contains([lat, lon]);
  });
}

function getGroupTitle(group) {
  const primary = group?.primary?.properties || {};
  return (
    primary.description ||
    primary.title ||
    primary.signature ||
    group?.id ||
    "Fotografie"
  );
}

function getGroupSubtitle(group) {
  const primary = group?.primary?.properties || {};
  const parts = [];
  if (primary.author) parts.push(primary.author);
  if (primary.date_label) parts.push(primary.date_label);
  if (group?.items?.length > 1) parts.push(`${group.items.length} verzí`);
  return parts.join(" · ");
}

function buildGroupSearchDocument(group) {
  const values = [];
  if (group?.id) values.push(group.id);
  (group?.items || []).forEach((feature) => {
    const props = feature?.properties || {};
    values.push(
      props.id,
      props.description,
      props.author,
      props.date_label,
      props.signature,
      props.note,
      props.obsah,
      props.autor,
      props.datace,
      props.geolocation_type,
      props.location,
      props.place,
      props.street,
      props.city,
    );
  });
  return normalizeSearchText(values.filter(Boolean).join(" "));
}

function haversineDistanceKm(latA, lonA, latB, lonB) {
  const r = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(latB - latA);
  const dLon = toRad(lonB - lonA);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
    renderPhotoGrid({ reset: true });
    updateNearbyNavigation();
    return;
  }
  const minYear = state.yearFilterMin;
  const maxYear = state.yearFilterMax;
  const filtered = filterGroupsByYear(state.groups, minYear, maxYear);
  state.filteredGroups = filtered;
  addMarkers(filtered, { fitBounds });
  updatePhotoCount(filtered.length);
  renderPhotoGrid({ reset: true });
  updateNearbyNavigation();
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
    renderPhotoGrid({ reset: true });
    updateNearbyNavigation();
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

async function loadPreviewUrl(xid) {
  const url = `/api/preview-url?xid=${encodeURIComponent(xid)}`;
  const payload = await fetchJson(url);
  return String(payload?.url || "");
}

function getUnavailablePreviewMessage(error) {
  const message = String(error?.message || "");
  if (
    /Zoomify link not found|Zoomify odkaz nenalezen|Záznam nenalezen|search page/i.test(
      message,
    )
  ) {
    return "Záznam už v archivu AHMP není dostupný (xid nenalezen).";
  }
  if (/zoomifyImgPath/i.test(message)) {
    return "Archivní záznam existuje, ale náhled není dostupný.";
  }
  return "Náhled pro tento záznam teď není dostupný.";
}

async function loadZoomifyInto(viewerEl, wrapEl, previewImgEl, xid) {
  if (!viewerEl || !wrapEl) return;
  if (zoomLastXid === xid) return;

  zoomLastXid = xid;
  wrapEl.classList.remove("is-fallback", "is-unavailable");
  if (previewImgEl) {
    previewImgEl.src = "";
  }
  if (archiveUnavailable) {
    archiveUnavailable.textContent = "";
  }

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
    let previewUrl = "";
    try {
      previewUrl = await loadPreviewUrl(xid);
    } catch (previewError) {
      previewUrl = "";
    }

    if (previewUrl) {
      if (previewImgEl) {
        previewImgEl.src = previewUrl;
      }
      wrapEl.classList.add("is-fallback");
      return;
    }

    wrapEl.classList.add("is-unavailable");
    if (archiveUnavailable) {
      archiveUnavailable.textContent = getUnavailablePreviewMessage(error);
    }
  }
}

function updateSubmitState() {
  window.CorrectionUI?.updateSubmitState();
}

function getArchiveUrl(feature) {
  if (!feature || !state.archiveBaseUrl) return "";
  return `${state.archiveBaseUrl}/permalink?xid=${feature.properties.id}&scan=1#scan1`;
}

function invalidateDetailMiniMap() {
  if (!state.detailMiniMap || !photoMinimapWrap) return;
  if (photoMinimapWrap.classList.contains("is-hidden")) return;
  setTimeout(() => {
    state.detailMiniMap?.invalidateSize({ pan: false, animate: false });
  }, 100);
}

function ensureDetailMiniMap() {
  if (state.detailMiniMap) return state.detailMiniMap;
  if (!photoMinimapEl || !window.L) return null;
  state.detailMiniMap = L.map(photoMinimapEl, {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    touchZoom: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    tap: false,
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
  }).addTo(state.detailMiniMap);
  return state.detailMiniMap;
}

function renderDetailMiniMap(feature) {
  if (!photoMinimapWrap || !photoMinimapEl) return;
  const [lonRaw, latRaw] = feature?.geometry?.coordinates || [];
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    photoMinimapWrap.classList.add("is-hidden");
    return;
  }

  photoMinimapWrap.classList.remove("is-hidden");
  const map = ensureDetailMiniMap();
  if (!map) return;
  const latlng = [lat, lon];
  if (!state.detailMiniMarker) {
    state.detailMiniMarker = L.circleMarker(latlng, {
      radius: 7,
      color: "#ffffff",
      weight: 2,
      fillColor: "#c34d2f",
      fillOpacity: 0.96,
    }).addTo(map);
  } else {
    state.detailMiniMarker.setLatLng(latlng);
  }
  map.setView(latlng, 15, { animate: false });
  invalidateDetailMiniMap();
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

function openArchiveModal(url, xid, options = {}) {
  if (!archiveModal || !archiveIframe || !archiveFallback) return;
  const { updateHistory = true } = options;
  archiveModal.style.display = "grid";
  archiveIframe.style.pointerEvents = "none";
  archiveIframe.src = "";
  if (url) {
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
  if (metaView) metaView.classList.remove("is-hidden");
  if (correctionView) correctionView.classList.add("is-hidden");

  if (feedbackForm) {
    feedbackForm.classList.remove("is-open");
  }
  if (reportCtaWrap) {
    reportCtaWrap.classList.remove("is-hidden");
  }
  if (updateHistory && xid) {
    setUrlXid(xid);
  }

  if (xid) {
    loadZoomifyInto(zoomViewerEl, zoomWrap, archivePreview, xid);
  }
  invalidateDetailMiniMap();
}

function closeArchiveModal(options = {}) {
  if (!archiveModal || !archiveIframe) return;
  const { updateHistory = true } = options;
  archiveModal.classList.remove("is-open");
  archiveModal.setAttribute("aria-hidden", "true");
  archiveIframe.src = "";
  archiveIframe.style.pointerEvents = "none";
  if (archivePreview) archivePreview.src = "";
  if (archiveUnavailable) archiveUnavailable.textContent = "";
  if (zoomWrap) zoomWrap.classList.remove("is-fallback", "is-unavailable");
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

function resolveGroupIdForFeature(feature) {
  const props = feature?.properties || {};
  return props.group_root || props.group_id || props.id || "";
}

function getCorrectionForFeature(feature) {
  const groupId = resolveGroupIdForFeature(feature);
  if (!groupId) return null;
  return state.correctionsByGroup.get(groupId) || null;
}

function renderConsensusStatus(feature) {
  if (!consensusBanner || !consensusText || !confirmCta) return;
  const correction = getCorrectionForFeature(feature);
  if (!correction) {
    consensusBanner.classList.add("is-hidden");
    return;
  }

  const correctionState = String(correction.correction_state || "none");
  const anchorType = String(correction.anchor_type || "none");
  let text = "";
  let showConfirm = false;

  if (correctionState === "pending" && anchorType === "correction") {
    text = "Poloha upravena jiným uživatelem. Sedí to?";
    showConfirm = true;
  } else if (correctionState === "approved") {
    text = "Poloha potvrzena komunitou.";
  } else if (anchorType === "flag") {
    text = "Nahlášeno: poloha možná nesedí, čeká na potvrzení.";
  } else {
    consensusBanner.classList.add("is-hidden");
    return;
  }

  consensusText.textContent = text;
  confirmCta.classList.toggle("is-hidden", !showConfirm);
  consensusBanner.classList.remove("is-hidden");
}

function renderCorrectionScopeHint() {
  if (!correctionScopeHint) return;
  const versionCount = Array.isArray(state.selectedGroup?.items)
    ? state.selectedGroup.items.length
    : 0;
  if (versionCount > 1) {
    correctionScopeHint.textContent = `Opravujete polohu celé série (${versionCount} verzí).`;
    correctionScopeHint.classList.remove("is-hidden");
    return;
  }
  correctionScopeHint.textContent = "";
  correctionScopeHint.classList.add("is-hidden");
}

function renderDetails(feature) {
  renderDetailMiniMap(feature);
  if (!detailContainer) return;
  if (!window.OldPragueMeta?.renderDetails) return;
  const group = state.selectedGroup;
  const correction = getCorrectionForFeature(feature);
  window.OldPragueMeta.renderDetails(detailContainer, feature, state.archiveBaseUrl, {
    groupItems: group?.items || [],
    selectedId: feature?.properties?.id || "",
    correctionStatus: correction,
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
  renderConsensusStatus(feature);
  renderCorrectionScopeHint();
}

function prepareGroupSearchIndex() {
  state.groups.forEach((group) => {
    group.searchDocument = buildGroupSearchDocument(group);
  });
}

function buildNearbyGroupIds(group) {
  const lat = Number(group?.lat);
  const lon = Number(group?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const groups = getActiveGroups();
  return groups
    .filter((item) => Number.isFinite(item?.lat) && Number.isFinite(item?.lon))
    .map((item) => ({
      id: item.id,
      distanceKm: haversineDistanceKm(lat, lon, Number(item.lat), Number(item.lon)),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .map((item) => item.id);
}

function updateNearbyNavigation(options = {}) {
  const { preserveAnchor = false } = options;
  if (!nearbyPrevBtn || !nearbyNextBtn || !nearbyState) return;
  if (!state.selectedGroup) {
    nearbyPrevBtn.disabled = true;
    nearbyNextBtn.disabled = true;
    nearbyState.textContent = "—";
    state.nearbyGroupIds = [];
    state.nearbyIndex = -1;
    state.nearbyAnchorGroupId = "";
    return;
  }
  const activeGroups = getActiveGroups();
  const keepExistingList =
    preserveAnchor &&
    Array.isArray(state.nearbyGroupIds) &&
    state.nearbyGroupIds.length === activeGroups.length &&
    state.nearbyGroupIds.includes(state.selectedGroup.id) &&
    state.nearbyAnchorGroupId;
  const nearbyIds = keepExistingList
    ? state.nearbyGroupIds
    : buildNearbyGroupIds(state.selectedGroup);
  if (!keepExistingList) {
    state.nearbyAnchorGroupId = state.selectedGroup.id;
  }
  const currentIndex = nearbyIds.indexOf(state.selectedGroup.id);
  state.nearbyGroupIds = nearbyIds;
  state.nearbyIndex = currentIndex;
  const total = nearbyIds.length;

  nearbyPrevBtn.disabled = currentIndex <= 0;
  nearbyNextBtn.disabled = currentIndex < 0 || currentIndex >= total - 1;
  nearbyState.textContent =
    currentIndex >= 0 && total > 0 ? `${currentIndex + 1}/${total}` : "—";
}

function goToNearbyGroup(delta) {
  const index = state.nearbyIndex + delta;
  if (index < 0 || index >= state.nearbyGroupIds.length) return;
  const groupId = state.nearbyGroupIds[index];
  if (!groupId) return;
  const nextGroup = state.groupById.get(groupId);
  if (!nextGroup) return;
  selectGroup(nextGroup, {
    openModal: true,
    updateHistory: true,
    panTo: true,
    preserveNearby: true,
  });
}

function renderPhotoGrid(options = {}) {
  const { reset = false } = options;
  if (!photoGrid || !photoGridLoadMore) return;

  const groups = getMapVisibleGroups(getActiveGroups());
  if (reset) {
    state.gridVisibleCount = state.gridPageSize;
  }
  state.gridVisibleCount = Math.max(state.gridPageSize, state.gridVisibleCount);

  if (!groups.length) {
    photoGrid.innerHTML = "";
    photoGridLoadMore.classList.add("is-hidden");
    photoGridLoadMore.disabled = true;
    if (photoGridCount) photoGridCount.textContent = "0";
    if (photoGridEmpty) photoGridEmpty.classList.remove("is-hidden");
    return;
  }

  if (photoGridEmpty) photoGridEmpty.classList.add("is-hidden");

  const visibleCount = Math.min(state.gridVisibleCount, groups.length);
  const visibleGroups = groups.slice(0, visibleCount);

  const fallbackTitle = (group) => escapeHtml(getGroupTitle(group));
  const fallbackSubtitle = (group) => escapeHtml(getGroupSubtitle(group));

  photoGrid.innerHTML = visibleGroups
    .map((group) => {
      const feature = group?.primary;
      const props = feature?.properties || {};
      const xid = String(props.id || "");
      const localPreview = getGridPreviewCandidate(feature);
      const fallbackAttr = localPreview.fallback
        ? ` data-fallback-src="${escapeHtml(localPreview.fallback)}"`
        : "";
      const isActive = state.selectedGroup?.id === group?.id;
      return `
        <button class="photo-card${isActive ? " is-active" : ""}" type="button" data-group-id="${escapeHtml(group.id)}" data-xid="${escapeHtml(xid)}">
          <div class="photo-card-media">
            <img
              class="photo-card-image${localPreview.url ? "" : " is-hidden"}"
              data-xid="${escapeHtml(xid)}"
              src="${escapeHtml(localPreview.url)}"
              alt="Náhled fotografie"
              loading="lazy"
              ${fallbackAttr}
            />
            <div class="photo-card-placeholder${localPreview.url ? " is-hidden" : ""}" data-placeholder-xid="${escapeHtml(xid)}">
              Bez náhledu
            </div>
          </div>
          <div class="photo-card-body">
            <p class="photo-card-title">${fallbackTitle(group)}</p>
            <p class="photo-card-meta">${fallbackSubtitle(group)}</p>
          </div>
        </button>
      `;
    })
    .join("");

  if (photoGridCount) {
    photoGridCount.textContent = `Zobrazeno ${visibleCount.toLocaleString()} z ${groups.length.toLocaleString()}`;
  }

  const hasMore = visibleCount < groups.length;
  photoGridLoadMore.classList.toggle("is-hidden", !hasMore);
  photoGridLoadMore.disabled = !hasMore;

  photoGrid.querySelectorAll(".photo-card").forEach((card) => {
    card.addEventListener("click", () => {
      const groupId = String(card.dataset.groupId || "").trim();
      if (!groupId || !state.groupById.has(groupId)) return;
      selectGroup(state.groupById.get(groupId), {
        openModal: true,
        updateHistory: true,
        panTo: true,
      });
    });
  });

  photoGrid.querySelectorAll(".photo-card-image").forEach((image) => {
    if (!(image instanceof HTMLImageElement)) return;
    image.addEventListener("error", () => {
      const fallback = String(image.dataset.fallbackSrc || "").trim();
      if (!fallback || image.dataset.fallbackApplied === "1") return;
      image.dataset.fallbackApplied = "1";
      image.src = fallback;
    });
  });

  visibleGroups.forEach((group) => {
    const feature = group?.primary;
    const xid = String(feature?.properties?.id || "").trim();
    if (!xid) return;
    if (getGridPreviewCandidate(feature).url) return;
    resolvePreviewUrl(feature).then((url) => {
      if (!photoGrid) return;
      const resolvedPreview = getGridPreviewCandidateFromResolved(url);
      if (!resolvedPreview.url) return;
      const xidSelector = escapeSelectorValue(xid);
      const image = photoGrid.querySelector(`img[data-xid="${xidSelector}"]`);
      const placeholder = photoGrid.querySelector(
        `[data-placeholder-xid="${xidSelector}"]`,
      );
      if (!(image instanceof HTMLImageElement)) return;
      image.src = resolvedPreview.url;
      if (resolvedPreview.fallback) {
        image.dataset.fallbackSrc = resolvedPreview.fallback;
        delete image.dataset.fallbackApplied;
      } else {
        delete image.dataset.fallbackSrc;
        delete image.dataset.fallbackApplied;
      }
      image.classList.remove("is-hidden");
      if (placeholder instanceof HTMLElement) {
        placeholder.classList.add("is-hidden");
      }
    });
  });
}

function buildMarkerIcon(markerState = "") {
  const className = markerState ? `marker-dot is-${markerState}` : "marker-dot";
  return L.divIcon({
    className,
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

function getZoomifyPathFromFeature(feature) {
  const props = feature?.properties || {};
  const zoomifyPaths = props.scan_zoomify_paths;
  if (!Array.isArray(zoomifyPaths)) return "";
  const firstPath = zoomifyPaths.find(
    (item) => typeof item === "string" && item.trim().length > 0,
  );
  return firstPath ? firstPath.trim().replace(/\/$/, "") : "";
}

function buildZoomifyTileUrl(zoomifyPath, level = 0) {
  const base = String(zoomifyPath || "").trim().replace(/\/$/, "");
  if (!base) return "";
  const tileLevel =
    Number.isInteger(level) && level >= 0 ? level : Math.max(0, Number(level) || 0);
  return `${base}/TileGroup0/${tileLevel}-0-0.jpg`;
}

function getGridPreviewCandidate(feature) {
  const zoomifyPath = getZoomifyPathFromFeature(feature);
  if (zoomifyPath) {
    return {
      url: buildZoomifyTileUrl(zoomifyPath, 1),
      fallback: buildZoomifyTileUrl(zoomifyPath, 0),
    };
  }
  return { url: getPreviewFromFeature(feature), fallback: "" };
}

function getGridPreviewCandidateFromResolved(url) {
  const fallback = String(url || "").trim();
  if (!fallback) return { url: "", fallback: "" };
  const upgraded = fallback.replace(
    /\/TileGroup(\d+)\/0-0-0\.jpg(\?.*)?$/i,
    "/TileGroup$1/1-0-0.jpg$2",
  );
  return {
    url: upgraded,
    fallback: upgraded === fallback ? "" : fallback,
  };
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
    try {
      const url = await loadPreviewUrl(xid);
      state.previewByXid.set(xid, url || null);
      return url || "";
    } catch (error) {
      const local = getPreviewFromFeature(feature);
      state.previewByXid.set(xid, local || null);
      return local || "";
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
  state.map.on("moveend", () => {
    renderPhotoGrid();
  });
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

  groups.forEach((group) => {
    if (!group) return;
    const lat = Number(group.lat);
    const lon = Number(group.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const correction = state.correctionsByGroup.get(group.id);
    const markerState =
      correction?.correction_state === "pending"
        ? "pending"
        : correction?.correction_state === "approved"
          ? "approved"
          : "";
    const icon = buildMarkerIcon(markerState);
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
  updateNearbyNavigation({ preserveAnchor: options.preserveNearby === true });
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
  renderPhotoGrid();
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

function rebuildGroupIndexes() {
  const grouping = window.OldPragueGrouping;
  const groupIndex = grouping.buildGroups(state.features);
  state.groups = groupIndex.groups;
  state.groupById = groupIndex.groupById;
  state.groupByXid = groupIndex.groupByXid;
  state.featuresById = groupIndex.featureById;
  prepareGroupSearchIndex();
}

function applyReviewStatePayload(reviewState = {}) {
  const grouping = window.OldPragueGrouping;
  const appliedReviewState = grouping.applyReviewState(state.features, reviewState);
  state.correctionsByGroup = appliedReviewState.correctionByGroup;
  state.reviewCounts = reviewState?.counts || {};
  rebuildGroupIndexes();
}

function updateVerifiedCount(reviewState = null) {
  const verifiedCount = document.getElementById("verified-count");
  if (!verifiedCount) return;
  const value =
    Number(reviewState?.counts?.doneGroups) ||
    Number(state.reviewCounts?.doneGroups) ||
    0;
  verifiedCount.textContent = value.toLocaleString();
}

async function refreshReviewState(options = {}) {
  const { fresh = false } = options;
  const selectedXid = state.selectedFeature?.properties?.id || "";
  const reviewState = await fetchJson(
    fresh ? "/api/review-state?fresh=1" : "/api/review-state",
  );
  applyReviewStatePayload(reviewState);
  updateVerifiedCount(reviewState);
  if (Number.isFinite(state.yearFilterMin) && Number.isFinite(state.yearFilterMax)) {
    applyYearFilter({ fitBounds: false });
  } else {
    addMarkers(state.groups, { fitBounds: false });
    renderPhotoGrid();
    updateNearbyNavigation();
  }

  if (selectedXid && state.featuresById.has(selectedXid)) {
    const group = state.groupByXid.get(selectedXid);
    if (group) {
      state.selectedGroup = group;
      state.selectedFeature = state.featuresById.get(selectedXid);
      renderDetails(state.selectedFeature);
    }
  }
  return reviewState;
}

async function submitModalVerdict(verdict) {
  if (!state.selectedFeature) return;
  const groupId = resolveGroupIdForFeature(state.selectedFeature);
  const payload = {
    xid: state.selectedFeature.properties.id,
    group_id: groupId || undefined,
    verdict,
    message:
      verdict === "ok"
        ? "Poloha potvrzena jako správná."
        : "Nahlášeno bez upřesnění polohy.",
  };
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
  } else {
    const response = await sendRequest();
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Odeslání selhalo");
    }
  }
  await refreshReviewState({ fresh: true });
  if (verdict === "ok") {
    if (consensusText) {
      consensusText.textContent = "Díky! Potvrzení bylo uloženo.";
    }
  } else if (consensusText) {
    consensusText.textContent =
      "Díky! Hlášení bylo uloženo a čeká na potvrzení.";
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = String(payload?.detail || payload?.message || "");
    } catch (error) {
      detail = "";
    }
    const withDetail = detail
      ? `Požadavek selhal: ${response.status} (${detail})`
      : `Požadavek selhal: ${response.status}`;
    throw new Error(withDetail);
  }
  return response.json();
}

async function bootstrap() {
  const config = await fetchJson("/api/config").catch(() => ({}));
  state.archiveBaseUrl = config.archiveBaseUrl || "";

  let photos;
  try {
    photos = await fetchJson("/data/photos.geojson");
  } catch (error) {
    photos = await fetchJson("/api/photos");
  }
  const mediaFilter = window.OldPragueMediaFilter;
  if (mediaFilter?.filterPhotoCollection) {
    photos = await mediaFilter.filterPhotoCollection(photos);
  }

  initMap();

  const features = photos.features || [];
  state.features = features;
  const reviewState = await fetchJson("/api/review-state").catch(() => ({}));
  applyReviewStatePayload(reviewState);

  initYearFilter();
  renderDetails(null);
  updateVerifiedCount(reviewState);

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
      onSubmit: async () => {
        if (metaView) metaView.classList.remove("is-hidden");
        if (correctionView) correctionView.classList.add("is-hidden");
        if (reportCtaWrap) reportCtaWrap.classList.remove("is-hidden");
        invalidateDetailMiniMap();
        await refreshReviewState({ fresh: true });
      },
      onCancel: () => {
        if (metaView) metaView.classList.remove("is-hidden");
        if (correctionView) correctionView.classList.add("is-hidden");
        invalidateDetailMiniMap();
      },
    });
  }

  initSearch();
}

function initSearch() {
  const searchInput = document.getElementById("map-search");
  const searchResults = document.getElementById("search-results");
  const searchAddressToggle = document.getElementById("search-address-toggle");
  if (!searchInput || !searchResults) return;

  let debounceTimer;
  let searchToken = 0;

  const triggerSearch = () => {
    clearTimeout(debounceTimer);
    const query = searchInput.value.trim();
    if (query.length < 2) {
      searchResults.classList.add("is-hidden");
      searchResults.innerHTML = "";
      return;
    }

    const currentToken = ++searchToken;
    debounceTimer = setTimeout(async () => {
      try {
        const metadataResults = findMetadataMatches(query, 14);
        let addressResults = [];
        if (searchAddressToggle?.checked && query.length >= 3) {
          try {
            addressResults = await fetchGeocode(query);
          } catch (error) {
            addressResults = [];
          }
        }
        if (currentToken !== searchToken) return;
        renderSearchResults(
          {
            query,
            metadataResults,
            addressResults,
          },
          searchResults,
          searchInput,
        );
      } catch (err) {
        console.error("Vyhledávání selhalo", err);
      }
    }, 260);
  };

  searchInput.addEventListener("input", triggerSearch);
  if (searchAddressToggle) {
    searchAddressToggle.addEventListener("change", triggerSearch);
  }

  document.addEventListener("click", (e) => {
    if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
      searchResults.classList.add("is-hidden");
    }
  });
}

async function fetchGeocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query + ", Praha")}&limit=6`;
  const response = await fetch(url, {
    headers: { "Accept-Language": "cs-CZ" }
  });
  if (!response.ok) throw new Error("Chyba při hledání");
  return response.json();
}

function findMetadataMatches(query, limit = 12) {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = normalizedQuery.split(/\s+/).filter((token) => token.length >= 2);
  if (!tokens.length) return [];

  const groups = getActiveGroups();
  const ranked = [];

  groups.forEach((group) => {
    const document = String(group?.searchDocument || "");
    if (!document) return;

    let score = 0;
    for (const token of tokens) {
      if (!document.includes(token)) return;
      score += 10;
    }

    const phraseIndex = document.indexOf(normalizedQuery);
    if (phraseIndex >= 0) {
      score += 40 - Math.min(30, phraseIndex / 15);
    }

    const groupId = normalizeSearchText(group?.id || "");
    if (groupId && groupId.includes(normalizedQuery)) score += 25;

    const title = normalizeSearchText(getGroupTitle(group));
    if (title && title.includes(normalizedQuery)) score += 15;

    ranked.push({ group, score, phraseIndex });
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aIndex = a.phraseIndex >= 0 ? a.phraseIndex : Number.MAX_SAFE_INTEGER;
    const bIndex = b.phraseIndex >= 0 ? b.phraseIndex : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return String(a.group?.id || "").localeCompare(String(b.group?.id || ""), "cs");
  });

  return ranked.slice(0, limit).map((entry) => entry.group);
}

function renderSearchResults(payload, container, searchInput) {
  const metadataResults = Array.isArray(payload?.metadataResults)
    ? payload.metadataResults
    : [];
  const addressResults = Array.isArray(payload?.addressResults)
    ? payload.addressResults
    : [];

  if (!metadataResults.length && !addressResults.length) {
    container.innerHTML = `
      <div class="search-section-title">Výsledky</div>
      <div class="search-empty">Nic nenalezeno.</div>
    `;
    container.classList.remove("is-hidden");
    return;
  }

  const metadataSection = metadataResults.length
    ? `
      <div class="search-section-title">Fotografie (metadata)</div>
      ${metadataResults
        .map((group) => {
          const feature = group?.primary;
          const xid = String(feature?.properties?.id || "");
          return `
            <div class="search-item search-item-kind-meta" data-type="metadata" data-group-id="${escapeHtml(group.id)}" data-xid="${escapeHtml(xid)}">
              <p class="search-item-title">${escapeHtml(getGroupTitle(group))}</p>
              <p class="search-item-meta">${escapeHtml(getGroupSubtitle(group) || group.id)}</p>
            </div>
          `;
        })
        .join("")}
    `
    : "";

  const addressSection = addressResults.length
    ? `
      <div class="search-section-title">Adresy (OSM)</div>
      ${addressResults
        .map(
          (result) => `
            <div class="search-item search-item-kind-address" data-type="address" data-lat="${escapeHtml(result.lat)}" data-lon="${escapeHtml(result.lon)}">
              <p class="search-item-title">${escapeHtml(
                String(result.display_name || "")
                  .split(",")
                  .slice(0, 3)
                  .join(","),
              )}</p>
              <p class="search-item-meta">Adresní výsledek</p>
            </div>
          `,
        )
        .join("")}
    `
    : "";

  container.innerHTML = `${metadataSection}${addressSection}`;
  container.classList.remove("is-hidden");

  container.querySelectorAll(".search-item").forEach((item) => {
    item.addEventListener("click", () => {
      const type = String(item.dataset.type || "");
      if (type === "metadata") {
        const groupId = String(item.dataset.groupId || "").trim();
        const xid = String(item.dataset.xid || "").trim();
        if (!groupId || !state.groupById.has(groupId)) return;
        const group = state.groupById.get(groupId);
        selectGroup(group, {
          openModal: true,
          updateHistory: true,
          panTo: true,
          selectedXid: xid || undefined,
        });
        searchInput.value = getGroupTitle(group);
      } else {
        const lat = parseFloat(item.dataset.lat);
        const lon = parseFloat(item.dataset.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon) && state.map) {
          state.map.setView([lat, lon], 16, { animate: true });
        }
        const titleEl = item.querySelector(".search-item-title");
        searchInput.value = titleEl?.textContent?.trim() || item.textContent.trim();
      }
      container.classList.add("is-hidden");
    });
  });
}

feedbackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  window.CorrectionUI?.submit();
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

if (reportFlagBtn) {
  reportFlagBtn.addEventListener("click", async () => {
    try {
      await submitModalVerdict("flag");
      renderConsensusStatus(state.selectedFeature);
    } catch (error) {
      const message = error?.message || "Odeslání selhalo";
      if (consensusText) consensusText.textContent = message;
      if (consensusBanner) consensusBanner.classList.remove("is-hidden");
    }
  });
}

if (confirmCta) {
  confirmCta.addEventListener("click", async () => {
    try {
      await submitModalVerdict("ok");
      renderConsensusStatus(state.selectedFeature);
    } catch (error) {
      const message = error?.message || "Odeslání selhalo";
      if (consensusText) consensusText.textContent = message;
      if (consensusBanner) consensusBanner.classList.remove("is-hidden");
    }
  });
}

if (photoGridLoadMore) {
  photoGridLoadMore.addEventListener("click", () => {
    state.gridVisibleCount += state.gridPageSize;
    renderPhotoGrid();
  });
}

if (nearbyPrevBtn) {
  nearbyPrevBtn.addEventListener("click", () => goToNearbyGroup(-1));
}

if (nearbyNextBtn) {
  nearbyNextBtn.addEventListener("click", () => goToNearbyGroup(1));
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
