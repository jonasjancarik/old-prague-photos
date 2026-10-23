import {
  catalogFeature,
  findCatalogPhoto,
  requireCatalog,
} from "./_catalog.js";
import {
  catalogScanCount,
  fetchImageResource,
  isValidImageId,
  parseScanIndex,
} from "./_image_requests.js";

const R2_PROBE_CACHE_TTL_MS = 5 * 60 * 1000;
const R2_PROBE_CACHE_MAX_ENTRIES = 256;

const r2ProbeCache = new Map();

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
  const normalizedScanIndex = scanIndex;
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

function r2PreviewUrl(r2Base, xid, scanIndex = 0) {
  const base = normalizeBaseUrl(r2Base);
  if (!base || !xid) return "";
  return `${base}/${encodeURIComponent(xid)}/scan_${scanIndex}/TileGroup0/0-0-0.jpg`;
}

async function probeUrlExists(url) {
  if (!url) return false;
  const now = Date.now();
  for (const [key, entry] of r2ProbeCache) {
    if (now >= entry.expiresAt) r2ProbeCache.delete(key);
  }
  const cached = r2ProbeCache.get(url);
  if (cached) {
    return cached.ok;
  }

  const userAgent = "old-prague-photos/preview-probe";
  let ok = false;
  try {
    const head = await fetchImageResource(url, { method: "HEAD", userAgent });
    if (head.ok) {
      ok = true;
    } else if (head.status === 405 || head.status === 501) {
      const get = await fetchImageResource(url, { userAgent });
      ok = get.ok;
    }
  } catch (error) {
    ok = false;
  }

  if (r2ProbeCache.size >= R2_PROBE_CACHE_MAX_ENTRIES) {
    r2ProbeCache.delete(r2ProbeCache.keys().next().value);
  }
  r2ProbeCache.set(url, {
    ok,
    expiresAt: Date.now() + R2_PROBE_CACHE_TTL_MS,
  });
  return ok;
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return jsonResponse({ detail: "Method Not Allowed" }, 405);
  }

  const url = new URL(request.url);
  const xid = normalizeId(url.searchParams.get("xid"));
  const scanIndex = parseScanIndex(url.searchParams.get("scanIndex"));
  const allowArchiveFallback = parseBool(env.ALLOW_ARCHIVE_FALLBACK, false);
  if (!xid) {
    return jsonResponse({ detail: "Chybí xid" }, 400);
  }
  if (!isValidImageId(xid) || scanIndex === null) {
    return jsonResponse({ detail: "Neplatné ID fotografie nebo číslo snímku" }, 400);
  }

  let catalogRow;
  try {
    await requireCatalog(request, env);
    catalogRow = await findCatalogPhoto(env, xid);
  } catch (error) {
    return jsonResponse({ detail: "Katalog fotografií není dočasně dostupný" }, 503);
  }
  if (!catalogRow) return jsonResponse({ detail: "Fotografie nebyla nalezena" }, 404);
  const props = catalogFeature(catalogRow)?.properties || {};
  if (scanIndex >= catalogScanCount(props)) {
    return jsonResponse({ detail: "Snímek nebyl nalezen" }, 404);
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

  const preview = previewFromFeatureProps(
    props,
    scanIndex,
    {
      allowArchiveFallback,
    },
  );
  return jsonResponse({
    xid,
    scan_index: scanIndex,
    url: normalizeId(preview.url),
    source: normalizeId(preview.source) || "none",
  });
}
