import { authorizeAdmin } from "../_admin_auth.js";
import { assertSameOrigin, toHttpError } from "../_security.js";
import { logDatabaseError } from "../_db.js";
import { onRequest as reviewStateOnRequest } from "../review-state.js";

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function normalizeId(value) {
  return String(value || "").trim();
}

function validGroupId(value) {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

async function loadAuthoritativeGroupMap(request, env) {
  const url = new URL("/api/review-state?fresh=1", request.url);
  const response = await reviewStateOnRequest({
    request: new Request(url.toString(), {
      method: "GET",
      headers: request.headers,
    }),
    env,
    waitUntil() {},
  });
  if (
    !response.ok ||
    response.headers.get("X-Community-Revision-Stable") !== "1"
  ) {
    throw new Error("Authoritative community groups are changing");
  }
  const payload = await response.json();
  return {
    resolvedGroupMap: new Map(Object.entries(payload?.resolvedGroupByXid || {})),
    groupRoots: payload?.groupRoots || {},
  };
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return jsonResponse({ detail: "Method Not Allowed" }, 405);
  }
  if (!env.CORRECTIONS_DB) {
    return jsonResponse({ detail: "Chybí CORRECTIONS_DB" }, 500);
  }
  const authResponse = await authorizeAdmin(request, env);
  if (authResponse) return authResponse;
  try {
    assertSameOrigin(request, env);
  } catch (error) {
    const httpError = toHttpError(error, 403, "Neplatný původ požadavku");
    return jsonResponse({ detail: httpError.detail }, httpError.status);
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return jsonResponse({ detail: "Neplatný JSON" }, 400);
  }

  const sourceGroupId = normalizeId(body?.source_group_id);
  const requestedTargetGroupId = normalizeId(body?.target_group_id);
  const targetGroupId = requestedTargetGroupId ||
    `series_${crypto.randomUUID().replaceAll("-", "")}`;
  const reason = normalizeId(body?.reason).slice(0, 1000);
  const xids = Array.from(
    new Set(
      (Array.isArray(body?.xids) ? body.xids : [])
        .map(normalizeId)
        .filter(Boolean),
    ),
  );
  if (!validGroupId(sourceGroupId) || !validGroupId(targetGroupId)) {
    return jsonResponse({ detail: "Neplatná skupina" }, 400);
  }
  if (!xids.length) {
    return jsonResponse({ detail: "Vyberte alespoň jednu fotografii" }, 400);
  }

  let authoritativeGroups;
  try {
    authoritativeGroups = await loadAuthoritativeGroupMap(request, env);
  } catch (error) {
    logDatabaseError("/api/admin/group-membership", "load groups", error);
    return jsonResponse({ detail: "Skupiny nejsou dočasně dostupné" }, 503);
  }
  const { resolvedGroupMap, groupRoots } = authoritativeGroups;
  const resolvedSourceGroupId = normalizeId(groupRoots[sourceGroupId]) ||
    sourceGroupId;
  const targetGroupExists =
    Object.prototype.hasOwnProperty.call(groupRoots, targetGroupId) ||
    Array.from(resolvedGroupMap.values()).includes(targetGroupId);
  const resolvedTargetGroupId = targetGroupExists
    ? normalizeId(groupRoots[targetGroupId]) || targetGroupId
    : targetGroupId;
  if (resolvedSourceGroupId === resolvedTargetGroupId) {
    return jsonResponse({ detail: "Cílová skupina musí být jiná" }, 400);
  }
  const sourceMembers = Array.from(resolvedGroupMap.entries())
    .filter(([, groupId]) => groupId === resolvedSourceGroupId)
    .map(([xid]) => xid);
  if (sourceMembers.length === 0) {
    return jsonResponse({ detail: "Zdrojová skupina je prázdná" }, 400);
  }
  if (sourceMembers.length < 2 && !targetGroupExists) {
    return jsonResponse({ detail: "Zdrojovou skupinu nelze rozdělit" }, 400);
  }
  if (xids.some((xid) => resolvedGroupMap.get(xid) !== resolvedSourceGroupId)) {
    return jsonResponse(
      { detail: "Některá fotografie už do zdrojové skupiny nepatří" },
      409,
    );
  }
  if (xids.length >= sourceMembers.length && !targetGroupExists) {
    return jsonResponse({ detail: "Ve zdrojové skupině musí něco zůstat" }, 400);
  }

  const curator = "admin-token";
  const statements = xids.map((xid) =>
    env.CORRECTIONS_DB.prepare(
      `
        INSERT INTO group_membership_overrides (
          xid, group_id, source_group_id, revision, reason, curator, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, datetime('now'))
        ON CONFLICT(xid) DO UPDATE SET
          group_id = excluded.group_id,
          source_group_id = excluded.source_group_id,
          revision = group_membership_overrides.revision + 1,
          reason = excluded.reason,
          curator = excluded.curator,
          updated_at = datetime('now')
      `,
    ).bind(
      xid,
      resolvedTargetGroupId,
      resolvedSourceGroupId,
      reason || null,
      curator,
    ),
  );
  statements.push(
    env.CORRECTIONS_DB.prepare(
      `
        INSERT INTO group_membership_events (
          source_group_id, target_group_id, assignments_json, reason, curator
        ) VALUES (?, ?, ?, ?, ?)
      `,
    ).bind(
      resolvedSourceGroupId,
      resolvedTargetGroupId,
      JSON.stringify(xids),
      reason || null,
      curator,
    ),
  );
  const reviewGroupIds = new Set();
  const addReviewRoot = (rootId) => {
    if (!rootId) return;
    reviewGroupIds.add(rootId);
    Object.entries(groupRoots || {}).forEach(([groupId, currentRootId]) => {
      if (normalizeId(currentRootId) === rootId) reviewGroupIds.add(groupId);
    });
  };
  addReviewRoot(resolvedSourceGroupId);
  if (targetGroupExists) addReviewRoot(resolvedTargetGroupId);
  reviewGroupIds.forEach((reviewGroupId) => {
    statements.push(
      env.CORRECTIONS_DB.prepare(
        `
          INSERT INTO group_review_resolutions (
            group_id, through_event_id, curator, resolved_at
          )
          SELECT ?, COALESCE(MAX(source_event_id), 0), ?, datetime('now')
          FROM current_group_review_votes
          WHERE group_id = ?
          ON CONFLICT(group_id) DO UPDATE SET
            through_event_id = MAX(
              group_review_resolutions.through_event_id,
              excluded.through_event_id
            ),
            curator = excluded.curator,
            resolved_at = excluded.resolved_at
        `,
      ).bind(reviewGroupId, curator, reviewGroupId),
    );
    statements.push(
      env.CORRECTIONS_DB.prepare(
        `
          DELETE FROM current_group_review_votes
          WHERE group_id = ?
            AND source_event_id <= COALESCE(
              (
                SELECT through_event_id
                FROM group_review_resolutions
                WHERE group_id = ?
              ),
              0
            )
        `,
      ).bind(reviewGroupId, reviewGroupId),
    );
  });

  try {
    await env.CORRECTIONS_DB.batch(statements);
  } catch (error) {
    logDatabaseError(
      "/api/admin/group-membership",
      "apply membership split",
      error,
    );
    return jsonResponse({ detail: "Rozdělení se nepodařilo uložit" }, 503);
  }

  return jsonResponse({
    ok: true,
    source_group_id: resolvedSourceGroupId,
    target_group_id: resolvedTargetGroupId,
    moved_xids: xids,
  });
}
