const MAPY_CZ_API_KEY = "JToxKFIPuYBZVmm3P8Kjujtg4wUEhzeP3TIBNcKxRV0";

const state = {
  map: null,
  cluster: null,
  selectedFeature: null,
  archiveBaseUrl: "",
  turnstileSiteKey: "",
  turnstileBypass: false,
  turnstileReady: false,
  turnstileWidgetId: null,
  turnstileToken: "",
  featuresById: new Map(),
  overlapCluster: null,
  clusteringEnabled: true,
  correctionLat: null,
  correctionLon: null,
  correctionMap: null,
  correctionMarker: null,
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
  zoomLastXid = null;
  document.body.style.overflow = "";

  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

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
  window.OldPragueMeta.renderDetails(detailContainer, feature, state.archiveBaseUrl);
}

function buildMarkerIcon() {
  return L.divIcon({
    className: "marker-dot",
    html: "<span></span>",
    iconSize: [18, 18],
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

function addMarkers(features) {
  state.cluster.clearLayers();
  state.overlapCluster.clearLayers();
  state.featuresById.clear();

  const bounds = L.latLngBounds();
  const icon = buildMarkerIcon();

  features.forEach((feature) => {
    if (feature.properties?.id) {
      state.featuresById.set(feature.properties.id, feature);
    }
    const [lon, lat] = feature.geometry.coordinates;
    const markerParams = { icon };

    // We create separate marker instances for each cluster group
    const m1 = L.marker([lat, lon], markerParams);
    const m2 = L.marker([lat, lon], markerParams);

    const setup = (m) => {
      m.on("click", () => {
        selectFeature(feature, { openModal: true, updateHistory: true, panTo: true });
      });
    };
    setup(m1);
    setup(m2);

    bounds.extend([lat, lon]);
    state.cluster.addLayer(m1);
    state.overlapCluster.addLayer(m2);
  });

  if (features.length) {
    state.map.fitBounds(bounds, { padding: [40, 40] });
  }
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

function applyCorrections(features, corrections) {
  if (!Array.isArray(features)) return;
  const map = new Map();
  corrections.forEach((item) => {
    if (!item || !item.xid) return;
    map.set(item.xid, item);
  });

  features.forEach((feature) => {
    const xid = feature.properties?.id;
    if (!xid || !map.has(xid)) return;
    const correction = map.get(xid);
    const lat = Number(correction.lat);
    const lon = Number(correction.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    feature.geometry.coordinates = [lon, lat];
    feature.properties.corrected = { lat, lon };
  });
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

  const corrections = await fetchJson("/api/corrections").catch(() => ({
    items: [],
  }));
  const features = photos.features || [];
  applyCorrections(features, corrections.items || []);
  addMarkers(features);
  renderDetails(null);
  photoCount.textContent = features.length
    ? features.length.toLocaleString()
    : "—";

  const verifiedCount = document.getElementById("verified-count");
  if (verifiedCount) {
    verifiedCount.textContent = corrections.count
      ? corrections.count.toLocaleString()
      : "0";
  }

  const xid = new URLSearchParams(window.location.search).get("xid");
  if (xid && state.featuresById.has(xid)) {
    selectFeature(state.featuresById.get(xid), {
      openModal: true,
      updateHistory: false,
      panTo: true,
    });
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
      onSubmit: () => {
        if (metaView) metaView.classList.remove("is-hidden");
        if (correctionView) correctionView.classList.add("is-hidden");
        if (reportCtaWrap) reportCtaWrap.classList.remove("is-hidden");
      },
      onCancel: () => {
        if (metaView) metaView.classList.remove("is-hidden");
        if (correctionView) correctionView.classList.add("is-hidden");
      },
    });
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
  const payload = {
    xid: state.selectedFeature.properties.id,
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
    selectFeature(state.featuresById.get(xid), {
      openModal: true,
      updateHistory: false,
      panTo: false,
    });
  } else if (archiveModal?.classList.contains("is-open")) {
    closeArchiveModal({ updateHistory: false });
  }
});

bootstrap().catch((err) => {
  setStatus("Nepodařilo se načíst data.", "error");
  console.error(err);
});
