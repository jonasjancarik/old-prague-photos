import { authorizeAdmin } from "../_admin_auth.js";
import { requireCatalog } from "../_catalog.js";

const MAX_GROUP_RESULTS = 20;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function normalize(value) {
  return String(value || "").trim();
}

function escapeLike(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function descriptionFromFeatureJson(value) {
  try {
    return normalize(JSON.parse(String(value || "{}")).description);
  } catch {
    return "";
  }
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return jsonResponse({ detail: "Method Not Allowed" }, 405);
  }
  if (!env.CORRECTIONS_DB) {
    return jsonResponse({ detail: "Chybí CORRECTIONS_DB" }, 500);
  }
  const authResponse = await authorizeAdmin(request, env);
  if (authResponse) return authResponse;

  try {
    await requireCatalog(request, env);
  } catch (error) {
    return jsonResponse({ detail: "Katalog fotografií není dočasně dostupný" }, 503);
  }

  const query = normalize(new URL(request.url).searchParams.get("query"))
    .toLocaleLowerCase("cs-CZ")
    .slice(0, 200);
  if (query.length < 2) {
    return jsonResponse({ items: [] });
  }

  const pattern = `%${escapeLike(query)}%`;
  const groupPrefix = `${escapeLike(query)}%`;
  if (
    new TextEncoder().encode(pattern).length > 50 ||
    new TextEncoder().encode(groupPrefix).length > 50
  ) {
    return jsonResponse({ detail: "Hledejte kratší text." }, 400);
  }
  let rows;
  try {
    const result = await env.CORRECTIONS_DB.prepare(
      `
        SELECT
          COALESCE(overrides.group_id, photos.base_group_id) AS group_id,
          COUNT(*) AS member_count,
          MIN(CASE WHEN
            photos.search_text LIKE ? ESCAPE '\\'
            OR lower(COALESCE(overrides.group_id, photos.base_group_id)) LIKE ? ESCAPE '\\'
            THEN photos.xid
          END) AS sample_xid,
          MIN(CASE WHEN
            photos.search_text LIKE ? ESCAPE '\\'
            OR lower(COALESCE(overrides.group_id, photos.base_group_id)) LIKE ? ESCAPE '\\'
            THEN photos.feature_json
          END) AS feature_json
        FROM catalog_photos AS photos
        LEFT JOIN group_membership_overrides AS overrides
          ON overrides.xid = photos.xid
        GROUP BY COALESCE(overrides.group_id, photos.base_group_id)
        HAVING SUM(CASE WHEN
          photos.search_text LIKE ? ESCAPE '\\'
          OR lower(COALESCE(overrides.group_id, photos.base_group_id)) LIKE ? ESCAPE '\\'
          THEN 1 ELSE 0
        END) > 0
        ORDER BY
          CASE WHEN lower(COALESCE(overrides.group_id, photos.base_group_id)) LIKE ? ESCAPE '\\'
            THEN 0 ELSE 1
          END,
          group_id
        LIMIT ${MAX_GROUP_RESULTS}
      `,
    )
      .bind(pattern, pattern, pattern, pattern, pattern, pattern, groupPrefix)
      .all();
    rows = result?.results || [];
  } catch (error) {
    return jsonResponse({ detail: "Skupiny nejsou dočasně dostupné" }, 503);
  }

  const items = rows.map((row) => ({
    group_id: normalize(row.group_id),
    member_count: Number(row.member_count) || 0,
    sample_xid: normalize(row.sample_xid),
    description: descriptionFromFeatureJson(row.feature_json),
  }));

  return jsonResponse({ items });
}
