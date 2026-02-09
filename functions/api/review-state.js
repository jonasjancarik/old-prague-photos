import { buildReviewState, loadXidGroupMap } from "./_review_state.js";

const CACHE_TTL_SECONDS = 30;
const FRESH_PARAM_VALUES = new Set(["1", "true", "yes", "on"]);

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

async function queryRows(env, query) {
  const result = await env.CORRECTIONS_DB.prepare(query).all();
  return result?.results || [];
}

function cacheKeyFor(request) {
  const url = new URL(request.url);
  url.search = "";
  url.hash = "";
  return new Request(url.toString(), { method: "GET" });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "GET") {
    return jsonResponse({ detail: "Method Not Allowed" }, 405, {
      "Cache-Control": "no-store",
    });
  }

  const url = new URL(request.url);
  const freshParam = String(url.searchParams.get("fresh") || "").toLowerCase();
  const forceFresh = FRESH_PARAM_VALUES.has(freshParam);
  const key = cacheKeyFor(request);
  const edgeCache =
    typeof caches !== "undefined" && caches.default ? caches.default : null;

  if (!forceFresh && edgeCache) {
    const cached = await edgeCache.match(key);
    if (cached) {
      return cached;
    }
  }

  const correctionRows = await queryRows(
    env,
    `
      SELECT
        id,
        xid,
        group_id,
        lat,
        lon,
        has_coordinates,
        verdict,
        created_at
      FROM corrections
    `,
  );

  let mergeRows = [];
  try {
    mergeRows = await queryRows(
      env,
      `
        SELECT
          id,
          group_id_a,
          group_id_b,
          verdict,
          created_at
        FROM merge_decisions
      `,
    );
  } catch (error) {
    mergeRows = [];
  }

  const xidGroupMap = await loadXidGroupMap(request, env);
  const reviewState = buildReviewState({
    correctionRows,
    mergeRows,
    xidGroupMap,
  });

  const payload = {
    ...reviewState,
    counts: {
      corrections: reviewState.groupCorrections.length,
      doneGroups: reviewState.doneGroupIds.length,
      merges: reviewState.mergeDecisions.length,
      knownXids: Object.keys(reviewState.resolvedGroupByXid).length,
    },
  };

  const response = jsonResponse(payload, 200, {
    "Cache-Control": forceFresh
      ? "no-store"
      : `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${CACHE_TTL_SECONDS}`,
  });

  if (!forceFresh && edgeCache) {
    context.waitUntil(edgeCache.put(key, response.clone()));
  }

  return response;
}
