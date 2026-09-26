// MAPY_CZ_API_KEY is defined in correction-ui.js

const state = {
  map: null,
  cluster: null,
  selectedGroup: null,
  selectedFeature: null,
  archiveBaseUrl: "",
  r2TilesBase: "",
  fullResDownloadMode: "server",
  featuresById: new Map(),
  groupById: new Map(),
  groupByXid: new Map(),
  correctionsByGroup: new Map(),
  reviewCounts: {},
  overlapCluster: null,
  clusteringEnabled: true,
  features: [],
  groups: [],
  yearFilteredGroups: [],
  filteredGroups: [],
  searchFilter: null,
  searchIndex: null,
  searchApi: null,
  searchUI: null,
  searchQuery: "",
  searchQueryNormalized: "",
  yearMin: null,
  yearMax: null,
  yearFilterMin: null,
  yearFilterMax: null,
  yearUnknownGroups: 0,
  yearIncludeUnknown: true,
  yearImpreciseGroups: 0,
  yearIncludeImprecise: true,
  previewPopup: null,
  previewByXid: new Map(),
  previewPromiseByXid: new Map(),
  previewPrefetchByUrl: new Map(),
  prefetchedPreviewUrls: new Set(),
  previewProximityPrefetchedXids: new Set(),
  previewHoverToken: 0,
  previewHideTimer: null,
  previewActiveXid: "",
  previewProximityTimer: null,
  previewProximityRaf: 0,
  previewProximityLastAt: 0,
  previewProximityLastEvent: null,
  previewProximityActiveGroupId: "",
  clusterPreviewMarkers: [],
  overlapPreviewMarkers: [],
  gridVisibleCount: 24,
  gridPageSize: 24,
  nearbyGroupIds: [],
  nearbyIndex: -1,
  nearbyAnchorGroupId: "",
  detailMiniMap: null,
  detailMiniMarker: null,
  scanIndexByXid: new Map(),
  reviewStateReady: false,
  submittingContribution: false,
};

const detailContainer = document.getElementById("photo-details");
const photoCount = document.getElementById("photo-count");
const feedbackForm = document.getElementById("feedback-form");
const formStatus = document.getElementById("form-status");
const turnstileNote = document.getElementById("turnstile-note");
const archiveModal = document.getElementById("archive-modal");
let archiveModalPreviousFocus = null;
const archiveIframe = document.getElementById("archive-iframe");
const archivePreview = document.getElementById("archive-preview");
const archiveUnavailable = document.getElementById("archive-unavailable");
const archiveFallback = document.getElementById("archive-fallback");
const downloadFullResBtn = document.getElementById("download-fullres");
const downloadFullResStatus = document.getElementById("download-fullres-status");
const zoomWrap = archiveIframe?.closest(".zoom-wrap");
const zoomViewerEl = document.getElementById("zoom-viewer");
const reportCta = document.getElementById("report-cta");
const photoFeedbackCta = document.getElementById("photo-feedback-cta");
const photoFeedbackView = document.getElementById("modal-photo-feedback-view");
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
const yearImpreciseToggle = document.getElementById("year-imprecise-toggle");
const yearImpreciseCount = document.getElementById("year-imprecise-count");
const yearImpreciseToggleWrap =
  yearImpreciseToggle?.closest(".year-filter-toggle");
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
const clusterWarning = document.getElementById("cluster-warning");
const clusterWarningContinue = document.getElementById("cluster-warning-continue");
const clusterWarningCancel = document.getElementById("cluster-warning-cancel");

const infoModal = document.getElementById("info-modal");
const infoOpenBtn = document.getElementById("info-open");
let infoModalPreviousFocus = null;

const PRAGUE_CENTRE = [50.0850, 14.4200];
const OSM_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> přispěvatelé';
const MAPY_ATTR = '&copy; <a href="https://www.mapy.cz">Mapy.cz</a>';
const FULL_RES_CLIENT_MAX_PIXELS = 80_000_000;
const FULL_RES_MODE_SERVER = "server";
const FULL_RES_MODE_CLIENT = "client";
const PREVIEW_PROXIMITY_RADIUS_PX = 48;
const PREVIEW_PROXIMITY_THROTTLE_MS = 75;

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
    photoCount.textContent = totalCount.toLocaleString("cs-CZ");
    return;
  }
  photoCount.textContent = `${visibleCount.toLocaleString("cs-CZ")} / ${totalCount.toLocaleString("cs-CZ")}`;
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

function getSearchBaseGroups() {
  return Array.isArray(state.yearFilteredGroups)
    ? state.yearFilteredGroups
    : state.groups;
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
  if (group?.items?.length > 1) parts.push(window.OldPragueMeta.formatPhotoCount(group.items.length));
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

function isFeatureDateImprecise(feature) {
  const props = feature?.properties || {};
  if (typeof props.date_imprecise === "boolean") {
    return props.date_imprecise;
  }
  if (typeof props.date_imprecise === "string") {
    const normalized = props.date_imprecise.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }

  const start = String(props.start_date || "").trim();
  const end = String(props.end_date || "").trim();
  return start === "1800-01-01" || end === "2000-12-31";
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
  let impreciseGroups = 0;

  (groups || []).forEach((group) => {
    const range = getGroupYearRange(group);
    if (!range) {
      group.yearMin = null;
      group.yearMax = null;
      group.yearImprecise = false;
      unknownGroups += 1;
      return;
    }
    group.yearMin = range.min;
    group.yearMax = range.max;
    group.yearImprecise = (group.items || []).some((feature) =>
      isFeatureDateImprecise(feature),
    );
    if (group.yearImprecise) impreciseGroups += 1;
    if (range.min < minYear) minYear = range.min;
    if (range.max > maxYear) maxYear = range.max;
  });

  if (!Number.isFinite(minYear) || !Number.isFinite(maxYear)) {
    return null;
  }
  return { minYear, maxYear, unknownGroups, impreciseGroups };
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
  // Ratios, not measured pixels: the slider may be hidden or still laying out.
  yearSliderWrap.style.setProperty("--range-start-ratio", String(startRatio));
  yearSliderWrap.style.setProperty("--range-end-ratio", String(endRatio));
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
    if (!state.yearIncludeImprecise && group?.yearImprecise) {
      return false;
    }
    return groupMax >= minYear && groupMin <= maxYear;
  });
}

function filterGroupsByMetadataQuery(groups, query) {
  if (!Array.isArray(groups)) return [];
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery || normalizedQuery.length < 2) {
    return groups;
  }
  const tokens = normalizedQuery
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  if (!tokens.length) {
    return groups;
  }
  return groups.filter((group) => {
    const document = String(group?.searchDocument || "");
    if (!document) return false;
    return tokens.every((token) => document.includes(token));
  });
}

function setSearchFilter(query, options = {}) {
  const { enabled = true } = options;
  state.searchQuery = String(query || "");
  const normalizedQuery = enabled ? normalizeSearchText(query) : "";
  const next = normalizedQuery.length >= 2 ? normalizedQuery : "";
  const changed = next !== state.searchQueryNormalized;
  state.searchQueryNormalized = next;
  return changed;
}

function applyYearFilter(options = {}) {
  const { fitBounds = false } = options;
  if (!Array.isArray(state.groups) || !state.groups.length) {
    state.yearFilteredGroups = [];
    state.filteredGroups = [];
    updatePhotoCount(0);
    renderPhotoGrid({ reset: true });
    updateNearbyNavigation();
    return;
  }
  const minYear = state.yearFilterMin;
  const maxYear = state.yearFilterMax;
  const yearFiltered = filterGroupsByYear(state.groups, minYear, maxYear);
  state.yearFilteredGroups = yearFiltered;
  const filter = state.searchFilter;
  const filtered = filter?.type === 'place' || filter?.type === 'author'
    ? yearFiltered.filter((group) => group.items.some((feature) =>
      (feature.properties?.[filter.type === 'place' ? 'places' : 'authors'] || [])
        .some((entity) => entity.id === filter.id)))
    : filterGroupsByMetadataQuery(yearFiltered, state.searchQueryNormalized);
  state.filteredGroups = filtered;
  addMarkers(filtered, { fitBounds });
  updatePhotoCount(filtered.length);
  updateFiltersIndicator();
  renderPhotoGrid({ reset: true });
  updateNearbyNavigation();
  state.searchUI?.refresh();
}

function updateFiltersIndicator() {
  const dot = document.getElementById("filters-active");
  if (!dot) return;
  const yearNarrowed =
    (Number.isFinite(state.yearMin) && state.yearFilterMin > state.yearMin) ||
    (Number.isFinite(state.yearMax) && state.yearFilterMax < state.yearMax);
  dot.hidden = !(
    yearNarrowed ||
    (!state.yearIncludeUnknown && !yearUnknownToggle?.disabled) ||
    (!state.yearIncludeImprecise && !yearImpreciseToggle?.disabled) ||
    !state.clusteringEnabled
  );
}

function initFiltersToggle() {
  const toggle = document.getElementById("filters-toggle");
  const panel = document.getElementById("map-controls");
  if (!toggle || !panel) return;
  toggle.addEventListener("click", () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    // The map shrinks or grows with the panel; let Leaflet re-measure.
    requestAnimationFrame(() => state.map?.invalidateSize());
  });
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
  state.yearFilteredGroups = state.groups;
  const stats = computeGroupYearStats(state.groups);
  if (!yearMinInput || !yearMaxInput || !stats) {
    applyYearFilter({ fitBounds: false });
    return;
  }

  state.yearMin = stats.minYear;
  state.yearMax = stats.maxYear;
  state.yearFilterMin = stats.minYear;
  state.yearFilterMax = stats.maxYear;
  state.yearUnknownGroups = stats.unknownGroups;
  state.yearImpreciseGroups = stats.impreciseGroups;

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
      ? `(${stats.unknownGroups.toLocaleString("cs-CZ")})`
      : "";
  }
  if (yearImpreciseToggle) {
    const hasImprecise = stats.impreciseGroups > 0;
    yearImpreciseToggle.checked = hasImprecise;
    yearImpreciseToggle.disabled = !hasImprecise;
    state.yearIncludeImprecise = hasImprecise;
    if (yearImpreciseToggleWrap) {
      yearImpreciseToggleWrap.classList.toggle("is-hidden", !hasImprecise);
    }
  }
  if (yearImpreciseCount) {
    yearImpreciseCount.textContent = stats.impreciseGroups
      ? `(${stats.impreciseGroups.toLocaleString("cs-CZ")})`
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
  if (yearImpreciseToggle) {
    yearImpreciseToggle.addEventListener("change", () => {
      state.yearIncludeImprecise = yearImpreciseToggle.checked;
      applyYearFilter({ fitBounds: false });
    });
  }

  applyYearFilter({ fitBounds: false });
}

let zoomViewer = null;
let zoomLastKey = "";
let zoomLoadToken = 0;
let fullResAvailabilityToken = 0;
let fullResDownloadBusy = false;
const fullResMetaByKey = new Map();

function buildZoomKey(xid, scanIndex = 0) {
  const normalizedScanIndex =
    Number.isInteger(scanIndex) && scanIndex >= 0 ? scanIndex : 0;
  return `${String(xid || "").trim()}::${normalizedScanIndex}`;
}

function getScanIndex(xid) {
  if (!xid) return 0;
  return state.scanIndexByXid.get(xid) ?? 0;
}

function setScanIndex(xid, scanIndex) {
  if (!xid || !Number.isFinite(scanIndex)) return;
  state.scanIndexByXid.set(xid, Math.max(0, Number(scanIndex)));
}

async function loadZoomifyMeta(xid, scanIndex = 0) {
  const normalizedScanIndex =
    Number.isInteger(scanIndex) && scanIndex >= 0 ? scanIndex : 0;
  const url = `/api/zoomify?xid=${encodeURIComponent(xid)}&scanIndex=${encodeURIComponent(
    String(normalizedScanIndex),
  )}`;
  return fetchJson(url);
}

async function loadPreviewUrl(xid, scanIndex = 0) {
  const normalizedScanIndex =
    Number.isInteger(scanIndex) && scanIndex >= 0 ? scanIndex : 0;
  const url = `/api/preview-url?xid=${encodeURIComponent(xid)}&scanIndex=${encodeURIComponent(
    String(normalizedScanIndex),
  )}`;
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

function getLocalPreviewForFeature(feature, scanIndex = 0, options = {}) {
  const { allowR2Guess = true } = options;
  if (!feature) return "";
  const xid = String(feature?.properties?.id || "").trim();
  if (allowR2Guess) {
    const r2Preview = buildR2PreviewTileUrl(xid, scanIndex);
    if (r2Preview) return r2Preview;
  }

  const props = feature?.properties || {};
  const previews = Array.isArray(props.scan_previews) ? props.scan_previews : [];
  if (
    Number.isInteger(scanIndex) &&
    scanIndex >= 0 &&
    scanIndex < previews.length
  ) {
    const indexedPreview = String(previews[scanIndex] || "").trim();
    if (indexedPreview) return indexedPreview;
  }

  const preview = getPreviewFromFeature(feature);
  if (preview) return preview;
  return buildZoomifyTileUrl(getZoomifyPathFromFeature(feature, scanIndex), 0);
}

async function loadZoomifyInto(
  viewerEl,
  wrapEl,
  previewImgEl,
  xid,
  feature = null,
  scanIndex = 0,
) {
  if (!viewerEl || !wrapEl) return;
  const normalizedScanIndex =
    Number.isInteger(scanIndex) && scanIndex >= 0 ? scanIndex : 0;
  const requestKey = buildZoomKey(xid, normalizedScanIndex);
  if (zoomLastKey === requestKey) return;

  const requestToken = ++zoomLoadToken;
  zoomLastKey = requestKey;
  const previewFeature = feature || state.featuresById.get(xid) || null;
  wrapEl.classList.remove("is-fallback", "is-unavailable");
  wrapEl.classList.add("is-loading");
  if (archiveUnavailable) {
    archiveUnavailable.textContent = "";
  }

  const localPreviewUrl = getLocalPreviewForFeature(
    previewFeature,
    normalizedScanIndex,
    { allowR2Guess: normalizedScanIndex === 0 },
  );
  if (previewImgEl && localPreviewUrl) {
    previewImgEl.src = localPreviewUrl;
  }
  const shouldUseRevealTimer = !localPreviewUrl;

  const previewUrlPromise = previewImgEl
    ? (async () => {
        if (previewFeature) {
          if (normalizedScanIndex === 0) {
            const resolved = await resolvePreviewUrl(previewFeature).catch(
              () => "",
            );
            if (resolved) return resolved;
          }
          const local = getLocalPreviewForFeature(
            previewFeature,
            normalizedScanIndex,
            { allowR2Guess: false },
          );
          if (local) return local;
        }
        return loadPreviewUrl(xid, normalizedScanIndex).catch(() => "");
      })()
    : Promise.resolve("");
  if (previewImgEl) {
    previewUrlPromise.then((previewUrl) => {
      if (!previewUrl) return;
      if (requestToken !== zoomLoadToken || zoomLastKey !== requestKey) return;
      previewImgEl.src = previewUrl;
    });
  }

  try {
    if (!window.OpenSeadragon) {
      throw new Error("OpenSeadragon chybí");
    }

    const meta = await loadZoomifyMeta(xid, normalizedScanIndex);
    if (requestToken !== zoomLoadToken || zoomLastKey !== requestKey) return;

    if (!zoomViewer) {
      zoomViewer = window.OpenSeadragon({
        element: viewerEl,
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
    const revealReadyImage = () => {
      if (requestToken !== zoomLoadToken || zoomLastKey !== requestKey) return;
      wrapEl.classList.remove("is-loading");
    };

    let revealTimer = null;
    const clearRevealTimer = () => {
      if (!revealTimer) return;
      window.clearTimeout(revealTimer);
      revealTimer = null;
    };

    if (typeof zoomViewer.addOnceHandler === "function") {
      zoomViewer.addOnceHandler("tile-drawn", () => {
        clearRevealTimer();
        revealReadyImage();
      });
      zoomViewer.addOnceHandler("open-failed", () => {
        clearRevealTimer();
        revealReadyImage();
      });
    }

    zoomViewer.open(window.OldPragueZoomify.createTileSource(meta));

    if (shouldUseRevealTimer) {
      revealTimer = window.setTimeout(() => {
        revealTimer = null;
        revealReadyImage();
      }, 1400);
    }
  } catch (error) {
    if (requestToken !== zoomLoadToken || zoomLastKey !== requestKey) return;
    console.warn("Zoom náhled selhal", error);
    const previewUrl = await previewUrlPromise;
    if (requestToken !== zoomLoadToken || zoomLastKey !== requestKey) return;
    wrapEl.classList.remove("is-loading");

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

function getArchiveUrl(feature, scanIndex = 0) {
  if (!feature || !state.archiveBaseUrl) return "";
  const normalizedScanIndex =
    Number.isInteger(scanIndex) && scanIndex >= 0 ? scanIndex : 0;
  const scanParam = normalizedScanIndex + 1;
  return `${state.archiveBaseUrl}/permalink?xid=${feature.properties.id}&scan=${scanParam}#scan${scanParam}`;
}

function setFullResStatus(message = "", tone = "") {
  if (!downloadFullResStatus) return;
  downloadFullResStatus.textContent = String(message || "");
  downloadFullResStatus.dataset.tone = String(tone || "");
}

function setFullResButtonEnabled(enabled) {
  if (!downloadFullResBtn) return;
  downloadFullResBtn.disabled = !enabled;
}

function setFullResUnavailable(reason) {
  setFullResButtonEnabled(false);
  setFullResStatus(reason, "error");
}

function getCurrentFullResSelection(featureOverride = null) {
  const feature = featureOverride || state.selectedFeature;
  const xid = String(feature?.properties?.id || "").trim();
  if (!feature || !xid) return null;
  const scanIndex = getScanIndex(xid);
  return {
    feature,
    xid,
    scanIndex,
    key: buildZoomKey(xid, scanIndex),
  };
}

function buildFullResServerUrl(xid, scanIndex) {
  return `/api/dezoomify?xid=${encodeURIComponent(xid)}&scanIndex=${encodeURIComponent(
    String(scanIndex),
  )}`;
}

function isArchiveHostUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw, window.location.href);
    const host = String(parsed.hostname || "").toLowerCase();
    return host === "ahmp.cz" || host.endsWith(".ahmp.cz");
  } catch {
    return false;
  }
}

function getClientFullResUnavailableMessage(error) {
  const message = String(error?.message || "");
  if (/cors|failed to fetch|networkerror/i.test(message)) {
    return "Plné rozlišení zde nelze stáhnout kvůli omezení zdroje (CORS).";
  }
  if (/příliš velké|too large|limit/i.test(message)) {
    return "Plné rozlišení je pro prohlížeč příliš velké.";
  }
  if (/zoomify|nenalezen|nedostupn/i.test(message)) {
    return "Plné rozlišení není pro tento záznam dostupné.";
  }
  return "Plné rozlišení teď není dostupné.";
}

async function probeClientTileAccess(meta) {
  const width = Number(meta?.width);
  const height = Number(meta?.height);
  const tileSize = Number(meta?.tileSize || 256);
  const base = String(meta?.zoomifyImgPath || "").trim().replace(/\/$/, "");
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("Chybí rozměry");
  }
  if (!Number.isFinite(tileSize) || tileSize <= 0) {
    throw new Error("Chybí tileSize");
  }
  if (!base) {
    throw new Error("Chybí zoomifyImgPath");
  }
  const tiers = buildZoomifyTiers(width, height, tileSize);
  const level = tiers.length - 1;
  const group = zoomifyTileGroupIndex(tiers, tileSize, level, 0, 0);
  const tileUrl = `${base}/TileGroup${group}/${level}-0-0.jpg`;
  const response = await fetch(tileUrl, { mode: "cors", cache: "default" });
  if (!response.ok) {
    throw new Error(`Tile access failed: ${response.status}`);
  }
}

async function evaluateClientFullResAvailability(xid, scanIndex) {
  try {
    const meta = await loadZoomifyMeta(xid, scanIndex);
    const width = Number(meta?.width);
    const height = Number(meta?.height);
    const pixelCount = width * height;
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error("Chybí rozměry");
    }
    if (pixelCount > FULL_RES_CLIENT_MAX_PIXELS) {
      throw new Error("Plné rozlišení je příliš velké");
    }
    if (isArchiveHostUrl(meta?.zoomifyImgPath)) {
      throw new Error("CORS");
    }
    await probeClientTileAccess(meta);
    return { available: true, meta };
  } catch (error) {
    return {
      available: false,
      reason: getClientFullResUnavailableMessage(error),
    };
  }
}

function triggerBlobDownload(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function sanitizeDownloadName(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]+/g, "_");
}

async function stitchZoomifyToJpegBlob(meta, options = {}) {
  const { onProgress } = options;
  const width = Number(meta?.width);
  const height = Number(meta?.height);
  const tileSize = Number(meta?.tileSize || 256);
  const base = String(meta?.zoomifyImgPath || "").trim().replace(/\/$/, "");
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("Chybí rozměry");
  }
  if (!Number.isFinite(tileSize) || tileSize <= 0) {
    throw new Error("Chybí tileSize");
  }
  if (!base) {
    throw new Error("Chybí zoomifyImgPath");
  }
  if (width * height > FULL_RES_CLIENT_MAX_PIXELS) {
    throw new Error("Plné rozlišení je příliš velké");
  }

  const tiers = buildZoomifyTiers(width, height, tileSize);
  const level = tiers.length - 1;
  const [tilesX, tilesY] = zoomifyTilesFor(tiers[level], tileSize);
  const totalTiles = tilesX * tilesY;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas není dostupný");
  }

  let doneTiles = 0;
  for (let tileY = 0; tileY < tilesY; tileY += 1) {
    for (let tileX = 0; tileX < tilesX; tileX += 1) {
      const group = zoomifyTileGroupIndex(tiers, tileSize, level, tileX, tileY);
      const tileUrl = `${base}/TileGroup${group}/${level}-${tileX}-${tileY}.jpg`;
      const response = await fetch(tileUrl, { mode: "cors", cache: "force-cache" });
      if (!response.ok) {
        throw new Error(`Tile ${tileX},${tileY} nelze načíst (${response.status})`);
      }
      const tileBlob = await response.blob();
      const bitmap = await createImageBitmap(tileBlob);
      try {
        context.drawImage(bitmap, tileX * tileSize, tileY * tileSize);
      } finally {
        bitmap.close();
      }
      doneTiles += 1;
      if (
        typeof onProgress === "function" &&
        (doneTiles === totalTiles ||
          doneTiles === 1 ||
          doneTiles % Math.max(1, Math.floor(totalTiles / 8)) === 0)
      ) {
        onProgress(doneTiles, totalTiles);
      }
      if (doneTiles % 12 === 0) {
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      }
    }
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Export se nezdařil"));
          return;
        }
        resolve(blob);
      },
      "image/jpeg",
      0.92,
    );
  });
}

async function refreshFullResDownloadAvailability(featureOverride = null) {
  if (!downloadFullResBtn) return;
  if (!archiveModal?.classList.contains("is-open")) {
    setFullResButtonEnabled(false);
    setFullResStatus("");
    return;
  }
  if (fullResDownloadBusy) return;
  const selection = getCurrentFullResSelection(featureOverride);
  if (!selection) {
    setFullResUnavailable("Vyberte fotografii.");
    return;
  }
  if (state.fullResDownloadMode === FULL_RES_MODE_SERVER) {
    setFullResButtonEnabled(true);
    setFullResStatus("");
    return;
  }
  const token = ++fullResAvailabilityToken;
  setFullResButtonEnabled(false);
  setFullResStatus("Kontroluji dostupnost…");
  const availability = await evaluateClientFullResAvailability(
    selection.xid,
    selection.scanIndex,
  );
  if (token !== fullResAvailabilityToken) return;
  if (!availability.available) {
    fullResMetaByKey.delete(selection.key);
    setFullResUnavailable(availability.reason);
    return;
  }
  fullResMetaByKey.set(selection.key, availability.meta);
  setFullResButtonEnabled(true);
  setFullResStatus("");
}

async function handleFullResDownloadClick() {
  if (!downloadFullResBtn) return;
  if (fullResDownloadBusy) return;
  const selection = getCurrentFullResSelection();
  if (!selection) {
    setFullResUnavailable("Vyberte fotografii.");
    return;
  }
  if (state.fullResDownloadMode === FULL_RES_MODE_SERVER) {
    window.location.href = buildFullResServerUrl(selection.xid, selection.scanIndex);
    return;
  }

  fullResDownloadBusy = true;
  setFullResButtonEnabled(false);
  setFullResStatus("Skládám plné rozlišení…");

  try {
    let meta = fullResMetaByKey.get(selection.key);
    if (!meta) {
      const availability = await evaluateClientFullResAvailability(
        selection.xid,
        selection.scanIndex,
      );
      if (!availability.available) {
        setFullResUnavailable(availability.reason);
        return;
      }
      meta = availability.meta;
      fullResMetaByKey.set(selection.key, meta);
    }

    const blob = await stitchZoomifyToJpegBlob(meta, {
      onProgress: (done, total) => {
        setFullResStatus(`Skládám plné rozlišení… ${done}/${total}`);
      },
    });
    const filename = `${sanitizeDownloadName(selection.xid)}_scan_${selection.scanIndex + 1}_full.jpg`;
    triggerBlobDownload(blob, filename);
    setFullResButtonEnabled(true);
    setFullResStatus("Soubor stažen.", "success");
  } catch (error) {
    console.warn("Full-res download selhal", error);
    setFullResUnavailable(getClientFullResUnavailableMessage(error));
  } finally {
    fullResDownloadBusy = false;
  }
}

function attachBaseTiles(map, options = {}) {
  if (!map || !window.L) return;
  const { showAttribution = true, logPrefix = "Map" } = options;
  const osmAttribution = showAttribution ? OSM_ATTR : "";
  if (MAPY_CZ_API_KEY) {
    const mapyLayer = L.tileLayer(
      `https://api.mapy.cz/v1/maptiles/basic/256/{z}/{x}/{y}?apikey=${MAPY_CZ_API_KEY}`,
      {
        maxZoom: 19,
        attribution: showAttribution ? `${MAPY_ATTR}, ${OSM_ATTR}` : "",
      },
    );
    mapyLayer.addTo(map);

    let fallbackActive = false;
    mapyLayer.on("tileerror", () => {
      if (fallbackActive) return;
      fallbackActive = true;
      console.warn(`${logPrefix}: Mapy.cz tiles failed, falling back to OSM`);
      if (map.hasLayer(mapyLayer)) {
        map.removeLayer(mapyLayer);
      }
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: osmAttribution,
      }).addTo(map);
    });
    return;
  }
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: osmAttribution,
  }).addTo(map);
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
    zoomControl: true,
    attributionControl: true,
    dragging: true,
    touchZoom: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    boxZoom: true,
    keyboard: false,
    tap: false,
  });
  attachBaseTiles(state.detailMiniMap, {
    showAttribution: true,
    logPrefix: "Minimap",
  });
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
  archiveModalPreviousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
  archiveModal.querySelector('button[data-modal-close]')?.focus();
  if (metaView) metaView.classList.remove("is-hidden");
  if (correctionView) correctionView.classList.add("is-hidden");
  window.OldPraguePhotoFeedback?.close();

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
    const currentFeature =
      state.selectedFeature?.properties?.id === xid
        ? state.selectedFeature
        : state.featuresById.get(xid);
    const selectedScanIndex = getScanIndex(xid);
    loadZoomifyInto(
      zoomViewerEl,
      zoomWrap,
      archivePreview,
      xid,
      currentFeature,
      selectedScanIndex,
    );
    prefetchModalPreviewContext(currentFeature);
    refreshFullResDownloadAvailability(currentFeature);
  }
  invalidateDetailMiniMap();
}

function closeArchiveModal(options = {}) {
  if (!archiveModal || !archiveIframe) return;
  const { updateHistory = true } = options;
  zoomLoadToken += 1;
  archiveModal.classList.remove("is-open");
  archiveModal.setAttribute("aria-hidden", "true");
  archiveIframe.src = "";
  archiveIframe.style.pointerEvents = "none";
  if (archivePreview) archivePreview.src = "";
  if (archiveUnavailable) archiveUnavailable.textContent = "";
  if (zoomWrap) {
    zoomWrap.classList.remove("is-fallback", "is-unavailable", "is-loading");
  }
  fullResAvailabilityToken += 1;
  fullResDownloadBusy = false;
  setFullResButtonEnabled(false);
  setFullResStatus("");
  zoomLastKey = "";
  document.body.style.overflow = "";
  if (window.CorrectionUI) {
    window.CorrectionUI.close();
  }
  if (metaView) metaView.classList.remove("is-hidden");
  if (correctionView) correctionView.classList.add("is-hidden");
  window.OldPraguePhotoFeedback?.close();
  if (feedbackForm) feedbackForm.classList.remove("is-open");

  if (archiveModalPreviousFocus?.isConnected) archiveModalPreviousFocus.focus();
  archiveModalPreviousFocus = null;

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
  let showProposalReview = false;

  if (correctionState === "pending" && anchorType === "correction") {
    const group = state.groupByXid.get(String(feature?.properties?.id || "").trim());
    if (window.OldPragueOwnProposals?.isCurrentInGroup(group?.items || [feature], correction.proposed_id)) {
      text = "Děkujeme, návrh jsme uložili. Čeká na potvrzení dalšího člověka.";
    } else {
      text = "Někdo navrhl jinou polohu. V kontrole uvidíte současný i navržený bod.";
      showProposalReview = true;
    }
  } else if (correctionState === "approved") {
    text = "Poloha potvrzena komunitou.";
  } else if (anchorType === "flag") {
    text = "Poloha byla označena jako podezřelá a čeká na kontrolu.";
  } else {
    consensusBanner.classList.add("is-hidden");
    return;
  }

  consensusText.textContent = text;
  confirmCta.textContent = "Zkontrolovat návrh";
  confirmCta.classList.toggle("is-hidden", !showProposalReview);
  consensusBanner.classList.remove("is-hidden");
  updateContributionAvailability();
}

function focusedLocationReviewUrl(feature) {
  const groupId = String(resolveGroupIdForFeature(feature) || "").trim();
  if (!groupId) return "";
  const params = new URLSearchParams({
    mode: "location",
    group_id: groupId,
  });
  return `pomoc.html?${params.toString()}`;
}

function updateContributionAvailability() {
  const locked = !state.reviewStateReady || state.submittingContribution;
  [reportCta, reportFlagBtn, confirmCta].forEach((button) => {
    if (button) button.disabled = locked;
  });
  if (nearbyPrevBtn) {
    nearbyPrevBtn.disabled = locked || state.nearbyIndex <= 0;
  }
  if (nearbyNextBtn) {
    nearbyNextBtn.disabled =
      locked ||
      state.nearbyIndex < 0 ||
      state.nearbyIndex >= state.nearbyGroupIds.length - 1;
  }
}

function renderCorrectionScopeHint() {
  if (!correctionScopeHint) return;
  const versionCount = Array.isArray(state.selectedGroup?.items)
    ? state.selectedGroup.items.length
    : 0;
  if (versionCount > 1) {
    correctionScopeHint.textContent = `Opravujete polohu celé skupiny (${window.OldPragueMeta.formatPhotoCount(versionCount)}).`;
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
    selectedScanIndex: getScanIndex(feature?.properties?.id || ""),
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
    onSelectScan: (nextScan) => {
      const selectedXid = String(feature?.properties?.id || "").trim();
      if (!selectedXid) return;
      setScanIndex(selectedXid, nextScan);
      const selectedScanIndex = getScanIndex(selectedXid);
      const nextFeature = state.featuresById.get(selectedXid) || feature;
      renderDetails(nextFeature);
      if (archiveModal?.classList.contains("is-open")) {
        const url = getArchiveUrl(nextFeature, selectedScanIndex);
        if (archiveFallback) {
          archiveFallback.href = url || "#";
          archiveFallback.style.display = url ? "inline-flex" : "none";
        }
        loadZoomifyInto(
          zoomViewerEl,
          zoomWrap,
          archivePreview,
          selectedXid,
          nextFeature,
          selectedScanIndex,
        );
        refreshFullResDownloadAvailability(nextFeature);
      }
    },
  });
  renderConsensusStatus(feature);
  renderCorrectionScopeHint();
}

function prepareGroupSearchIndex() {
  if (state.searchApi && !state.searchIndex) state.searchIndex = state.searchApi.buildSearchIndex(state.features);
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
    currentIndex >= 0 && total > 0
      ? `${(currentIndex + 1).toLocaleString("cs-CZ")} / ${total.toLocaleString("cs-CZ")}`
      : "—";
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
    photoGridCount.textContent = `Zobrazeno ${visibleCount.toLocaleString("cs-CZ")} z ${groups.length.toLocaleString("cs-CZ")}`;
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

function buildR2PreviewTileUrl(xid, scanIndex = 0, level = 0) {
  const base = String(state.r2TilesBase || "").trim().replace(/\/$/, "");
  const normalizedXid = String(xid || "").trim();
  const normalizedScan =
    Number.isInteger(scanIndex) && scanIndex >= 0 ? scanIndex : 0;
  const tileLevel =
    Number.isInteger(level) && level >= 0 ? level : Math.max(0, Number(level) || 0);
  if (!base || !normalizedXid) return "";
  return `${base}/${encodeURIComponent(normalizedXid)}/scan_${normalizedScan}/TileGroup0/${tileLevel}-0-0.jpg`;
}

function getZoomifyPathFromFeature(feature, scanIndex = 0) {
  const props = feature?.properties || {};
  const zoomifyPaths = props.scan_zoomify_paths;
  if (!Array.isArray(zoomifyPaths)) return "";
  if (
    Number.isInteger(scanIndex) &&
    scanIndex >= 0 &&
    scanIndex < zoomifyPaths.length
  ) {
    const indexedPath = String(zoomifyPaths[scanIndex] || "").trim();
    if (indexedPath) return indexedPath.replace(/\/$/, "");
  }
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
  const xid = String(feature?.properties?.id || "").trim();
  const r2Preview = buildR2PreviewTileUrl(xid, 0, 1);
  if (r2Preview) {
    const fallback = buildR2PreviewTileUrl(xid, 0, 0);
    return {
      url: r2Preview,
      fallback: fallback && fallback !== r2Preview ? fallback : "",
    };
  }

  const zoomifyPath = getZoomifyPathFromFeature(feature, 0);
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

function prefetchPreviewAsset(url) {
  const normalized = String(url || "").trim();
  if (!normalized) return Promise.resolve();

  if (state.prefetchedPreviewUrls.has(normalized)) {
    return Promise.resolve();
  }
  if (state.previewPrefetchByUrl.has(normalized)) {
    return state.previewPrefetchByUrl.get(normalized);
  }

  const promise = new Promise((resolve) => {
    const image = new Image();
    const finish = () => {
      image.onload = null;
      image.onerror = null;
      resolve();
    };
    image.decoding = "async";
    image.loading = "eager";
    image.onload = () => {
      if (typeof image.decode !== "function") {
        finish();
        return;
      }
      image.decode().catch(() => {}).finally(finish);
    };
    image.onerror = finish;
    image.src = normalized;
  }).finally(() => {
    state.previewPrefetchByUrl.delete(normalized);
    state.prefetchedPreviewUrls.add(normalized);
  });

  state.previewPrefetchByUrl.set(normalized, promise);
  return promise;
}

function getOtherScanPreviewCandidates(feature) {
  const props = feature?.properties || {};
  const xid = String(props.id || "").trim();
  const urls = [];

  const scanPreviews = Array.isArray(props.scan_previews) ? props.scan_previews : [];
  const scanZoomifyPaths = Array.isArray(props.scan_zoomify_paths)
    ? props.scan_zoomify_paths
    : [];
  const scanCount = Math.max(
    Number(props.scan_count) || 0,
    scanPreviews.length,
    scanZoomifyPaths.length,
  );

  if (state.r2TilesBase && xid && scanCount > 1) {
    for (let i = 1; i < scanCount; i += 1) {
      const tileUrl = buildR2PreviewTileUrl(xid, i);
      if (!tileUrl) continue;
      urls.push(tileUrl);
    }
    return Array.from(new Set(urls));
  }

  for (let i = 1; i < scanPreviews.length; i += 1) {
    const url = String(scanPreviews[i] || "").trim();
    if (!url) continue;
    urls.push(url);
  }

  for (let i = 1; i < scanZoomifyPaths.length; i += 1) {
    const tileUrl = buildZoomifyTileUrl(scanZoomifyPaths[i], 0);
    if (!tileUrl) continue;
    urls.push(tileUrl);
  }

  return Array.from(new Set(urls));
}

function prefetchOtherScanPreviews(feature) {
  const candidates = getOtherScanPreviewCandidates(feature);
  for (let i = 0; i < candidates.length; i += 1) {
    prefetchPreviewAsset(candidates[i]);
  }
}

function prefetchPrimaryPreview(feature) {
  if (!feature) return;

  const localPreview = getLocalPreviewForFeature(feature, 0);
  if (localPreview) {
    prefetchPreviewAsset(localPreview).catch(() => {});
  }

  if (!state.r2TilesBase) {
    resolvePreviewUrl(feature)
      .then((resolvedUrl) => {
        prefetchPreviewAsset(resolvedUrl).catch(() => {});
      })
      .catch(() => {});
  }
}

function prefetchPrimaryPreviewOnce(feature) {
  const xid = String(feature?.properties?.id || "").trim();
  if (!xid || state.previewProximityPrefetchedXids.has(xid)) return;
  state.previewProximityPrefetchedXids.add(xid);
  prefetchPrimaryPreview(feature);
}

function canUsePreviewProximityPrefetch() {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function getActivePreviewMarkerRefs() {
  return state.clusteringEnabled
    ? state.clusterPreviewMarkers
    : state.overlapPreviewMarkers;
}

function getActivePreviewMarkerLayer() {
  return state.clusteringEnabled ? state.cluster : state.overlapCluster;
}

function isPreviewMarkerVisible(marker, layer) {
  if (!state.map || !marker || !layer || !state.map.hasLayer(layer)) return false;
  if (typeof layer.getVisibleParent === "function") {
    return layer.getVisibleParent(marker) === marker;
  }
  return state.map.hasLayer(marker);
}

function findNearestPreviewMarker(containerPoint) {
  if (!state.map || !containerPoint) return null;
  const refs = getActivePreviewMarkerRefs();
  const layer = getActivePreviewMarkerLayer();
  if (!Array.isArray(refs) || !refs.length || !layer) return null;

  let nearest = null;
  let nearestDistanceSq =
    PREVIEW_PROXIMITY_RADIUS_PX * PREVIEW_PROXIMITY_RADIUS_PX;

  refs.forEach((ref) => {
    const marker = ref?.marker;
    const group = ref?.group;
    if (!marker || !group?.primary) return;

    const markerPoint = state.map.latLngToContainerPoint(marker.getLatLng());
    const dx = markerPoint.x - containerPoint.x;
    const dy = markerPoint.y - containerPoint.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq >= nearestDistanceSq) return;
    if (!isPreviewMarkerVisible(marker, layer)) return;

    nearest = ref;
    nearestDistanceSq = distanceSq;
  });

  return nearest;
}

function processPreviewProximityEvent() {
  state.previewProximityRaf = 0;
  state.previewProximityLastAt = Date.now();

  const event = state.previewProximityLastEvent;
  state.previewProximityLastEvent = null;
  if (!event || !state.map) return;
  if (event.originalEvent?.buttons) return;

  const containerPoint =
    event.containerPoint ||
    (event.originalEvent
      ? state.map.mouseEventToContainerPoint(event.originalEvent)
      : null);
  const nearest = findNearestPreviewMarker(containerPoint);
  if (!nearest) {
    state.previewProximityActiveGroupId = "";
    return;
  }

  const groupId = String(nearest.group?.id || "");
  if (groupId && groupId === state.previewProximityActiveGroupId) return;
  state.previewProximityActiveGroupId = groupId;
  prefetchPrimaryPreviewOnce(nearest.group.primary);
}

function schedulePreviewProximityCheck(event) {
  if (!canUsePreviewProximityPrefetch()) return;
  if (event?.originalEvent?.buttons) return;

  state.previewProximityLastEvent = event;
  if (state.previewProximityTimer || state.previewProximityRaf) return;

  const elapsed = Date.now() - state.previewProximityLastAt;
  const wait = Math.max(0, PREVIEW_PROXIMITY_THROTTLE_MS - elapsed);
  state.previewProximityTimer = window.setTimeout(() => {
    state.previewProximityTimer = null;
    state.previewProximityRaf = window.requestAnimationFrame(
      processPreviewProximityEvent,
    );
  }, wait);
}

function prefetchNextNearbyPreview() {
  const nearbyIds = Array.isArray(state.nearbyGroupIds) ? state.nearbyGroupIds : [];
  const nextIndex = Number(state.nearbyIndex) + 1;
  if (nextIndex < 0 || nextIndex >= nearbyIds.length) return;
  const nextId = nearbyIds[nextIndex];
  if (!nextId) return;
  const nextGroup = state.groupById.get(nextId);
  if (!nextGroup?.primary) return;
  prefetchPrimaryPreview(nextGroup.primary);
}

function prefetchModalPreviewContext(feature) {
  if (!feature) return;
  prefetchOtherScanPreviews(feature);
  prefetchNextNearbyPreview();
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

  const r2Preview = buildR2PreviewTileUrl(xid, 0);
  if (r2Preview) {
    state.previewByXid.set(xid, r2Preview);
    return r2Preview;
  }

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
      const local = getLocalPreviewForFeature(feature);
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
  const normalizedUrl = String(url || "").trim();
  return `<div class="photo-preview"><img src="${escapeHtml(
    normalizedUrl,
  )}" alt="Náhled fotografie" loading="eager" decoding="async" /></div>`;
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
  const localUrl = getLocalPreviewForFeature(feature, 0);
  showPreviewAt(latlng, renderPreviewContent(localUrl, { loading: !localUrl }));

  if (localUrl) {
    prefetchPreviewAsset(localUrl).catch(() => {});
    return;
  }
  resolvePreviewUrl(feature).then((url) => {
    if (hoverToken !== state.previewHoverToken) return;
    if (!url) {
      showPreviewAt(latlng, renderPreviewContent("", { loading: false }));
      return;
    }
    showPreviewAt(latlng, renderPreviewContent(url, { loading: false }));
    prefetchPreviewAsset(url).catch(() => {});
  });
}

function initMap() {
  // Open on the historic centre, where most photographs are. Fitting every
  // marker would zoom out to the whole region because of a few outliers.
  const narrowScreen = window.matchMedia("(max-width: 640px)").matches;
  state.map = L.map("map", {
    zoomControl: true,
    scrollWheelZoom: true,
  }).setView(PRAGUE_CENTRE, narrowScreen ? 13 : 14);
  attachBaseTiles(state.map, { showAttribution: true, logPrefix: "Main map" });

  const clusterToggle = document.getElementById("cluster-toggle");
  if (clusterToggle) {
    state.clusteringEnabled = clusterToggle.checked;
    clusterToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        hideClusterWarning();
        toggleClustering(true);
        return;
      }
      if (!hasSeenClusterWarning()) {
        e.target.checked = true;
        showClusterWarning();
        return;
      }
      toggleClustering(e.target.checked);
    });
  }

  clusterWarningContinue?.addEventListener("click", () => {
    try {
      localStorage.setItem("cluster-warning-shown", "true");
    } catch (error) {
      // The choice still applies when browser storage is unavailable.
    }
    hideClusterWarning();
    if (clusterToggle) clusterToggle.checked = false;
    toggleClustering(false);
    clusterToggle?.focus();
  });

  clusterWarningCancel?.addEventListener("click", () => {
    hideClusterWarning();
    if (clusterToggle) clusterToggle.checked = true;
    clusterToggle?.focus();
  });

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
  state.map.on("mousemove", schedulePreviewProximityCheck);
}

function hasSeenClusterWarning() {
  try {
    return localStorage.getItem("cluster-warning-shown") === "true";
  } catch (error) {
    return false;
  }
}

function showClusterWarning() {
  clusterWarning?.classList.remove("is-hidden");
  const toggle = document.getElementById("cluster-toggle");
  toggle?.setAttribute("aria-expanded", "true");
  clusterWarningContinue?.focus();
}

function hideClusterWarning() {
  clusterWarning?.classList.add("is-hidden");
  document.getElementById("cluster-toggle")?.setAttribute("aria-expanded", "false");
}

function toggleClustering(enabled) {

  state.clusteringEnabled = enabled;
  updateFiltersIndicator();
  state.previewProximityActiveGroupId = "";
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
  state.clusterPreviewMarkers = [];
  state.overlapPreviewMarkers = [];
  state.previewProximityActiveGroupId = "";

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
    state.clusterPreviewMarkers.push({ marker: m1, group });
    state.overlapPreviewMarkers.push({ marker: m2, group });

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
    const scanIndex = getScanIndex(feature?.properties?.id || "");
    const url = getArchiveUrl(feature, scanIndex);
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
  if (Number.isSafeInteger(reviewState?.revision)) {
    state.features.forEach((feature) => {
      if (feature?.properties) {
        feature.properties.candidate_revision = reviewState.revision;
      }
    });
  }
  state.correctionsByGroup = appliedReviewState.correctionByGroup;
  state.reviewCounts = reviewState?.counts || {};
  rebuildGroupIndexes();
  state.reviewStateReady = true;
  updateContributionAvailability();
}

function updateVerifiedCount(reviewState = null) {
  const verifiedCount = document.getElementById("verified-count");
  if (!verifiedCount) return;
  const value =
    Number(reviewState?.counts?.doneGroups) ||
    Number(state.reviewCounts?.doneGroups) ||
    0;
  verifiedCount.textContent = value.toLocaleString("cs-CZ");
  // A zero reads as an abandoned project; show the stat once there is progress.
  const stat = verifiedCount.closest(".stat");
  if (stat) stat.hidden = value === 0;
}

async function refreshReviewState(options = {}) {
  const { fresh = false } = options;
  const selectedXid = state.selectedFeature?.properties?.id || "";
  const reviewState = await fetchJson(
    fresh ? "/api/review-state?fresh=1" : "/api/review-state",
  );
  applyReviewStatePayload(reviewState);
  updateVerifiedCount(reviewState);
  applyYearFilter({ fitBounds: false });

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

async function submitModalFlag() {
  if (
    !state.selectedFeature ||
    !state.reviewStateReady ||
    state.submittingContribution
  ) return null;
  const submittedFeature = state.selectedFeature;
  const groupId = resolveGroupIdForFeature(submittedFeature);
  const payload = {
    xid: submittedFeature.properties.id,
    group_id: groupId || undefined,
    candidate_revision: submittedFeature.properties.candidate_revision,
    verdict: "flag",
    message: "Nahlášeno bez upřesnění polohy.",
  };
  state.submittingContribution = true;
  updateContributionAvailability();
  const sendRequest = () =>
    fetch("/api/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
  try {
    const submitWithRetry = window.OldPragueSession?.submitWithSessionRetry;
    const response = submitWithRetry
      ? await submitWithRetry(sendRequest)
      : await sendRequest();
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || "Odeslání selhalo");
    }

    try {
      await refreshReviewState({ fresh: true });
    } catch (refreshError) {
      state.reviewStateReady = false;
      return { submittedFeature, refreshError };
    }

    if (consensusText) {
      consensusText.textContent =
        "Díky! Hlášení bylo uloženo a čeká na potvrzení.";
    }
    return { submittedFeature, refreshError: null };
  } finally {
    state.submittingContribution = false;
    updateContributionAvailability();
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
  MAPY_CZ_API_KEY = String(config.mapyCzApiKey || "").trim();
  state.archiveBaseUrl = config.archiveBaseUrl || "";
  state.r2TilesBase = String(config.r2TilesBase || "")
    .trim()
    .replace(/\/$/, "");
  state.fullResDownloadMode =
    config.fullResDownloadMode === FULL_RES_MODE_CLIENT
      ? FULL_RES_MODE_CLIENT
      : FULL_RES_MODE_SERVER;

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

  // The metadata index is owned by stage 003; curator overlays can be applied
  // to features before this one-time index construction.
  state.searchApi = await import('./search-index.js').catch(() => null);
  initMap();
  initFiltersToggle();

  const features = photos.features || [];
  state.features = features;
  // This page does not poll community state, so bootstrap from an authoritative
  // snapshot instead of an edge-cached response that may predate a new proposal.
  const reviewState = await fetchJson("/api/review-state?snapshot=1");
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
      onSubmit: async (submittedFeature) => {
        await refreshReviewState({ fresh: true });
        if (state.selectedFeature?.properties?.id !== submittedFeature.properties.id) return;
        if (metaView) metaView.classList.remove("is-hidden");
        if (correctionView) correctionView.classList.add("is-hidden");
        if (reportCtaWrap) reportCtaWrap.classList.remove("is-hidden");
        invalidateDetailMiniMap();
        renderConsensusStatus(submittedFeature);
      },
      onCancel: () => {
        if (metaView) metaView.classList.remove("is-hidden");
        if (correctionView) correctionView.classList.add("is-hidden");
        if (reportCtaWrap) reportCtaWrap.classList.remove("is-hidden");
        invalidateDetailMiniMap();
      },
    });
  }

  initSearch();
}

function searchMembership() {
  if (!state.searchApi || !state.searchIndex) return null;
  const visible = new Set(getSearchBaseGroups().flatMap((group) =>
    group.items.map((feature) => String(feature.properties.id))));
  return state.searchApi.updateSearchMembership(state.searchIndex, state.groupByXid, visible);
}

function localSearchResults(query) {
  const membership = searchMembership();
  if (!membership) return {};
  const found = state.searchApi.searchIndex(membership, query, { limit: 100 });
  const entityResult = (entity, kind) => ({
    ...entity, kind,
    label: [entity.label, entity.district].filter(Boolean).join(' — '),
    detail: `Podle údajů archivu · ${entity.photoCount} fotografií · ${entity.groupCount} skupin · ${kind === 'place' ? 'Zobrazit fotografie tohoto místa' : 'Zobrazit fotografie autora'}`,
  });
  // Only the data helper decides which XID explains a description match.
  const descriptions = state.searchApi.searchDescriptions(membership, query, { limit: 100 })
    .map((match) => {
      const text = String(state.featuresById.get(match.matchedXid)?.properties.description || '');
      const searchable = state.searchApi.normalizeSearchText(text);
      const firstToken = state.searchApi.normalizeSearchText(query).split(' ')[0];
      const position = Math.max(0, searchable.indexOf(firstToken) - 40);
      return { kind: 'description', xid: match.matchedXid, groupId: match.groupId,
        label: `${position ? '…' : ''}${text.slice(position, position + 150)}${text.length > position + 150 ? '…' : ''}`,
        detail: 'Otevřít fotografii · Shoda v popisu' };
    });
  return { places: found.places.map((entity) => entityResult(entity, 'place')),
    authors: found.authors.map((entity) => entityResult(entity, 'author')),
    descriptions: descriptions.slice(0, 100) };
}

function commitSearchFilter(filter, { historyMode = 'push', fitBounds = false } = {}) {
  state.searchFilter = filter;
  setSearchFilter(filter?.type === 'text' ? filter.label : '', { enabled: filter?.type === 'text' });
  state.searchUI?.setFilter(filter);
  if (historyMode) {
    document.getElementById('search-link-status').textContent = '';
    const url = new URL(location.href);
    for (const key of ['search', 'search_id', 'search_text']) url.searchParams.delete(key);
    if (filter) {
      url.searchParams.set('search', filter.type);
      url.searchParams.set(filter.type === 'text' ? 'search_text' : 'search_id', filter.type === 'text' ? filter.label : filter.id);
    }
    if (url.href !== location.href) history[historyMode === 'replace' ? 'replaceState' : 'pushState']({}, '', url);
  }
  applyYearFilter({ fitBounds });
}

function restoreSearchFilter() {
  document.getElementById('search-link-status').textContent = '';
  const params = new URLSearchParams(location.search);
  const type = params.get('search');
  let filter = null;
  if (type === 'text' && params.get('search_text')?.trim()) {
    filter = { type, label: params.get('search_text').trim() };
  } else if (type === 'place' || type === 'author') {
    const id = params.get('search_id');
    const entity = state.searchIndex?.[type === 'place' ? 'places' : 'authors'].get(id);
    if (entity) filter = { type, id, label: [entity.label, entity.district].filter(Boolean).join(' — ') };
    else document.getElementById('search-link-status').textContent = 'Místo nebo autor z odkazu není v katalogu. Filtr hledání nebyl použit.';
  } else if (type) {
    document.getElementById('search-link-status').textContent = 'Filtr v odkazu není rozpoznán. Můžete zadat nové hledání.';
  }
  commitSearchFilter(filter, { historyMode: false });
}

function initSearch() {
  const input = document.getElementById('map-search');
  state.searchUI = window.OldPragueSearchUI.mount({
    input, popup: document.getElementById('search-results'),
    chip: document.getElementById('search-filter'), status: document.getElementById('search-status'),
    getResults: localSearchResults,
    suggest: (query, signal) => window.OldPragueSearchUI.suggest(query, MAPY_CZ_API_KEY, signal),
    onText: (label) => commitSearchFilter({ type: 'text', label }),
    onClear: () => commitSearchFilter(null),
    onSelect: (item) => {
      if (item.kind === 'address') {
        state.map.setView([item.lat, item.lon], 16, { animate: true });
      } else if (item.kind === 'description') {
        const group = state.groupByXid.get(item.xid);
        if (group) selectGroup(group, { openModal: true, updateHistory: true, panTo: true, selectedXid: item.xid });
      } else {
        commitSearchFilter({ type: item.kind, id: item.id, label: item.label }, { fitBounds: item.kind === 'place' });
      }
    },
  });
  restoreSearchFilter();
}

feedbackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  window.CorrectionUI?.submit();
});

if (reportCta) {
  reportCta.addEventListener("click", () => {
    if (
      !state.selectedFeature ||
      !state.reviewStateReady ||
      state.submittingContribution
    ) return;
    if (metaView) metaView.classList.add("is-hidden");
    if (correctionView) correctionView.classList.remove("is-hidden");
    if (reportCtaWrap) reportCtaWrap.classList.add("is-hidden");
    if (feedbackForm) feedbackForm.classList.add("is-open");
    if (window.CorrectionUI) {
      window.CorrectionUI.open(state.selectedFeature);
    }
  });
}

photoFeedbackCta?.addEventListener("click", () => {
  if (!state.selectedFeature) return;
  metaView?.classList.add("is-hidden");
  correctionView?.classList.add("is-hidden");
  reportCtaWrap?.classList.add("is-hidden");
  window.OldPraguePhotoFeedback?.open(state.selectedFeature, () => {
    if (!archiveModal?.classList.contains("is-open")) return;
    metaView?.classList.remove("is-hidden");
    reportCtaWrap?.classList.remove("is-hidden");
  });
});

if (reportFlagBtn) {
  reportFlagBtn.addEventListener("click", async () => {
    try {
      const result = await submitModalFlag();
      if (!result) return;
      if (result.refreshError) {
        if (consensusText) {
          consensusText.textContent =
            "Hlášení je uložené, ale aktuální stav se nepodařilo obnovit. Obnovte stránku.";
        }
        if (consensusBanner) consensusBanner.classList.remove("is-hidden");
      } else if (state.selectedFeature === result.submittedFeature) {
        renderConsensusStatus(result.submittedFeature);
      }
    } catch (error) {
      const message = error?.message || "Odeslání selhalo";
      if (consensusText) consensusText.textContent = message;
      if (consensusBanner) consensusBanner.classList.remove("is-hidden");
    }
  });
}

if (confirmCta) {
  confirmCta.addEventListener("click", () => {
    const reviewUrl = focusedLocationReviewUrl(state.selectedFeature);
    if (reviewUrl) {
      window.location.assign(reviewUrl);
      return;
    }
    if (consensusText) {
      consensusText.textContent =
        "Návrh se nepodařilo otevřít. Zavřete detail a zkuste ho vybrat znovu.";
    }
    if (consensusBanner) consensusBanner.classList.remove("is-hidden");
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

if (downloadFullResBtn) {
  downloadFullResBtn.addEventListener("click", () => {
    handleFullResDownloadClick().catch((error) => {
      console.warn("Full-res download selhal", error);
      setFullResUnavailable(getClientFullResUnavailableMessage(error));
    });
  });
}

// Cancel button is now handled by CorrectionUI

// Correction toggle removed - replaced by view switching

if (infoOpenBtn && infoModal) {
  infoOpenBtn.addEventListener("click", () => {
    infoModalPreviousFocus = infoOpenBtn;
    infoModal.classList.add("is-open");
    infoModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    infoModal.querySelector('button[data-info-close]')?.focus();
  });
}

const closeInfoModal = () => {
  if (!infoModal) return;
  const wasOpen = infoModal.classList.contains("is-open");
  infoModal.classList.remove("is-open");
  infoModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  if (wasOpen && infoModalPreviousFocus?.isConnected) {
    infoModalPreviousFocus.focus();
  }
  infoModalPreviousFocus = null;
};

document.querySelectorAll("[data-info-close]").forEach((el) => {
  el.addEventListener("click", closeInfoModal);
});

document.querySelectorAll("[data-modal-close]").forEach((el) => {
  el.addEventListener("click", () => closeArchiveModal({ updateHistory: true }));
});

function shouldIgnoreModalArrowNavigation(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return true;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

document.addEventListener("keydown", (event) => {
  const modalOpen = archiveModal?.classList.contains("is-open");
  if (!modalOpen) return;

  if (event.key === "Escape") {
    closeArchiveModal({ updateHistory: true });
    return;
  }
  if (event.key === "Tab") {
    const visible = [...archiveModal.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled])')]
      .filter((element) => element.getClientRects().length > 0);
    if (visible.length) {
      const first = visible[0];
      const last = visible.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
  if (shouldIgnoreModalArrowNavigation(event)) return;

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    goToNearbyGroup(-1);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    goToNearbyGroup(1);
  }
});

window.addEventListener("popstate", () => {
  if (state.searchUI) { state.searchUI.close(); restoreSearchFilter(); }
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
  state.reviewStateReady = false;
  updateContributionAvailability();
  setStatus("Nepodařilo se načíst data.", "error");
  console.error(err);
});
