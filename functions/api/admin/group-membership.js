import { authorizeAdmin } from "../_admin_auth.js";
import { catalogGroupExists, requireCatalog } from "../_catalog.js";
import { logDatabaseError } from "../_db.js";
import { assertSameOrigin, toHttpError } from "../_security.js";
import { onRequest as reviewStateOnRequest } from "../review-state.js";

const PROJECTION_RESERVATION_BASE = -9_000_000_000_000_000;

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

async function loadAuthoritativeGroups(request, env) {
  const url = new URL("/api/review-state?snapshot=1", request.url);
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
    groupRoots: payload?.groupRoots || {},
    revision: Number(response.headers.get("X-Community-Revision")) || 0,
  };
}

function aliasesForRoot(groupRoots, rootId) {
  const root = normalizeId(rootId);
  const aliases = new Set(root ? [root] : []);
  Object.entries(groupRoots || {}).forEach(([groupId, currentRootId]) => {
    if (normalizeId(currentRootId) === root) aliases.add(normalizeId(groupId));
  });
  return Array.from(aliases).filter(Boolean);
}

async function loadSourceMembership(env, sourceAliases, xids) {
  const sourceAliasesJson = JSON.stringify(sourceAliases);
  const [countRow, selectedResult] = await Promise.all([
    env.CORRECTIONS_DB.prepare(
      `
        SELECT COUNT(*) AS member_count
        FROM catalog_photos AS photos
        LEFT JOIN group_membership_overrides AS overrides
          ON overrides.xid = photos.xid
        WHERE COALESCE(overrides.group_id, photos.base_group_id) IN (
          SELECT value FROM json_each(?)
        )
      `,
    )
      .bind(sourceAliasesJson)
      .first(),
    env.CORRECTIONS_DB.prepare(
      `
        SELECT photos.xid
        FROM catalog_photos AS photos
        LEFT JOIN group_membership_overrides AS overrides
          ON overrides.xid = photos.xid
        WHERE photos.xid IN (SELECT value FROM json_each(?))
          AND COALESCE(overrides.group_id, photos.base_group_id) IN (
            SELECT value FROM json_each(?)
          )
      `,
    )
      .bind(JSON.stringify(xids), sourceAliasesJson)
      .all(),
  ]);
  return {
    memberCount: Number(countRow?.member_count) || 0,
    selectedXids: new Set(
      (selectedResult?.results || [])
        .map((row) => normalizeId(row.xid))
        .filter(Boolean),
    ),
  };
}

async function loadProjection(env) {
  const row = await env.CORRECTIONS_DB.prepare(
    `
      SELECT current_revision, computed_revision
      FROM community_state_projection
      WHERE id = 1
    `,
  ).first();
  const currentRevision = Number(row?.current_revision);
  const computedRevision = Number(row?.computed_revision);
  if (
    !Number.isSafeInteger(currentRevision) ||
    currentRevision < 0 ||
    !Number.isSafeInteger(computedRevision)
  ) {
    throw new Error("Community state projection is unavailable");
  }
  return { currentRevision, computedRevision };
}

function projectionReservationMarker(revision) {
  const marker = PROJECTION_RESERVATION_BASE + revision;
  if (!Number.isSafeInteger(marker)) {
    throw new Error("Community revision is outside the supported range");
  }
  return marker;
}

function reserveProjectionStatement(
  env,
  {
    expectedRevision,
    expectedComputedRevision,
    reservationMarker,
    expectedCatalogVersion,
  },
) {
  return env.CORRECTIONS_DB.prepare(
    `
      UPDATE community_state_projection
      SET computed_revision = ?
      WHERE id = 1
        AND current_revision = ?
        AND computed_revision = ?
        AND EXISTS (
          SELECT 1
          FROM catalog_metadata
          WHERE singleton = 1 AND data_version = ?
        )
    `,
  ).bind(
    reservationMarker,
    expectedRevision,
    expectedComputedRevision,
    expectedCatalogVersion,
  );
}

function releaseProjectionStatement(env, computedRevision, reservationMarker) {
  return env.CORRECTIONS_DB.prepare(
    `
      UPDATE community_state_projection
      SET computed_revision = ?
      WHERE id = 1 AND computed_revision = ?
    `,
  ).bind(computedRevision, reservationMarker);
}

function membershipUpsertStatement(
  env,
  {
    xids,
    sourceAliases,
    sourceGroupId,
    targetGroupId,
    reason,
    curator,
    expectedRevision,
    reservationMarker,
    expectedCatalogVersion,
  },
) {
  return env.CORRECTIONS_DB.prepare(
    `
      WITH requested(xid) AS (
        SELECT value FROM json_each(?)
      )
      INSERT INTO group_membership_overrides (
        xid, group_id, source_group_id, revision, reason, curator, updated_at
      )
      SELECT requested.xid, ?, ?, 1, ?, ?, datetime('now')
      FROM requested
      WHERE EXISTS (
        SELECT 1
        FROM community_state_projection
        WHERE id = 1
          AND current_revision = ?
          AND computed_revision = ?
      )
      AND EXISTS (
        SELECT 1
        FROM catalog_metadata
        WHERE singleton = 1 AND data_version = ?
      )
      AND NOT EXISTS (
        SELECT 1
        FROM requested AS candidate
        LEFT JOIN catalog_photos AS photos ON photos.xid = candidate.xid
        LEFT JOIN group_membership_overrides AS overrides
          ON overrides.xid = photos.xid
        WHERE photos.xid IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM json_each(?) AS source_aliases
            WHERE source_aliases.value =
              COALESCE(overrides.group_id, photos.base_group_id)
          )
      )
      ON CONFLICT(xid) DO UPDATE SET
        group_id = excluded.group_id,
        source_group_id = excluded.source_group_id,
        revision = group_membership_overrides.revision + 1,
        reason = excluded.reason,
        curator = excluded.curator,
        updated_at = datetime('now')
    `,
  ).bind(
    JSON.stringify(xids),
    targetGroupId,
    sourceGroupId,
    reason || null,
    curator,
    expectedRevision,
    reservationMarker,
    expectedCatalogVersion,
    JSON.stringify(sourceAliases),
  );
}

function membershipEventStatement(
  env,
  {
    sourceGroupId,
    targetGroupId,
    xids,
    reason,
    curator,
    expectedRevision,
    reservationMarker,
    expectedCatalogVersion,
  },
) {
  return env.CORRECTIONS_DB.prepare(
    `
      INSERT INTO group_membership_events (
        source_group_id, target_group_id, assignments_json, reason, curator
      )
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM community_state_projection
        WHERE id = 1
          AND current_revision = ?
          AND computed_revision = ?
      )
      AND EXISTS (
        SELECT 1
        FROM catalog_metadata
        WHERE singleton = 1 AND data_version = ?
      )
    `,
  ).bind(
    sourceGroupId,
    targetGroupId,
    JSON.stringify(xids),
    reason || null,
    curator,
    expectedRevision,
    reservationMarker,
    expectedCatalogVersion,
  );
}

function reviewResolutionStatement(
  env,
  {
    groupId,
    curator,
    expectedRevision,
    reservationMarker,
    expectedCatalogVersion,
  },
) {
  return env.CORRECTIONS_DB.prepare(
    `
      INSERT INTO group_review_resolutions (
        group_id, through_event_id, curator, resolved_at
      )
      SELECT ?, COALESCE(MAX(source_event_id), 0), ?, datetime('now')
      FROM current_group_review_votes
      WHERE group_id = ?
        AND EXISTS (
          SELECT 1
          FROM community_state_projection
          WHERE id = 1
            AND current_revision = ?
            AND computed_revision = ?
        )
        AND EXISTS (
          SELECT 1
          FROM catalog_metadata
          WHERE singleton = 1 AND data_version = ?
        )
      ON CONFLICT(group_id) DO UPDATE SET
        through_event_id = MAX(
          group_review_resolutions.through_event_id,
          excluded.through_event_id
        ),
        curator = excluded.curator,
        resolved_at = excluded.resolved_at
    `,
  ).bind(
    groupId,
    curator,
    groupId,
    expectedRevision,
    reservationMarker,
    expectedCatalogVersion,
  );
}

function clearResolvedReviewVotesStatement(
  env,
  { groupId, expectedRevision, reservationMarker, expectedCatalogVersion },
) {
  return env.CORRECTIONS_DB.prepare(
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
        AND EXISTS (
          SELECT 1
          FROM community_state_projection
          WHERE id = 1
            AND current_revision = ?
            AND computed_revision = ?
        )
        AND EXISTS (
          SELECT 1
          FROM catalog_metadata
          WHERE singleton = 1 AND data_version = ?
        )
    `,
  ).bind(
    groupId,
    groupId,
    expectedRevision,
    reservationMarker,
    expectedCatalogVersion,
  );
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
  if (xids.length > 100) {
    return jsonResponse({ detail: "Přesuňte nejvýše 100 fotografií najednou." }, 400);
  }

  let catalog;
  let authoritativeGroups;
  let projection;
  try {
    catalog = await requireCatalog(request, env);
    authoritativeGroups = await loadAuthoritativeGroups(request, env);
    projection = await loadProjection(env);
  } catch (error) {
    logDatabaseError("/api/admin/group-membership", "load groups", error);
    return jsonResponse({ detail: "Skupiny nejsou dočasně dostupné" }, 503);
  }

  const { groupRoots, revision } = authoritativeGroups;
  if (projection.currentRevision !== revision) {
    return jsonResponse(
      { detail: "Skupina se mezitím změnila. Načtěte ji znovu." },
      409,
    );
  }
  const resolvedSourceGroupId = normalizeId(groupRoots[sourceGroupId]) ||
    sourceGroupId;
  const sourceAliases = aliasesForRoot(groupRoots, resolvedSourceGroupId);
  let targetGroupExists;
  try {
    targetGroupExists =
      Object.prototype.hasOwnProperty.call(groupRoots, targetGroupId) ||
      await catalogGroupExists(env, targetGroupId);
  } catch (error) {
    logDatabaseError("/api/admin/group-membership", "find target group", error);
    return jsonResponse({ detail: "Skupiny nejsou dočasně dostupné" }, 503);
  }
  const resolvedTargetGroupId = targetGroupExists
    ? normalizeId(groupRoots[targetGroupId]) || targetGroupId
    : targetGroupId;
  if (resolvedSourceGroupId === resolvedTargetGroupId) {
    return jsonResponse({ detail: "Cílová skupina musí být jiná" }, 400);
  }

  let sourceMembership;
  try {
    sourceMembership = await loadSourceMembership(env, sourceAliases, xids);
  } catch (error) {
    logDatabaseError("/api/admin/group-membership", "load source group", error);
    return jsonResponse({ detail: "Skupiny nejsou dočasně dostupné" }, 503);
  }
  if (sourceMembership.memberCount === 0) {
    return jsonResponse({ detail: "Zdrojová skupina je prázdná" }, 400);
  }
  if (sourceMembership.memberCount < 2 && !targetGroupExists) {
    return jsonResponse({ detail: "Zdrojovou skupinu nelze rozdělit" }, 400);
  }
  if (xids.some((xid) => !sourceMembership.selectedXids.has(xid))) {
    return jsonResponse(
      { detail: "Některá fotografie už do zdrojové skupiny nepatří" },
      409,
    );
  }
  if (xids.length >= sourceMembership.memberCount && !targetGroupExists) {
    return jsonResponse({ detail: "Ve zdrojové skupině musí něco zůstat" }, 400);
  }

  const curator = "admin-token";
  const reservationMarker = projectionReservationMarker(revision);
  const expectedRevisionAfterMembership = revision + xids.length;
  const statements = [
    reserveProjectionStatement(env, {
      expectedRevision: revision,
      expectedComputedRevision: projection.computedRevision,
      reservationMarker,
      expectedCatalogVersion: catalog.dataVersion,
    }),
    membershipUpsertStatement(env, {
      xids,
      sourceAliases,
      sourceGroupId: resolvedSourceGroupId,
      targetGroupId: resolvedTargetGroupId,
      reason,
      curator,
      expectedRevision: revision,
      reservationMarker,
      expectedCatalogVersion: catalog.dataVersion,
    }),
    membershipEventStatement(env, {
      sourceGroupId: resolvedSourceGroupId,
      targetGroupId: resolvedTargetGroupId,
      xids,
      reason,
      curator,
      expectedRevision: expectedRevisionAfterMembership,
      reservationMarker,
      expectedCatalogVersion: catalog.dataVersion,
    }),
  ];
  const reviewGroupIds = new Set();
  const addReviewRoot = (rootId) => {
    const root = normalizeId(rootId);
    if (!root) return;
    aliasesForRoot(groupRoots, root).forEach((groupId) => {
      reviewGroupIds.add(groupId);
    });
  };
  addReviewRoot(resolvedSourceGroupId);
  if (targetGroupExists) addReviewRoot(resolvedTargetGroupId);
  reviewGroupIds.forEach((reviewGroupId) => {
    statements.push(
      reviewResolutionStatement(env, {
        groupId: reviewGroupId,
        curator,
        expectedRevision: expectedRevisionAfterMembership,
        reservationMarker,
        expectedCatalogVersion: catalog.dataVersion,
      }),
    );
    statements.push(
      clearResolvedReviewVotesStatement(env, {
        groupId: reviewGroupId,
        expectedRevision: expectedRevisionAfterMembership,
        reservationMarker,
        expectedCatalogVersion: catalog.dataVersion,
      }),
    );
  });
  statements.push(
    releaseProjectionStatement(
      env,
      projection.computedRevision,
      reservationMarker,
    ),
  );

  let results;
  try {
    results = await env.CORRECTIONS_DB.batch(statements);
  } catch (error) {
    logDatabaseError(
      "/api/admin/group-membership",
      "apply membership split",
      error,
    );
    return jsonResponse({ detail: "Rozdělení se nepodařilo uložit" }, 503);
  }
  if (Number(results?.[1]?.meta?.changes || 0) < xids.length) {
    return jsonResponse(
      { detail: "Skupina se mezitím změnila. Načtěte ji znovu." },
      409,
    );
  }

  return jsonResponse({
    ok: true,
    source_group_id: resolvedSourceGroupId,
    target_group_id: resolvedTargetGroupId,
    moved_xids: xids,
  });
}
