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

async function handleGet(env) {
  const result = await env.CORRECTIONS_DB.prepare(
    `
      SELECT
        group_id_a,
        group_id_b,
        verdict,
        created_at AS received_at
      FROM current_merge_decisions
      WHERE verdict IN ('same', 'different')
    `,
  ).all();

  const items = result?.results || [];
  return jsonResponse({ items, count: items.length });
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
  const groupRoots = payload?.groupRoots || {};
  const knownGroupIds = new Set([
    ...Object.keys(groupRoots),
    ...Object.values(groupRoots),
    ...Object.values(payload?.resolvedGroupByXid || {}),
  ].map((value) => String(value || "").trim()).filter(Boolean));
  if (knownGroupIds.size === 0) return null;
  return { groupRoots, knownGroupIds };
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
      return jsonResponse({ detail: "Nelze sloučit stejnou skupinu" }, 400);
    }
    groupIdA = resolvedGroupIdA;
    groupIdB = resolvedGroupIdB;
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

  try {
    await env.CORRECTIONS_DB.prepare(
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
    )
      .bind(groupIdA, groupIdB, verdict, voterIdentity.voterKey, userAgent)
      .run();
  } catch (error) {
    if (!isMissingColumnError(error, ["voter_key", "user_agent"])) {
      logDatabaseError("/api/merges", "insert merge decision", error);
      return jsonResponse({ detail: "Nepodařilo se uložit příspěvek" }, 503);
    }
    try {
      await env.CORRECTIONS_DB.prepare(
        `
          INSERT INTO merge_decisions (
            group_id_a,
            group_id_b,
            verdict
          )
          VALUES (?, ?, ?)
        `,
      )
        .bind(groupIdA, groupIdB, verdict)
        .run();
    } catch (fallbackError) {
      logDatabaseError(
        "/api/merges",
        "insert legacy merge decision",
        fallbackError,
      );
      return jsonResponse({ detail: "Nepodařilo se uložit příspěvek" }, 503);
    }
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
      return await handleGet(env);
    } catch (error) {
      logDatabaseError("/api/merges", "load merge decisions", error);
      return jsonResponse(
        { detail: "Stav komunity není dočasně dostupný" },
        503,
      );
    }
  }

  if (request.method === "POST") {
    return handlePost(request, env);
  }

  return jsonResponse({ detail: "Method Not Allowed" }, 405);
}
