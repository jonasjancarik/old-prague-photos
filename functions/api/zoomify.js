const ARCHIVE_DEFAULT = "https://katalog.ahmp.cz/pragapublica";

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

async function resolveZoomify({ archiveBaseUrl, xid }) {
  const permalinkUrl = `${archiveBaseUrl.replace(/\/$/, "")}/permalink?xid=${encodeURIComponent(xid)}&scan=1`;
  const permalinkHtml = await fetchText(permalinkUrl);

  const zoomifyRaw = extract(/Zoomify\\.action[^\"']+/i, permalinkHtml);
  if (!zoomifyRaw) {
    throw new Error("Zoomify link not found");
  }

  const zoomifyUrl = new URL(htmlUnescape(zoomifyRaw), permalinkUrl).toString();
  const zoomifyHtml = await fetchText(zoomifyUrl);

  const zoomifyImgPath = extract(/zoomifyImgPath\\s*=\\s*\"([^\"]+)\"/i, zoomifyHtml);
  if (!zoomifyImgPath) {
    throw new Error("zoomifyImgPath not found");
  }

  const imagePropsUrl = `${zoomifyImgPath}/ImageProperties.xml`;
  const propsXml = await fetchText(imagePropsUrl);

  const width = extract(/WIDTH=\"(\\d+)\"/i, propsXml);
  const height = extract(/HEIGHT=\"(\\d+)\"/i, propsXml);
  const tileSize = extract(/TILESIZE=\"(\\d+)\"/i, propsXml);

  return {
    xid,
    zoomifyImgPath,
    imagePropertiesUrl: imagePropsUrl,
    width: width ? Number(width) : null,
    height: height ? Number(height) : null,
    tileSize: tileSize ? Number(tileSize) : null,
  };
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const xid = (url.searchParams.get("xid") || "").trim();
  if (!xid) {
    return jsonResponse({ detail: "Chybí xid" }, 400);
  }

  const archiveBaseUrl = (env.ARCHIVE_BASE_URL || ARCHIVE_DEFAULT).replace(/\\/$/, "");

  try {
    const payload = await resolveZoomify({ archiveBaseUrl, xid });
    return jsonResponse(payload);
  } catch (error) {
    return jsonResponse({ detail: error.message || "Nepodařilo se načíst zoom" }, 502);
  }
}
