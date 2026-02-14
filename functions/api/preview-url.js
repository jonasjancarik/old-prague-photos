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

function previewFromFeatureProps(props) {
  const previews = Array.isArray(props?.scan_previews) ? props.scan_previews : [];
  const previewUrl = normalizeId(previews[0]);
  if (previewUrl) {
    return { url: previewUrl, source: "feature_preview" };
  }

  const zoomifyPaths = Array.isArray(props?.scan_zoomify_paths)
    ? props.scan_zoomify_paths
    : [];
  const zoomifyPath = normalizeId(zoomifyPaths[0]);
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

async function loadFeaturePreviewMap(request, env) {
  const now = Date.now();
  if (now < featurePreviewCacheExpiresAt) {
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
      const preview = previewFromFeatureProps(props);
      mapping.set(xid, preview);
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
  if (!xid) {
    return jsonResponse({ detail: "Chybí xid" }, 400);
  }

  const r2Candidate = r2PreviewUrl(env.R2_TILES_BASE || "", xid, 0);
  if (r2Candidate && (await probeUrlExists(r2Candidate))) {
    return jsonResponse({
      xid,
      url: r2Candidate,
      source: "r2_tile",
    });
  }

  const previewMap = await loadFeaturePreviewMap(request, env);
  const preview = previewMap.get(xid) || { url: "", source: "none" };
  return jsonResponse({
    xid,
    url: normalizeId(preview.url),
    source: normalizeId(preview.source) || "none",
  });
}
