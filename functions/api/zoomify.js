const ARCHIVE_DEFAULT = "https://katalog.ahmp.cz/pragapublica";

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
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

async function resolveZoomify({ archiveBaseUrl, xid, scanIndex, r2BaseUrl }) {
  const scanParam = Number.isFinite(scanIndex) && scanIndex >= 0 ? scanIndex : 0;
  const r2Payload = await resolveFromR2({
    r2BaseUrl,
    xid,
    scanIndex: scanParam,
  });
  if (r2Payload) {
    return r2Payload;
  }
  const permalinkUrl = `${archiveBaseUrl.replace(/\/$/, "")}/permalink?xid=${encodeURIComponent(
    xid,
  )}&scan=${scanParam + 1}`;
  const permalinkHtml = await fetchText(permalinkUrl);

  const zoomifyRaw = extract(/Zoomify\.action[^"']+/i, permalinkHtml);
  if (!zoomifyRaw) {
    throw new Error("Zoomify link not found");
  }

  const zoomifyUrlObj = new URL(htmlUnescape(zoomifyRaw), permalinkUrl);
  zoomifyUrlObj.searchParams.set("scanIndex", String(scanParam));
  const zoomifyUrl = zoomifyUrlObj.toString();
  const zoomifyHtml = await fetchText(zoomifyUrl);

  const zoomifyImgPath = extract(/zoomifyImgPath\s*=\s*"([^"]+)"/i, zoomifyHtml);
  if (!zoomifyImgPath) {
    throw new Error("zoomifyImgPath not found");
  }

  const imagePropsUrl = `${zoomifyImgPath}/ImageProperties.xml`;
  const propsXml = await fetchText(imagePropsUrl);
  const props = parseImageProperties(propsXml);

  return {
    xid,
    scanIndex: scanParam,
    zoomifyImgPath,
    imagePropertiesUrl: imagePropsUrl,
    ...props,
    source: "archive",
  };
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const xid = (url.searchParams.get("xid") || "").trim();
  const scanIndexRaw = url.searchParams.get("scanIndex");
  const scanIndex = scanIndexRaw ? Number.parseInt(scanIndexRaw, 10) : 0;
  if (!xid) {
    return jsonResponse({ detail: "Chybí xid" }, 400);
  }

  const archiveBaseUrl = normalizeBaseUrl(env.ARCHIVE_BASE_URL || ARCHIVE_DEFAULT);
  const r2BaseUrl = normalizeBaseUrl(env.R2_ZOOMIFY_BASE || env.R2_BASE_URL || "");

  try {
    const payload = await resolveZoomify({
      archiveBaseUrl,
      xid,
      scanIndex,
      r2BaseUrl,
    });
    return jsonResponse(payload);
  } catch (error) {
    return jsonResponse({ detail: error.message || "Nepodařilo se načíst zoom" }, 502);
  }
}
