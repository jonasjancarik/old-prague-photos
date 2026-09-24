import {
  buildLocationRevision,
} from "./_review_state.js";
import { logDatabaseError } from "./_db.js";
import { findCatalogPhoto } from "./_catalog.js";
import { onRequest as reviewStateOnRequest } from "./review-state.js";
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

async function loadReviewSnapshot(request, env) {
  const url = new URL("/api/review-state?snapshot=1", request.url);
  const response = await reviewStateOnRequest({
    request: new Request(url.toString(), { method: "GET", headers: request.headers }),
    env,
    waitUntil() {},
  });
  if (response.status !== 200 || response.headers.get("X-Community-Revision-Stable") !== "1") {
    throw new Error("Authoritative community state is changing");
  }
  return {
    payload: await response.json(),
    revision: Number(response.headers.get("X-Community-Revision")) || 0,
  };
}

async function handleGet(request, env) {
  try {
    const { payload } = await loadReviewSnapshot(request, env);
    const items = payload.groupCorrections || [];
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
  const submittedCandidateRevision = body?.candidate_revision;
  if (
    !Number.isSafeInteger(submittedCandidateRevision) ||
    submittedCandidateRevision < 0
  ) {
    return jsonResponse({ detail: "Chybí verze prohlížené fotografie" }, 400);
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

  let catalogPhoto;
  try {
    catalogPhoto = await findCatalogPhoto(env, xid);
  } catch (error) {
    logDatabaseError("/api/corrections", "load photo from catalog", error);
    return jsonResponse(
      { detail: "Stav komunity není dočasně dostupný" },
      503,
    );
  }
  const mappedGroupId = String(catalogPhoto?.current_group_id || "").trim();
  if (!mappedGroupId) {
    return jsonResponse({ detail: "Neznámé xid" }, 400);
  }
  let resolvedGroupId = mappedGroupId;
  let reviewState;
  let snapshotRevision;
  try {
    const snapshot = await loadReviewSnapshot(request, env);
    reviewState = snapshot.payload;
    snapshotRevision = snapshot.revision;
    resolvedGroupId =
      String(reviewState.groupRoots?.[mappedGroupId] || "").trim() || mappedGroupId;
  } catch (error) {
    logDatabaseError("/api/corrections", "resolve submitted group", error);
    return jsonResponse(
      { detail: "Stav komunity není dočasně dostupný" },
      503,
    );
  }
  if (submittedCandidateRevision !== snapshotRevision) {
    return jsonResponse(
      { detail: "Skupina se mezitím změnila. Načtěte ji znovu." },
      409,
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
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM community_state_projection
      WHERE id = 1 AND current_revision = ?
        AND EXISTS (
          SELECT 1
          FROM catalog_photos AS p
          LEFT JOIN group_membership_overrides AS o ON o.xid = p.xid
          WHERE p.xid = ?
            AND COALESCE(o.group_id, p.base_group_id) = ?
        )
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
    snapshotRevision,
    xid,
    mappedGroupId,
  );

  let insertResult;
  try {
    insertResult = await statement.run();
  } catch (error) {
    logDatabaseError("/api/corrections", "insert correction", error);
    return jsonResponse({ detail: "Nepodařilo se uložit příspěvek" }, 503);
  }
  if (Number(insertResult?.meta?.changes || 0) < 1) {
    return jsonResponse(
      { detail: "Poloha se mezitím změnila. Načtěte ji znovu." },
      409,
    );
  }

  const response = jsonResponse({
    ok: true,
    accepted_group_id: resolvedGroupId,
    correction_id: String(insertResult.meta.last_row_id),
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
