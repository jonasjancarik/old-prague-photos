import { buildReviewState, loadXidGroupMap } from "./_review_state.js";
import {
  assertSameOrigin,
  buildVoterKey,
  enforceRateLimit,
  hasValidSession,
  toHttpError,
  verifyTurnstileToken,
} from "./_security.js";

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
          user_agent,
          created_at
        FROM merge_decisions
      `,
    ).all();
    mergeRows = mergesResult?.results || [];
  } catch (error) {
    try {
      const mergesResult = await env.CORRECTIONS_DB.prepare(
        `
          SELECT
            id,
            group_id_a,
            group_id_b,
            verdict,
            created_at
          FROM merge_decisions
        `,
      ).all();
      mergeRows = mergesResult?.results || [];
    } catch (innerError) {
      mergeRows = [];
    }
  }

  const xidGroupMap = await loadXidGroupMap(request, env);
  return buildReviewState({
    correctionRows,
    mergeRows,
    xidGroupMap,
  });
}

async function handleGet(request, env) {
  const reviewState = await loadReviewState(request, env);
  const items = reviewState.groupCorrections || [];
  return jsonResponse({ items, count: items.length });
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

  const xidGroupMap = await loadXidGroupMap(request, env);
  const mappedGroupId = xidGroupMap.get(xid) || "";
  if (xidGroupMap.size > 0 && !mappedGroupId) {
    return jsonResponse({ detail: "Neznámé xid" }, 400);
  }
  if (mappedGroupId && groupId && groupId !== mappedGroupId) {
    return jsonResponse({ detail: "Neplatná skupina pro xid" }, 400);
  }
  const canonicalGroupId = mappedGroupId || groupId || xid;

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
        message,
        email,
        user_agent
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).bind(
    xid,
    canonicalGroupId || null,
    hasCoordinates ? Number(lat) : null,
    hasCoordinates ? Number(lon) : null,
    hasCoordinates ? 1 : 0,
    await buildVoterKey(request, env),
    verdict,
    message,
    email || null,
    request.headers.get("User-Agent") || "",
  );

  await statement.run();

  return jsonResponse({ ok: true });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "GET") {
    return handleGet(request, env);
  }

  if (request.method === "POST") {
    return handlePost(request, env);
  }

  return jsonResponse({ detail: "Method Not Allowed" }, 405);
}
