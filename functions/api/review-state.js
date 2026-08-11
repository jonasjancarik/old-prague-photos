import {
  buildReviewState,
  loadXidGroupMap,
  REVIEW_STATE_SCHEMA_VERSION,
} from "./_review_state.js";
import { loadCommunityDataVersion } from "./_data_version.js";
import {
  isMissingColumnError,
  logDatabaseError,
} from "./_db.js";

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

function cacheKeyFor(request, dataVersion) {
  const url = new URL(request.url);
  url.search = "";
  url.searchParams.set("__community_data_version", dataVersion);
  url.searchParams.set(
    "__review_state_schema_version",
    String(REVIEW_STATE_SCHEMA_VERSION),
  );
  url.hash = "";
  return new Request(url.toString(), { method: "GET" });
}

function responseCacheControl(forceFresh) {
  return forceFresh
    ? "no-store"
    : `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${CACHE_TTL_SECONDS}`;
}

async function readProjection(env) {
  try {
    return await env.CORRECTIONS_DB.prepare(
      `
        SELECT current_revision, computed_revision, data_version, payload_json
        FROM community_state_projection
        WHERE id = 1
      `,
    ).first();
  } catch (error) {
    if (/no such table[^]*community_state_projection/iu.test(String(error?.message || error))) {
      return null;
    }
    throw error;
  }
}

async function loadReviewRows(env) {
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
        voter_key,
        verdict,
        location_revision,
        proposal_id,
        created_at
      FROM corrections
    `,
  );

  let mergeRows;
  try {
    mergeRows = await queryRows(
      env,
      `
        SELECT
          id,
          group_id_a,
          group_id_b,
          verdict,
          voter_key,
          created_at
        FROM (
          SELECT
            id,
            group_id_a,
            group_id_b,
            verdict,
            voter_key,
            created_at,
            ROW_NUMBER() OVER (
              PARTITION BY
                group_id_a,
                group_id_b,
                COALESCE(NULLIF(voter_key, ''), 'legacy')
              ORDER BY created_at DESC, id DESC
            ) AS active_rank
          FROM merge_decisions
        )
        WHERE active_rank = 1
      `,
    );
  } catch (error) {
    if (!isMissingColumnError(error, ["voter_key"])) {
      throw error;
    }
    mergeRows = await queryRows(
      env,
      `
        SELECT
          id,
          group_id_a,
          group_id_b,
          verdict,
          created_at
        FROM (
          SELECT
            id,
            group_id_a,
            group_id_b,
            verdict,
            created_at,
            ROW_NUMBER() OVER (
              PARTITION BY group_id_a, group_id_b
              ORDER BY created_at DESC, id DESC
            ) AS active_rank
          FROM merge_decisions
        )
        WHERE active_rank = 1
      `,
    );
  }

  return { correctionRows, mergeRows };
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
  const snapshotParam = String(url.searchParams.get("snapshot") || "").toLowerCase();
  const stableSnapshot = FRESH_PARAM_VALUES.has(snapshotParam);
  const bypassEdgeCache = forceFresh || stableSnapshot;
  let dataVersion;
  try {
    dataVersion = await loadCommunityDataVersion(request, env);
  } catch (error) {
    logDatabaseError("/api/review-state", "load community data version", error);
    return jsonResponse(
      { detail: "Verze dat komunity není dočasně dostupná" },
      503,
      { "Cache-Control": "no-store" },
    );
  }
  const key = cacheKeyFor(request, dataVersion);
  const edgeCache =
    typeof caches !== "undefined" && caches.default ? caches.default : null;

  if (!bypassEdgeCache && edgeCache) {
    const cached = await edgeCache.match(key);
    if (cached) {
      return cached;
    }
  }


  let projection;
  try {
    projection = await readProjection(env);
  } catch (error) {
    logDatabaseError("/api/review-state", "load state projection", error);
    return jsonResponse(
      { detail: "Stav komunity není dočasně dostupný" },
      503,
      { "Cache-Control": "no-store" },
    );
  }
  if (
    !forceFresh &&
    projection?.payload_json &&
    Number(projection.computed_revision) === Number(projection.current_revision) &&
    String(projection.data_version || "") === dataVersion
  ) {
    try {
      const projectedPayload = JSON.parse(projection.payload_json);
      if (
        Number(projectedPayload?.reviewStateSchemaVersion) ===
        REVIEW_STATE_SCHEMA_VERSION
      ) {
        const response = jsonResponse(projectedPayload, 200, {
          "Cache-Control": responseCacheControl(stableSnapshot),
          "X-Community-Revision": String(Number(projection.current_revision) || 0),
          "X-Community-Revision-Stable": "1",
          "X-Community-Data-Version": dataVersion,
        });
        if (!bypassEdgeCache && edgeCache) {
          context.waitUntil(edgeCache.put(key, response.clone()));
        }
        return response;
      }
    } catch (error) {
      logDatabaseError("/api/review-state", "parse state projection", error);
    }
  }

  let correctionRows;
  let mergeRows;
  try {
    ({ correctionRows, mergeRows } = await loadReviewRows(env));
  } catch (error) {
    logDatabaseError("/api/review-state", "load review rows", error);
    return jsonResponse(
      { detail: "Stav komunity není dočasně dostupný" },
      503,
      { "Cache-Control": "no-store" },
    );
  }

  let xidGroupMap;
  try {
    xidGroupMap = await loadXidGroupMap(request, env);
  } catch (error) {
    logDatabaseError("/api/review-state", "load photo groups", error);
    return jsonResponse(
      { detail: "Stav komunity není dočasně dostupný" },
      503,
      { "Cache-Control": "no-store" },
    );
  }
  const reviewState = buildReviewState({
    correctionRows,
    mergeRows,
    xidGroupMap,
  });

  const payload = {
    ...reviewState,
    reviewStateSchemaVersion: REVIEW_STATE_SCHEMA_VERSION,
    counts: {
      corrections: reviewState.groupCorrections.length,
      doneGroups: reviewState.doneGroupIds.length,
      pendingCorrections: reviewState.groupCorrections.filter(
        (item) => item?.correction_state === "pending",
      ).length,
      approvedCorrections: reviewState.groupCorrections.filter(
        (item) => item?.correction_state === "approved",
      ).length,
      flaggedGroups: reviewState.groupCorrections.filter(
        (item) => item?.anchor_type === "flag",
      ).length,
      merges: reviewState.mergeDecisions.length,
      knownXids: Object.keys(reviewState.resolvedGroupByXid).length,
    },
  };

  let projectionStayedCurrent = true;
  if (projection) {
    try {
      const updateResult = await env.CORRECTIONS_DB.prepare(
        `
          UPDATE community_state_projection
          SET payload_json = ?, computed_revision = ?, data_version = ?,
              updated_at = datetime('now')
          WHERE id = 1 AND current_revision = ?
        `,
      )
        .bind(
          JSON.stringify(payload),
          Number(projection.current_revision),
          dataVersion,
          Number(projection.current_revision),
        )
        .run();
      projectionStayedCurrent = Number(updateResult?.meta?.changes || 0) === 1;
    } catch (error) {
      projectionStayedCurrent = false;
      logDatabaseError("/api/review-state", "store state projection", error);
    }
  }

  const response = jsonResponse(payload, 200, {
    "Cache-Control": projectionStayedCurrent
      ? responseCacheControl(bypassEdgeCache)
      : "no-store",
    "X-Community-Revision": String(Number(projection?.current_revision) || 0),
    "X-Community-Revision-Stable": projectionStayedCurrent ? "1" : "0",
    "X-Community-Data-Version": dataVersion,
  });

  if (!bypassEdgeCache && edgeCache && projectionStayedCurrent) {
    context.waitUntil(edgeCache.put(key, response.clone()));
  }

  return response;
}
