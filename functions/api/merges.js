import {
  assertSameOrigin,
  buildVoterKey,
  enforceRateLimit,
  hasValidSession,
  toHttpError,
  verifyTurnstileToken,
} from "./_security.js";
import { loadXidGroupMap } from "./_review_state.js";

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
  let result;
  try {
    result = await env.CORRECTIONS_DB.prepare(
      `
        WITH latest AS (
          SELECT group_id_a, group_id_b, MAX(id) AS any_id
          FROM merge_decisions
          GROUP BY group_id_a, group_id_b
        )
        SELECT
          m.group_id_a,
          m.group_id_b,
          m.verdict,
          m.voter_key,
          m.user_agent,
          m.created_at AS received_at
        FROM latest l
        JOIN merge_decisions m ON m.id = l.any_id
        WHERE m.verdict IN ('same', 'different')
      `,
    ).all();
  } catch (error) {
    result = await env.CORRECTIONS_DB.prepare(
      `
        WITH latest AS (
          SELECT group_id_a, group_id_b, MAX(id) AS any_id
          FROM merge_decisions
          GROUP BY group_id_a, group_id_b
        )
        SELECT
          m.group_id_a,
          m.group_id_b,
          m.verdict,
          m.created_at AS received_at
        FROM latest l
        JOIN merge_decisions m ON m.id = l.any_id
        WHERE m.verdict IN ('same', 'different')
      `,
    ).all();
  }

  const items = result?.results || [];
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

  const xidGroupMap = await loadXidGroupMap(request, env);
  if (xidGroupMap.size === 0) {
    return jsonResponse({ detail: "Chybí metadata skupin" }, 500);
  }
  const knownGroupIds = new Set(xidGroupMap.values());
  if (!knownGroupIds.has(groupIdA) || !knownGroupIds.has(groupIdB)) {
    return jsonResponse({ detail: "Neznámá skupina" }, 400);
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

  const voterKey = await buildVoterKey(request, env);
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
      .bind(groupIdA, groupIdB, verdict, voterKey, userAgent)
      .run();
  } catch (error) {
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
  }

  return jsonResponse({ ok: true });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "GET") {
    return handleGet(env);
  }

  if (request.method === "POST") {
    return handlePost(request, env);
  }

  return jsonResponse({ detail: "Method Not Allowed" }, 405);
}
