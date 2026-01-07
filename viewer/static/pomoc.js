const state = {
  map: null,
  originalMarker: null,
  proposedMarker: null,
  mode: null, // null | "ok" | "wrong"
  turnstileSiteKey: "",
  turnstileBypass: false,
  turnstileReady: false,
  turnstileWidgetId: null,
  turnstileToken: "",
  archiveBaseUrl: "https://katalog.ahmp.cz/pragapublica",
  features: [],
  remaining: [],
  current: null,
  proposed: null,
};

const iframe = document.getElementById("help-iframe");
const zoomWrap = iframe?.closest(".zoom-wrap");
const zoomViewerEl = document.getElementById("help-zoom");
const remainingEl = document.getElementById("remaining-count");
const currentXidEl = document.getElementById("current-xid");
const openArchiveEl = document.getElementById("open-archive");
const detailsEl = document.getElementById("help-details");
const submitOkBtn = document.getElementById("submit-ok");
const submitCorrectionBtn = document.getElementById("submit-correction");
const skipBtn = document.getElementById("skip-photo");
const voteUpBtn = document.getElementById("vote-up");
const voteDownBtn = document.getElementById("vote-down");
const helpForm = document.getElementById("help-form");
const helpMapNote = document.getElementById("help-map-note");
const messageEl = document.getElementById("help-message");
const emailEl = document.getElementById("help-email");
const formStatus = document.getElementById("form-status");
const turnstileNote = document.getElementById("turnstile-note");

const pragueFallback = [50.0755, 14.4378];

let zoomViewer = null;
let zoomLastXid = null;

function setStatus(message, tone = "") {
  formStatus.textContent = message;
  formStatus.dataset.tone = tone;
}

function clearStatus() {
  formStatus.textContent = "";
  formStatus.dataset.tone = "";
}

function updateCounts() {
  remainingEl.textContent = state.remaining.length
    ? state.remaining.length.toLocaleString()
    : "—";
  currentXidEl.textContent = state.current?.properties?.id || "—";
}

function updateSubmitState() {
  const hasTurnstile = state.turnstileBypass || Boolean(state.turnstileToken);

  const canOk = Boolean(state.current) && state.mode === "ok" && hasTurnstile;
  const canWrong =
    Boolean(state.current) &&
    state.mode === "wrong" &&
    Boolean(state.proposed) &&
    hasTurnstile;

  submitOkBtn.disabled = !canOk;
  submitCorrectionBtn.disabled = !canWrong;
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

async function loadZoomifyInto(xid) {
  if (!zoomViewerEl || !zoomWrap) return;
  if (zoomLastXid === xid) return;
  zoomLastXid = xid;
  zoomWrap.classList.remove("is-fallback");

  try {
    if (!window.OpenSeadragon) {
      throw new Error("OpenSeadragon chybí");
    }

    const meta = await loadZoomifyMeta(xid);

    if (!zoomViewer) {
      zoomViewer = window.OpenSeadragon({
        element: zoomViewerEl,
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
    zoomWrap.classList.add("is-fallback");
  }
}

function getArchiveUrl(xid) {
  return `${state.archiveBaseUrl.replace(/\/$/, "")}/permalink?xid=${xid}&scan=1#scan1`;
}

function initMap() {
  state.map = L.map("help-map", {
    zoomControl: true,
    scrollWheelZoom: true,
  }).setView(pragueFallback, 13);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap přispěvatelé",
  }).addTo(state.map);

  state.map.on("click", (event) => {
    if (state.mode !== "wrong") return;
    const { lat, lng } = event.latlng;
    state.proposed = { lat: Number(lat.toFixed(6)), lon: Number(lng.toFixed(6)) };
    if (!state.proposedMarker) {
      state.proposedMarker = L.marker([lat, lng]).addTo(state.map);
    } else {
      state.proposedMarker.setLatLng([lat, lng]);
    }
    updateSubmitState();
  });
}

function showFeature(feature) {
  state.current = feature;
  state.proposed = null;
  state.mode = null;
  clearStatus();
  updateCounts();
  updateSubmitState();

  if (window.OldPragueMeta?.renderDetails) {
    window.OldPragueMeta.renderDetails(detailsEl, feature, state.archiveBaseUrl);
  }

  if (messageEl) messageEl.value = "";
  if (emailEl) emailEl.value = "";
  if (helpForm) helpForm.classList.add("is-hidden");
  submitOkBtn.classList.remove("is-hidden");
  submitCorrectionBtn.classList.add("is-hidden");
  if (helpMapNote) helpMapNote.textContent = "Označená poloha je naše nejlepší shoda. Sedí?";

  const xid = feature.properties.id;
  const url = getArchiveUrl(xid);
  iframe.src = url;
  openArchiveEl.href = url;
  loadZoomifyInto(xid);

  const [lon, lat] = feature.geometry.coordinates;
  const point = [lat, lon];

  if (!state.originalMarker) {
    state.originalMarker = L.circleMarker(point, {
      radius: 10,
      weight: 2,
      color: "#2b6e78",
      fillColor: "#2b6e78",
      fillOpacity: 0.25,
    }).addTo(state.map);
  } else {
    state.originalMarker.setLatLng(point);
  }

  if (state.proposedMarker) {
    state.map.removeLayer(state.proposedMarker);
    state.proposedMarker = null;
  }

  state.map.setView(point, Math.max(state.map.getZoom(), 15), { animate: true });
}

function setMode(mode) {
  state.mode = mode;
  clearStatus();

  if (!helpForm) return;
  helpForm.classList.remove("is-hidden");

  if (mode === "ok") {
    submitOkBtn.classList.remove("is-hidden");
    submitCorrectionBtn.classList.add("is-hidden");
    if (helpMapNote) helpMapNote.textContent = "Sedí? Potvrďte 👍.";
    updateSubmitState();
    return;
  }

  submitOkBtn.classList.add("is-hidden");
  submitCorrectionBtn.classList.remove("is-hidden");
  if (helpMapNote) helpMapNote.textContent = "Nesedí? Klikněte do mapy na správné místo.";
  updateSubmitState();
}

function pickRandom() {
  if (!state.remaining.length) {
    state.remaining = [...state.features];
  }

  const idx = Math.floor(Math.random() * state.remaining.length);
  const feature = state.remaining.splice(idx, 1)[0];
  showFeature(feature);
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

  if (state.turnstileWidgetId !== null) return;

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

async function submitCorrection() {
  if (!state.current || state.mode !== "wrong" || !state.proposed) return;

  clearStatus();

  if (!state.turnstileToken && !state.turnstileBypass) {
    setStatus("Dokončete Turnstile kontrolu.", "error");
    return;
  }

  const payload = {
    xid: state.current.properties.id,
    lat: state.proposed.lat,
    lon: state.proposed.lon,
    verdict: "wrong",
    message: (messageEl?.value || "").trim() || "Nahlášena špatná poloha.",
    email: (emailEl?.value || "").trim() || null,
    token: state.turnstileToken || "",
  };

  submitCorrectionBtn.disabled = true;

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

    setStatus("Díky! Uloženo. Jdeme na další.", "success");
    state.turnstileToken = "";
    if (state.turnstileWidgetId !== null && window.turnstile) {
      window.turnstile.reset(state.turnstileWidgetId);
    }
    setTimeout(() => pickRandom(), 400);
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
    updateSubmitState();
  }
}

async function submitOk() {
  if (!state.current || state.mode !== "ok") return;

  clearStatus();

  if (!state.turnstileToken && !state.turnstileBypass) {
    setStatus("Dokončete Turnstile kontrolu.", "error");
    return;
  }

  const payload = {
    xid: state.current.properties.id,
    verdict: "ok",
    message: "Poloha potvrzena jako OK.",
    token: state.turnstileToken || "",
  };

  submitOkBtn.disabled = true;

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

    setStatus("Díky! Potvrzeno. Jdeme na další.", "success");
    state.turnstileToken = "";
    if (state.turnstileWidgetId !== null && window.turnstile) {
      window.turnstile.reset(state.turnstileWidgetId);
    }
    setTimeout(() => pickRandom(), 400);
  } catch (error) {
    setStatus(error.message || "Odeslání selhalo", "error");
    updateSubmitState();
  }
}

async function bootstrap() {
  initMap();

  const config = await fetchJson("/api/config").catch(() => ({}));
  state.turnstileSiteKey = config.turnstileSiteKey || "";
  state.turnstileBypass = Boolean(config.turnstileBypass);
  state.archiveBaseUrl = config.archiveBaseUrl || state.archiveBaseUrl;
  renderTurnstile();

  const photos = await fetchJson("/data/photos.geojson");
  state.features = photos.features || [];

  const corrections = await fetchJson("/api/corrections").catch(() => ({
    items: [],
  }));

  const done = new Set(
    (corrections.items || [])
      .filter((item) => item?.xid && (item?.has_coordinates || item?.verdict === "ok"))
      .map((item) => item.xid),
  );

  state.remaining = state.features.filter((f) => !done.has(f.properties.id));
  updateCounts();

  pickRandom();
}

submitOkBtn.addEventListener("click", () => submitOk());
submitCorrectionBtn.addEventListener("click", () => submitCorrection());
skipBtn.addEventListener("click", () => pickRandom());
voteUpBtn.addEventListener("click", () => setMode("ok"));
voteDownBtn.addEventListener("click", () => setMode("wrong"));

bootstrap().catch((error) => {
  setStatus("Nepodařilo se načíst data.", "error");
  console.error(error);
});
