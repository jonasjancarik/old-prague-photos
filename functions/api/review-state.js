import { buildReviewState, loadXidGroupMap } from "./_review_state.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function queryRows(env, query) {
  const result = await env.CORRECTIONS_DB.prepare(query).all();
  return result?.results || [];
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "GET") {
    return jsonResponse({ detail: "Method Not Allowed" }, 405);
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

  return jsonResponse({
    ...reviewState,
    counts: {
      corrections: reviewState.groupCorrections.length,
      doneGroups: reviewState.doneGroupIds.length,
      merges: reviewState.mergeDecisions.length,
      knownXids: Object.keys(reviewState.resolvedGroupByXid).length,
    },
  });
}
