import {
  buildLocationRevision,
  buildReviewState,
  loadXidGroupMap,
} from "./_review_state.js";
import {
  isMissingColumnError,
  logDatabaseError,
} from "./_db.js";
import {
  assertSameOrigin,
  ensureVoterIdentity,
  enforceRateLimit,
  hasValidSession,
  toHttpError,
  verifyTurnstileToken,
} from "./_security.js";
import { recordOperation } from "./_operations.js";

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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

function confirmationTarget(reviewState, groupId) {
  const correction = (reviewState?.groupCorrections || []).find(
    (item) => String(item?.group_id || "").trim() === groupId,
  );
  return {
    revision:
      String(correction?.location_revision || "").trim() ||
      buildLocationRevision(groupId, correction?.anchor_id),
    proposalId: String(correction?.proposed_id || "").trim(),
  };
}

async function loadReviewState(request, env) {
  const correctionsResult = await env.CORRECTIONS_DB.prepare(
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
  ).all();
  const correctionRows = correctionsResult?.results || [];

  let mergeRows = [];
  try {
    const mergesResult = await env.CORRECTIONS_DB.prepare(
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
    ).all();
    mergeRows = mergesResult?.results || [];
  } catch (error) {
    if (!isMissingColumnError(error, ["voter_key"])) {
      throw error;
    }
    const mergesResult = await env.CORRECTIONS_DB.prepare(
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
    ).all();
    mergeRows = mergesResult?.results || [];
  }

  const xidGroupMap = await loadXidGroupMap(request, env);
  return buildReviewState({
    correctionRows,
    mergeRows,
    xidGroupMap,
  });
}

async function handleGet(request, env) {
  try {
    const reviewState = await loadReviewState(request, env);
    const items = reviewState.groupCorrections || [];
    return jsonResponse({ items, count: items.length });
  } catch (error) {
    logDatabaseError("/api/corrections", "load review state", error);
    return jsonResponse(
      { detail: "Stav komunity není dočasně dostupný" },
      503,
    );
  }
}

async function handlePost(request, env) {
  try {
    assertSameOrigin(request, env);
    await enforceRateLimit({ request, env, bucket: "write" });
  } catch (error) {
    const httpError = toHttpError(error, 400, "Ověření selhalo");
    return jsonResponse(
      { detail: httpError.detail },
      httpError.status,
      httpError.headers,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return jsonResponse({ detail: "Neplatný JSON" }, 400);
  }

  const xid = String(body?.xid || "").trim();
  if (!xid) {
    return jsonResponse({ detail: "Chybí xid" }, 400);
  }

  const groupId = String(body?.group_id || "").trim();
  const lat = body?.lat ?? null;
  const lon = body?.lon ?? null;
  const hasCoordinates = lat !== null && lon !== null;

  const verdictRaw = body?.verdict ? String(body.verdict).trim().toLowerCase() : "";
  let verdict = verdictRaw;
  if (!verdict) {
    verdict = hasCoordinates ? "wrong" : "flag";
  }
  if (!["ok", "wrong", "flag"].includes(verdict)) {
    return jsonResponse({ detail: "Neplatný typ hlášení" }, 400);
  }

  if ((lat === null) !== (lon === null)) {
    return jsonResponse({ detail: "Neplatná poloha" }, 400);
  }

  if (verdict === "ok" && hasCoordinates) {
    return jsonResponse({ detail: "Potvrzení OK nesmí obsahovat polohu" }, 400);
  }

  if (verdict === "wrong" && !hasCoordinates) {
    return jsonResponse({ detail: "Pro opravu je nutná poloha" }, 400);
  }

  if (hasCoordinates) {
    const latNum = Number(lat);
    const lonNum = Number(lon);
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
      return jsonResponse({ detail: "Neplatná poloha" }, 400);
    }
    if (latNum < -90 || latNum > 90 || lonNum < -180 || lonNum > 180) {
      return jsonResponse({ detail: "Neplatná poloha" }, 400);
    }
  }

  const email = String(body?.email || "").trim();
  if (email && !EMAIL_PATTERN.test(email)) {
    return jsonResponse({ detail: "Neplatný e-mail" }, 400);
  }

  const message = String(body?.message || "Nahlášena špatná poloha.").trim();

  const hasSession = await hasValidSession(request, env);
  if (!hasSession) {
    try {
      await verifyTurnstileToken({
        request,
        env,
        token: body?.token,
        expectedAction: "corrections_submit",
      });
    } catch (error) {
      const httpError = toHttpError(error, 400, "Ověření selhalo");
      return jsonResponse(
        { detail: httpError.detail },
        httpError.status,
        httpError.headers,
      );
    }
  }

  let xidGroupMap;
  try {
    xidGroupMap = await loadXidGroupMap(request, env);
  } catch (error) {
    logDatabaseError("/api/corrections", "load photo groups", error);
    return jsonResponse(
      { detail: "Stav komunity není dočasně dostupný" },
      503,
    );
  }
  if (xidGroupMap.size === 0) {
    return jsonResponse({ detail: "Chybí metadata skupin" }, 500);
  }
  const mappedGroupId = xidGroupMap.get(xid) || "";
  if (!mappedGroupId) {
    return jsonResponse({ detail: "Neznámé xid" }, 400);
  }
  let resolvedGroupId = mappedGroupId;
  let reviewState;
  try {
    reviewState = await loadReviewState(request, env);
    resolvedGroupId =
      String(reviewState.resolvedGroupByXid?.[xid] || "").trim() ||
      mappedGroupId;
  } catch (error) {
    logDatabaseError("/api/corrections", "resolve submitted group", error);
    return jsonResponse(
      { detail: "Stav komunity není dočasně dostupný" },
      503,
    );
  }
  if (
    groupId &&
    groupId !== mappedGroupId &&
    groupId !== resolvedGroupId
  ) {
    return jsonResponse({ detail: "Neplatná skupina pro xid" }, 400);
  }
  if (verdict === "ok") {
    const submittedRevision = String(body?.location_revision || "").trim();
    if (!submittedRevision) {
      return jsonResponse({ detail: "Chybí verze potvrzované polohy" }, 400);
    }
    const submittedProposalId = String(body?.proposal_id || "").trim();
    const target = confirmationTarget(reviewState, resolvedGroupId);
    if (
      submittedRevision !== target.revision ||
      submittedProposalId !== target.proposalId
    ) {
      return jsonResponse(
        { detail: "Poloha se mezitím změnila. Načtěte ji znovu." },
        409,
      );
    }
  }
  const canonicalGroupId = mappedGroupId || xid;

  const voterIdentity = await ensureVoterIdentity(request, env);
  const statement = env.CORRECTIONS_DB.prepare(
    `
      INSERT INTO corrections (
        xid,
        group_id,
        lat,
        lon,
        has_coordinates,
        voter_key,
        verdict,
        location_revision,
        proposal_id,
        message,
        email,
        user_agent
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).bind(
    xid,
    canonicalGroupId || null,
    hasCoordinates ? Number(lat) : null,
    hasCoordinates ? Number(lon) : null,
    hasCoordinates ? 1 : 0,
    voterIdentity.voterKey,
    verdict,
    verdict === "ok" ? String(body.location_revision).trim() : null,
    verdict === "ok" ? String(body.proposal_id || "").trim() || null : null,
    message,
    email || null,
    request.headers.get("User-Agent") || "",
  );

  try {
    await statement.run();
  } catch (error) {
    logDatabaseError("/api/corrections", "insert correction", error);
    return jsonResponse({ detail: "Nepodařilo se uložit příspěvek" }, 503);
  }

  const response = jsonResponse({
    ok: true,
    accepted_group_id: resolvedGroupId,
  });
  if (voterIdentity.cookie) {
    response.headers.append("Set-Cookie", voterIdentity.cookie);
  }
  return response;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "GET") {
    return handleGet(request, env);
  }

  if (request.method === "POST") {
    const response = await handlePost(request, env);
    recordOperation(context, {
      metric: "submission",
      flow: "location",
      status: response.status,
    });
    return response;
  }

  return jsonResponse({ detail: "Method Not Allowed" }, 405);
}
