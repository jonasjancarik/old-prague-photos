import {
  assertSameOrigin,
  ensureVoterIdentity,
  enforceRateLimit,
  hasValidSession,
  toHttpError,
  verifyTurnstileToken,
} from "./_security.js";
import { onRequest as reviewStateOnRequest } from "./review-state.js";
import {
  isMissingColumnError,
  logDatabaseError,
} from "./_db.js";
import { recordOperation } from "./_operations.js";

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

function canonicalPair(groupIdA, groupIdB) {
  return groupIdA < groupIdB
    ? `${groupIdA}::${groupIdB}`
    : `${groupIdB}::${groupIdA}`;
}

async function handleGet(request, env) {
  const { payload } = await loadAuthoritativeReviewState(request, env);
  const items = Array.isArray(payload?.mergeDecisions)
    ? payload.mergeDecisions
    : [];
  return jsonResponse({ items, count: items.length });
}

async function loadAuthoritativeReviewState(request, env) {
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
  return {
    payload: await response.json(),
    revision: Number(response.headers.get("X-Community-Revision")) || 0,
  };
}

async function loadAuthoritativeGroups(request, env) {
  const { payload, revision } = await loadAuthoritativeReviewState(request, env);
  const groupRoots = payload?.groupRoots || {};
  const knownGroupIds = new Set([
    ...Object.keys(groupRoots),
    ...Object.values(groupRoots),
    ...Object.values(payload?.resolvedGroupByXid || {}),
  ].map((value) => String(value || "").trim()).filter(Boolean));
  if (knownGroupIds.size === 0) return null;
  return {
    revision,
    groupRoots,
    knownGroupIds,
    mergeDecisions: Array.isArray(payload?.mergeDecisions)
      ? payload.mergeDecisions
      : [],
  };
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

  let groupIdA = String(body?.group_id_a || "").trim();
  let groupIdB = String(body?.group_id_b || "").trim();
  if (!groupIdA || !groupIdB) {
    return jsonResponse({ detail: "Chybí skupina" }, 400);
  }
  if (groupIdA === groupIdB) {
    return jsonResponse({ detail: "Nelze sloučit stejnou skupinu" }, 400);
  }

  let verdict = String(body?.verdict || "").trim().toLowerCase();
  if (!verdict) verdict = "same";
  if (!["same", "different", "undo"].includes(verdict)) {
    return jsonResponse({ detail: "Neplatný typ rozhodnutí" }, 400);
  }
  const submittedCandidateRevision = body?.candidate_revision;
  if (
    verdict !== "undo" &&
    (!Number.isSafeInteger(submittedCandidateRevision) ||
      submittedCandidateRevision < 0)
  ) {
    return jsonResponse({ detail: "Chybí verze porovnávané dvojice" }, 400);
  }

  let authoritativeGroups;
  try {
    authoritativeGroups = await loadAuthoritativeGroups(request, env);
  } catch (error) {
    logDatabaseError("/api/merges", "load photo groups", error);
    return jsonResponse(
      { detail: "Stav komunity není dočasně dostupný" },
      503,
    );
  }
  if (!authoritativeGroups) {
    return jsonResponse({ detail: "Chybí metadata skupin" }, 500);
  }
  if (
    verdict !== "undo" &&
    submittedCandidateRevision !== authoritativeGroups.revision
  ) {
    return jsonResponse(
      { detail: "Dvojice se mezitím změnila. Načtěte ji znovu." },
      409,
    );
  }
  if (
    !authoritativeGroups.knownGroupIds.has(groupIdA) ||
    !authoritativeGroups.knownGroupIds.has(groupIdB)
  ) {
    return jsonResponse({ detail: "Neznámá skupina" }, 400);
  }
  const resolvedGroupIdA = String(
    authoritativeGroups.groupRoots[groupIdA] || groupIdA,
  );
  const resolvedGroupIdB = String(
    authoritativeGroups.groupRoots[groupIdB] || groupIdB,
  );
  if (verdict !== "undo") {
    if (resolvedGroupIdA === resolvedGroupIdB) {
      const submittedPair = canonicalPair(groupIdA, groupIdB);
      const isHistoricalPair = authoritativeGroups.mergeDecisions.some(
        (item) =>
          canonicalPair(
            String(item?.group_id_a || "").trim(),
            String(item?.group_id_b || "").trim(),
          ) === submittedPair,
      );
      if (verdict !== "different" || !isHistoricalPair) {
        return jsonResponse({ detail: "Nelze sloučit stejnou skupinu" }, 400);
      }
    } else {
      groupIdA = resolvedGroupIdA;
      groupIdB = resolvedGroupIdB;
    }
  }

  const hasSession = await hasValidSession(request, env);
  if (!hasSession) {
    try {
      await verifyTurnstileToken({
        request,
        env,
        token: body?.token,
        expectedAction: "merges_submit",
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

  if (groupIdA > groupIdB) {
    [groupIdA, groupIdB] = [groupIdB, groupIdA];
  }

  const voterIdentity = await ensureVoterIdentity(request, env);
  const userAgent = request.headers.get("User-Agent") || "";

  let insertResult;
  try {
    const statement = verdict === "undo"
      ? env.CORRECTIONS_DB.prepare(
          `
            INSERT INTO merge_decisions (
              group_id_a,
              group_id_b,
              verdict,
              voter_key,
              user_agent
            )
            VALUES (?, ?, ?, ?, ?)
          `,
        ).bind(
          groupIdA,
          groupIdB,
          verdict,
          voterIdentity.voterKey,
          userAgent,
        )
      : env.CORRECTIONS_DB.prepare(
          `
            INSERT INTO merge_decisions (
              group_id_a,
              group_id_b,
              verdict,
              voter_key,
              user_agent
            )
            SELECT ?, ?, ?, ?, ?
            FROM community_state_projection
            WHERE id = 1 AND current_revision = ?
          `,
        ).bind(
          groupIdA,
          groupIdB,
          verdict,
          voterIdentity.voterKey,
          userAgent,
          submittedCandidateRevision,
        );
    insertResult = await statement.run();
  } catch (error) {
    if (!isMissingColumnError(error, ["voter_key", "user_agent"])) {
      logDatabaseError("/api/merges", "insert merge decision", error);
      return jsonResponse({ detail: "Nepodařilo se uložit příspěvek" }, 503);
    }
    try {
      const legacyStatement = verdict === "undo"
        ? env.CORRECTIONS_DB.prepare(
            `
              INSERT INTO merge_decisions (
                group_id_a,
                group_id_b,
                verdict
              )
              VALUES (?, ?, ?)
            `,
          ).bind(groupIdA, groupIdB, verdict)
        : env.CORRECTIONS_DB.prepare(
            `
              INSERT INTO merge_decisions (
                group_id_a,
                group_id_b,
                verdict
              )
              SELECT ?, ?, ?
              FROM community_state_projection
              WHERE id = 1 AND current_revision = ?
            `,
          ).bind(
            groupIdA,
            groupIdB,
            verdict,
            submittedCandidateRevision,
          );
      insertResult = await legacyStatement.run();
    } catch (fallbackError) {
      logDatabaseError(
        "/api/merges",
        "insert legacy merge decision",
        fallbackError,
      );
      return jsonResponse({ detail: "Nepodařilo se uložit příspěvek" }, 503);
    }
  }

  if (
    verdict !== "undo" &&
    Number(insertResult?.meta?.changes || 0) !== 1
  ) {
    return jsonResponse(
      { detail: "Dvojice se mezitím změnila. Načtěte ji znovu." },
      409,
    );
  }

  const response = jsonResponse({
    ok: true,
    decision: {
      group_id_a: groupIdA,
      group_id_b: groupIdB,
      verdict,
    },
  });
  if (voterIdentity.cookie) {
    response.headers.append("Set-Cookie", voterIdentity.cookie);
  }
  return response;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "GET") {
    try {
      return await handleGet(request, env);
    } catch (error) {
      logDatabaseError("/api/merges", "load merge decisions", error);
      return jsonResponse(
        { detail: "Stav komunity není dočasně dostupný" },
        503,
      );
    }
  }

  if (request.method === "POST") {
    const response = await handlePost(request, env);
    recordOperation(context, {
      metric: "submission",
      flow: "duplicate",
      status: response.status,
    });
    return response;
  }

  return jsonResponse({ detail: "Method Not Allowed" }, 405);
}
