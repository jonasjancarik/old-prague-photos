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
const reportCta = document.getElementById("report-cta");
const reportCtaWrap = document.querySelector(".report-cta");
const correctionMapEl = document.getElementById("correction-map");
const correctionToggle = document.getElementById("correction-toggle");
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
  return `${state.archiveBaseUrl}/permalink?xid=${feature.properties.id}`;
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
    if (!state.correctionMarker) {
      state.correctionMarker = L.marker([lat, lng]).addTo(state.correctionMap);
    } else {
      state.correctionMarker.setLatLng([lat, lng]);
    }
    setCorrection(Number(lat.toFixed(6)), Number(lng.toFixed(6)));
  });
}

function resetCorrectionMap(feature) {
  if (!state.correctionMap || !feature) return;
  const [lon, lat] = feature.geometry.coordinates;
  state.correctionMap.setView([lat, lon], 15);

  if (feature.properties?.corrected) {
    const { lat: cLat, lon: cLon } = feature.properties.corrected;
    if (!state.correctionMarker) {
      state.correctionMarker = L.marker([cLat, cLon]).addTo(
        state.correctionMap,
      );
    } else {
      state.correctionMarker.setLatLng([cLat, cLon]);
    }
    setCorrection(cLat, cLon);
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
  if (correctionToggle?.checked) {
    ensureCorrectionMap();
    resetCorrectionMap(state.selectedFeature);
    if (state.correctionMap) {
      setTimeout(() => state.correctionMap.invalidateSize(), 0);
    }
  }
  if (feedbackForm) {
    feedbackForm.classList.remove("is-open");
  }
  if (correctionToggle) {
    correctionToggle.checked = false;
    correctionMapEl?.parentElement?.classList.add("is-hidden");
    clearCorrection();
  }
  if (reportCtaWrap) {
    reportCtaWrap.classList.remove("is-hidden");
  }
  if (updateHistory && xid) {
    setUrlXid(xid);
  }
}

function closeArchiveModal(options = {}) {
  if (!archiveModal || !archiveIframe) return;
  const { updateHistory = true } = options;
  archiveModal.classList.remove("is-open");
  archiveModal.setAttribute("aria-hidden", "true");
  archiveIframe.src = "";
  document.body.style.overflow = "";
  if (updateHistory) {
    setUrlXid(null, "replace");
  }
}

function renderDetails(feature) {
  if (!detailContainer) return;
  detailContainer.innerHTML = "";
  if (!feature) {
    const placeholder = document.createElement("p");
    placeholder.className = "placeholder";
    placeholder.textContent = "Zatím není vybraná fotografie.";
    detailContainer.appendChild(placeholder);
    return;
  }

  const archiveUrl = getArchiveUrl(feature);

  const items = [
    ["Archivní ID", feature.properties.id],
    ["Popis", feature.properties.description],
    ["Datace", feature.properties.date_label],
    ["Autor", feature.properties.author],
    ["Poznámka", feature.properties.note],
  ];

  if (archiveUrl) {
    items.unshift(["Archivní stránka", archiveUrl, "link"]);
  }

  items.forEach(([label, value, kind]) => {
    if (!value) return;
    const wrapper = document.createElement("div");
    wrapper.className = "detail-item";

    const labelEl = document.createElement("div");
    labelEl.className = "detail-label";
    labelEl.textContent = label;

    const valueEl = document.createElement("p");
    valueEl.className = "detail-value";
    if (kind === "link") {
      const link = document.createElement("a");
      link.href = value;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Otevřít v archivu";
      valueEl.appendChild(link);
    } else {
      valueEl.textContent = value;
    }

    wrapper.appendChild(labelEl);
    wrapper.appendChild(valueEl);
    detailContainer.appendChild(wrapper);
  });
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

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap přispěvatelé",
  }).addTo(state.map);

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

  state.map.addLayer(state.cluster);
}

function addMarkers(features) {
  const bounds = L.latLngBounds();
  const icon = buildMarkerIcon();

  features.forEach((feature) => {
    if (feature.properties?.id) {
      state.featuresById.set(feature.properties.id, feature);
    }
    const [lon, lat] = feature.geometry.coordinates;
    const marker = L.marker([lat, lon], { icon });
    marker.on("click", () => {
      selectFeature(feature, { openModal: true, updateHistory: true, panTo: true });
    });
    bounds.extend([lat, lon]);
    state.cluster.addLayer(marker);
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
    turnstileNote.textContent = "Turnstile je vypnutý pro lokální vývoj.";
    updateSubmitState();
    return;
  }

  if (!state.turnstileReady || !state.turnstileSiteKey) {
    if (!state.turnstileSiteKey) {
      turnstileNote.textContent = "Chybí Turnstile klíč.";
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
  initMap();

  const config = await fetchJson("/api/config").catch(() => ({}));
  let photos;
  try {
    photos = await fetchJson("/data/photos.geojson");
  } catch (error) {
    photos = await fetchJson("/api/photos");
  }

  state.turnstileSiteKey = config.turnstileSiteKey || "";
  state.turnstileBypass = Boolean(config.turnstileBypass);
  state.archiveBaseUrl = config.archiveBaseUrl || "";

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

  const xid = new URLSearchParams(window.location.search).get("xid");
  if (xid && state.featuresById.has(xid)) {
    selectFeature(state.featuresById.get(xid), {
      openModal: true,
      updateHistory: false,
      panTo: true,
    });
  }
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

if (reportCta && feedbackForm) {
  reportCta.addEventListener("click", () => {
    feedbackForm.classList.add("is-open");
    if (reportCtaWrap) {
      reportCtaWrap.classList.add("is-hidden");
    }
    updateSubmitState();
    renderTurnstile();
    setTimeout(() => {
      if (state.correctionMap) {
        state.correctionMap.invalidateSize();
      }
      feedbackForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 100);
  });
}

if (correctionToggle && correctionMapEl) {
  correctionToggle.addEventListener("change", () => {
    if (correctionToggle.checked) {
      correctionMapEl.parentElement?.classList.remove("is-hidden");
      ensureCorrectionMap();
      resetCorrectionMap(state.selectedFeature);
      if (state.correctionMap) {
        setTimeout(() => state.correctionMap.invalidateSize(), 0);
      }
    } else {
      correctionMapEl.parentElement?.classList.add("is-hidden");
      if (state.correctionMarker && state.correctionMap) {
        state.correctionMap.removeLayer(state.correctionMarker);
        state.correctionMarker = null;
      }
      clearCorrection();
    }
  });
}

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
