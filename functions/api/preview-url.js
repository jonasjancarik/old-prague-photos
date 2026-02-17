const PHOTO_CACHE_TTL_MS = 60 * 1000;
const R2_PROBE_CACHE_TTL_MS = 5 * 60 * 1000;

let featurePreviewCache = new Map();
let featurePreviewCacheExpiresAt = 0;
let r2ProbeCache = new Map();

function normalizeId(value) {
  return String(value || "").trim();
}

function normalizeBaseUrl(value) {
  return normalizeId(value).replace(/\/$/, "");
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function normalizeScanIndex(value) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseBool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function isArchiveUrl(value) {
  const raw = normalizeId(value);
  if (!raw) return false;
  try {
    const parsed = new URL(raw, "http://local.invalid");
    const host = String(parsed.hostname || "").toLowerCase();
    return host === "ahmp.cz" || host.endsWith(".ahmp.cz");
  } catch {
    return false;
  }
}

function pickCandidate(candidates, options = {}) {
  const { allowArchiveFallback = true } = options;
  for (let index = 0; index < candidates.length; index += 1) {
    const value = normalizeId(candidates[index]);
    if (!value) continue;
    if (!allowArchiveFallback && isArchiveUrl(value)) continue;
    return value;
  }
  return "";
}

function previewFromFeatureProps(props, scanIndex = 0, options = {}) {
  const { allowArchiveFallback = true } = options;
  const normalizedScanIndex = normalizeScanIndex(scanIndex);
  const previews = Array.isArray(props?.scan_previews) ? props.scan_previews : [];
  const previewUrl = pickCandidate(
    [previews[normalizedScanIndex], previews[0]],
    { allowArchiveFallback },
  );
  if (previewUrl) {
    return { url: previewUrl, source: "feature_preview" };
  }

  const zoomifyPaths = Array.isArray(props?.scan_zoomify_paths)
    ? props.scan_zoomify_paths
    : [];
  const zoomifyPath = pickCandidate(
    [zoomifyPaths[normalizedScanIndex], zoomifyPaths[0]],
    { allowArchiveFallback },
  );
  if (zoomifyPath) {
    return {
      url: `${zoomifyPath.replace(/\/$/, "")}/TileGroup0/0-0-0.jpg`,
      source: "feature_zoomify",
    };
  }

  return { url: "", source: "none" };
}

async function fetchPhotosJson(request, env) {
  if (!request || !env?.ASSETS) return null;
  const url = new URL(request.url);
  url.pathname = "/data/photos.geojson";
  url.search = "";
  const response = await env.ASSETS.fetch(new Request(url.toString()));
  if (!response.ok) return null;
  return response.json();
}

async function loadFeaturePreviewMap(request, env, options = {}) {
  const { forceRefresh = false } = options;
  const now = Date.now();
  if (!forceRefresh && now < featurePreviewCacheExpiresAt) {
    return featurePreviewCache;
  }

  const mapping = new Map();
  try {
    const photos = await fetchPhotosJson(request, env);
    const features = Array.isArray(photos?.features) ? photos.features : [];
    features.forEach((feature) => {
      const props = feature?.properties || {};
      const xid = normalizeId(props.id);
      if (!xid) return;
      mapping.set(xid, props);
    });
  } catch (error) {
    // keep empty map on read failures
  }

  featurePreviewCache = mapping;
  featurePreviewCacheExpiresAt = now + PHOTO_CACHE_TTL_MS;
  return featurePreviewCache;
}

function r2PreviewUrl(r2Base, xid, scanIndex = 0) {
  const base = normalizeBaseUrl(r2Base);
  if (!base || !xid) return "";
  return `${base}/${encodeURIComponent(xid)}/scan_${scanIndex}/TileGroup0/0-0-0.jpg`;
}

async function probeUrlExists(url) {
  if (!url) return false;
  const cached = r2ProbeCache.get(url);
  const now = Date.now();
  if (cached && now < cached.expiresAt) {
    return cached.ok;
  }

  const headers = { "User-Agent": "old-prague-photos/preview-probe" };
  let ok = false;
  try {
    const head = await fetch(url, { method: "HEAD", headers });
    if (head.ok) {
      ok = true;
    } else if (head.status === 405 || head.status === 501) {
      const get = await fetch(url, { method: "GET", headers });
      ok = get.ok;
    }
  } catch (error) {
    ok = false;
  }

  r2ProbeCache.set(url, {
    ok,
    expiresAt: now + R2_PROBE_CACHE_TTL_MS,
  });
  return ok;
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return jsonResponse({ detail: "Method Not Allowed" }, 405);
  }

  const url = new URL(request.url);
  const xid = normalizeId(url.searchParams.get("xid"));
  const scanIndex = normalizeScanIndex(url.searchParams.get("scanIndex"));
  const allowArchiveFallback = parseBool(env.ALLOW_ARCHIVE_FALLBACK, false);
  if (!xid) {
    return jsonResponse({ detail: "Chybí xid" }, 400);
  }

  const r2Candidate = r2PreviewUrl(env.R2_TILES_BASE || "", xid, scanIndex);
  if (r2Candidate && (await probeUrlExists(r2Candidate))) {
    return jsonResponse({
      xid,
      scan_index: scanIndex,
      url: r2Candidate,
      source: "r2_tile",
    });
  }

  let previewMap = await loadFeaturePreviewMap(request, env);
  if (!previewMap.has(xid)) {
    previewMap = await loadFeaturePreviewMap(request, env, { forceRefresh: true });
  }
  const preview = previewFromFeatureProps(previewMap.get(xid) || {}, scanIndex, {
    allowArchiveFallback,
  });
  return jsonResponse({
    xid,
    scan_index: scanIndex,
    url: normalizeId(preview.url),
    source: normalizeId(preview.source) || "none",
  });
}
