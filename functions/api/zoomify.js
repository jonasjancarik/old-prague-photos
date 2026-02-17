const ARCHIVE_DEFAULT = "https://katalog.ahmp.cz/pragapublica";
const PHOTO_CACHE_TTL_MS = 60 * 1000;
let featureScanCache = new Map();
let featureScanCacheExpiresAt = 0;

function normalizeId(value) {
  return String(value || "").trim();
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
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

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function htmlUnescape(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function extract(pattern, text) {
  const match = text.match(pattern);
  return match?.[1] || null;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "old-prague-photos/zoomify",
    },
  });
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }
  return response.text();
}

async function fetchTextIfExists(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "old-prague-photos/zoomify",
    },
  });
  if (!response.ok) {
    return null;
  }
  return response.text();
}

function parseImageProperties(propsXml) {
  const width = extract(/WIDTH="(\d+)"/i, propsXml);
  const height = extract(/HEIGHT="(\d+)"/i, propsXml);
  const tileSize = extract(/TILESIZE="(\d+)"/i, propsXml);
  return {
    width: width ? Number(width) : null,
    height: height ? Number(height) : null,
    tileSize: tileSize ? Number(tileSize) : null,
  };
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

async function loadFeatureScanMap(request, env, options = {}) {
  const { forceRefresh = false } = options;
  const now = Date.now();
  if (!forceRefresh && now < featureScanCacheExpiresAt) {
    return featureScanCache;
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

  featureScanCache = mapping;
  featureScanCacheExpiresAt = now + PHOTO_CACHE_TTL_MS;
  return featureScanCache;
}

async function resolveFromR2({ r2BaseUrl, xid, scanIndex }) {
  const base = normalizeBaseUrl(r2BaseUrl);
  if (!base) return null;
  const zoomifyImgPath = `${base}/${encodeURIComponent(xid)}/scan_${scanIndex}`;
  const imagePropsUrl = `${zoomifyImgPath}/ImageProperties.xml`;
  const propsXml = await fetchTextIfExists(imagePropsUrl);
  if (!propsXml) return null;
  const props = parseImageProperties(propsXml);
  if (!props.width || !props.height || !props.tileSize) return null;
  return {
    xid,
    scanIndex,
    zoomifyImgPath,
    imagePropertiesUrl: imagePropsUrl,
    ...props,
    source: "r2",
  };
}

async function resolveFromFeatureMetadata({
  request,
  env,
  xid,
  scanIndex,
  allowArchiveFallback,
}) {
  let scanMap = await loadFeatureScanMap(request, env);
  if (!scanMap.has(xid)) {
    scanMap = await loadFeatureScanMap(request, env, { forceRefresh: true });
  }

  const props = scanMap.get(xid) || {};
  const scanZoomifyPaths = Array.isArray(props?.scan_zoomify_paths)
    ? props.scan_zoomify_paths
    : [];
  const zoomifyImgPath = pickCandidate(
    [scanZoomifyPaths[scanIndex], scanZoomifyPaths[0]],
    { allowArchiveFallback },
  );
  if (!zoomifyImgPath) return null;

  const imagePropsUrl = `${zoomifyImgPath.replace(/\/$/, "")}/ImageProperties.xml`;
  const propsXml = await fetchTextIfExists(imagePropsUrl);
  if (!propsXml) return null;

  const parsed = parseImageProperties(propsXml);
  if (!parsed.width || !parsed.height || !parsed.tileSize) return null;

  return {
    xid,
    scanIndex,
    zoomifyImgPath: zoomifyImgPath.replace(/\/$/, ""),
    imagePropertiesUrl: imagePropsUrl,
    ...parsed,
    source: "feature_zoomify",
  };
}

async function resolveZoomify({
  request,
  env,
  archiveBaseUrl,
  xid,
  scanIndex,
  r2BaseUrl,
  allowArchiveFallback,
}) {
  const scanParam = Number.isFinite(scanIndex) && scanIndex >= 0 ? scanIndex : 0;
  const r2Payload = await resolveFromR2({
    r2BaseUrl,
    xid,
    scanIndex: scanParam,
  });
  if (r2Payload) {
    return r2Payload;
  }
  const featurePayload = await resolveFromFeatureMetadata({
    request,
    env,
    xid,
    scanIndex: scanParam,
    allowArchiveFallback,
  });
  if (featurePayload) {
    return featurePayload;
  }
  if (!allowArchiveFallback) {
    throw new Error("Zoomify není dostupné v naší infrastruktuře");
  }
  const permalinkUrl = `${archiveBaseUrl.replace(/\/$/, "")}/permalink?xid=${encodeURIComponent(
    xid,
  )}&scan=${scanParam + 1}`;
  const permalinkHtml = await fetchText(permalinkUrl);

  let zoomifyImgPath = extract(/zoomifyImgPath\s*=\s*"([^"]+)"/i, permalinkHtml);
  if (!zoomifyImgPath) {
    const zoomifyRaw = extract(/Zoomify\.action[^"']+/i, permalinkHtml);
    if (!zoomifyRaw) {
      throw new Error("Zoomify link not found");
    }
    const zoomifyUrlObj = new URL(htmlUnescape(zoomifyRaw), permalinkUrl);
    zoomifyUrlObj.searchParams.set("scanIndex", String(scanParam));
    const zoomifyUrl = zoomifyUrlObj.toString();
    const zoomifyHtml = await fetchText(zoomifyUrl);
    zoomifyImgPath = extract(/zoomifyImgPath\s*=\s*"([^"]+)"/i, zoomifyHtml);
  }
  if (!zoomifyImgPath) {
    throw new Error("zoomifyImgPath not found");
  }
  const normalizedZoomifyImgPath = zoomifyImgPath.replace(/\/$/, "");

  const imagePropsUrl = `${normalizedZoomifyImgPath}/ImageProperties.xml`;
  const propsXml = await fetchText(imagePropsUrl);
  const props = parseImageProperties(propsXml);

  return {
    xid,
    scanIndex: scanParam,
    zoomifyImgPath: normalizedZoomifyImgPath,
    imagePropertiesUrl: imagePropsUrl,
    ...props,
    source: "archive",
  };
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const xid = normalizeId(url.searchParams.get("xid"));
  const scanIndex = normalizeScanIndex(url.searchParams.get("scanIndex"));
  if (!xid) {
    return jsonResponse({ detail: "Chybí xid" }, 400);
  }

  const archiveBaseUrl = normalizeBaseUrl(env.ARCHIVE_BASE_URL || ARCHIVE_DEFAULT);
  const r2BaseUrl = normalizeBaseUrl(env.R2_TILES_BASE || "");
  const allowArchiveFallback = parseBool(env.ALLOW_ARCHIVE_FALLBACK, false);

  try {
    const payload = await resolveZoomify({
      request,
      env,
      archiveBaseUrl,
      xid,
      scanIndex,
      r2BaseUrl,
      allowArchiveFallback,
    });
    return jsonResponse(payload);
  } catch (error) {
    return jsonResponse({ detail: error.message || "Nepodařilo se načíst zoom" }, 502);
  }
}
