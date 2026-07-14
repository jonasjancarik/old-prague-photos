import { logDatabaseError } from "./_db.js";
import { recordOperation } from "./_operations.js";
import { onRequest as reviewStateOnRequest } from "./review-state.js";
import {
  assertSameOrigin,
  buildVoterKey,
  ensureVoterIdentity,
  enforceRateLimit,
  hasValidSession,
  toHttpError,
  verifyTurnstileToken,
} from "./_security.js";

const REQUIRED_OK_VOTES = 2;
const REQUIRED_SPLIT_VOTES = 2;
const SQLITE_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

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

function normalizeVerdict(value) {
  return normalizeId(value).toLowerCase();
}

function parseEventTime(value) {
  const raw = normalizeId(value);
  if (!raw) return 0;

  if (SQLITE_DATETIME_PATTERN.test(raw)) {
    const parsed = Date.parse(raw.replace(" ", "T") + "Z");
    if (Number.isFinite(parsed)) return parsed;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseEventId(value) {
  const raw = normalizeId(value);
  if (!raw) return { numeric: null, text: "" };
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return { numeric, text: "" };
  }
  return { numeric: null, text: raw };
}

function isNewerRecord(candidate, current) {
  const candidateTime = parseEventTime(
    candidate.received_at || candidate.created_at || "",
  );
  const currentTime = parseEventTime(
    current.received_at || current.created_at || "",
  );
  if (candidateTime !== currentTime) {
    return candidateTime > currentTime;
  }

  const candidateId = parseEventId(candidate.id);
  const currentId = parseEventId(current.id);
  if (candidateId.numeric !== null && currentId.numeric !== null) {
    return candidateId.numeric > currentId.numeric;
  }
  if (candidateId.numeric !== null && currentId.numeric === null) {
    return true;
  }
  if (candidateId.numeric === null && currentId.numeric !== null) {
    return false;
  }

  return candidateId.text.localeCompare(currentId.text) > 0;
}

function voterIdentity(row) {
  const voterKey = normalizeId(row.voter_key);
  if (voterKey) return voterKey;
  const id = normalizeId(row.id);
  if (id) return `legacy:${id}`;
  return "legacy:unknown";
}

function summarizeVotes(rows, currentVoterKey, knownGroupIds, groupRoots) {
  const latestByGroupVoter = new Map();

  (rows || []).forEach((row) => {
    const rawGroupId = normalizeId(row.group_id);
    const groupId = normalizeId(groupRoots?.[rawGroupId]) || rawGroupId;
    const verdict = normalizeVerdict(row.verdict);
    if (!groupId || !knownGroupIds.has(groupId)) return;
    if (!["ok", "split", "undo"].includes(verdict)) return;

    const candidate = {
      id: row.id,
      group_id: groupId,
      verdict,
      voter_key: normalizeId(row.voter_key),
      user_agent: normalizeId(row.user_agent),
      received_at: row.received_at || row.created_at || "",
      created_at: row.created_at || row.received_at || "",
    };
    const key = `${groupId}::${voterIdentity(candidate)}`;
    const existing = latestByGroupVoter.get(key);
    if (!existing || isNewerRecord(candidate, existing)) {
      latestByGroupVoter.set(key, candidate);
    }
  });

  const activeVotesByGroup = new Map();
  latestByGroupVoter.forEach((row) => {
    if (row.verdict === "undo") return;
    if (!activeVotesByGroup.has(row.group_id)) {
      activeVotesByGroup.set(row.group_id, []);
    }
    activeVotesByGroup.get(row.group_id).push(row);
  });

  return Array.from(activeVotesByGroup.entries())
    .map(([groupId, votes]) => {
      const okVotes = votes.filter((row) => row.verdict === "ok").length;
      const splitVotes = votes.filter((row) => row.verdict === "split").length;
      const currentUserVote = currentVoterKey
        ? votes.find((row) => row.voter_key === currentVoterKey) || null
        : null;
      const lastVoteAt = votes.reduce((latest, row) => {
        const candidate = row.received_at || row.created_at || "";
        return parseEventTime(candidate) > parseEventTime(latest) ? candidate : latest;
      }, "");
      return {
        group_id: groupId,
        ok_votes: okVotes,
        required_ok_votes: REQUIRED_OK_VOTES,
        split_votes: splitVotes,
        required_split_votes: REQUIRED_SPLIT_VOTES,
        done: okVotes >= REQUIRED_OK_VOTES && splitVotes === 0,
        needs_split: splitVotes >= REQUIRED_SPLIT_VOTES,
        current_user_voted: Boolean(currentUserVote),
        current_user_verdict: currentUserVote?.verdict || null,
        current_user_vote_at:
          currentUserVote?.received_at || currentUserVote?.created_at || null,
        last_vote_at: lastVoteAt || null,
      };
    })
    .sort((a, b) => String(a.group_id).localeCompare(String(b.group_id)));
}

async function queryRows(env) {
  const result = await env.CORRECTIONS_DB.prepare(
    `
      SELECT
        votes.source_event_id AS id,
        votes.group_id,
        votes.verdict,
        votes.voter_key,
        votes.user_agent,
        votes.created_at
      FROM current_group_review_votes AS votes
      LEFT JOIN group_review_resolutions AS resolutions
        ON resolutions.group_id = votes.group_id
      WHERE votes.source_event_id > COALESCE(resolutions.through_event_id, 0)
    `,
  ).all();
  return result?.results || [];
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
  const knownGroupIds = new Set(
    Object.values(payload?.resolvedGroupByXid || {})
      .map((groupId) => normalizeId(groupRoots[groupId]) || normalizeId(groupId))
      .filter(Boolean),
  );
  if (knownGroupIds.size === 0) return null;
  return { knownGroupIds, groupRoots };
}

async function handleGet(request, env) {
  const authoritativeGroups = await loadAuthoritativeGroups(request, env);
  if (!authoritativeGroups) {
    return jsonResponse({ detail: "Chybí metadata skupin" }, 500);
  }

  const [rows, currentVoterKey] = await Promise.all([
    queryRows(env),
    buildVoterKey(request, env),
  ]);
  const items = summarizeVotes(
    rows,
    currentVoterKey,
    authoritativeGroups.knownGroupIds,
    authoritativeGroups.groupRoots,
  );
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

  const groupId = normalizeId(body?.group_id);
  if (!groupId) {
    return jsonResponse({ detail: "Chybí skupina" }, 400);
  }

  let verdict = normalizeVerdict(body?.verdict);
  if (!verdict) verdict = "ok";
  if (!["ok", "split", "undo"].includes(verdict)) {
    return jsonResponse({ detail: "Neplatný typ rozhodnutí" }, 400);
  }

  let authoritativeGroups;
  try {
    authoritativeGroups = await loadAuthoritativeGroups(request, env);
  } catch (error) {
    logDatabaseError(
      "/api/group-review-votes",
      "load photo groups",
      error,
    );
    return jsonResponse(
      { detail: "Stav komunity není dočasně dostupný" },
      503,
    );
  }
  if (!authoritativeGroups) {
    return jsonResponse({ detail: "Chybí metadata skupin" }, 500);
  }
  const resolvedGroupId =
    normalizeId(authoritativeGroups.groupRoots[groupId]) || groupId;
  if (!authoritativeGroups.knownGroupIds.has(resolvedGroupId)) {
    return jsonResponse({ detail: "Neznámá skupina" }, 400);
  }

  const hasSession = await hasValidSession(request, env);
  if (!hasSession) {
    try {
      await verifyTurnstileToken({
        request,
        env,
        token: body?.token,
        expectedAction: "group_review_submit",
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

  const voterIdentity = await ensureVoterIdentity(request, env);
  try {
    await env.CORRECTIONS_DB.prepare(
      `
        INSERT INTO group_review_votes (
          group_id,
          verdict,
          voter_key,
          user_agent
        )
        VALUES (?, ?, ?, ?)
      `,
    )
      .bind(
        resolvedGroupId,
        verdict,
        voterIdentity.voterKey,
        request.headers.get("User-Agent") || "",
      )
      .run();
  } catch (error) {
    logDatabaseError(
      "/api/group-review-votes",
      "insert group review vote",
      error,
    );
    return jsonResponse({ detail: "Nepodařilo se uložit hlas" }, 503);
  }

  const response = jsonResponse({
    ok: true,
    decision: { group_id: resolvedGroupId, verdict },
  });
  if (voterIdentity.cookie) {
    response.headers.append("Set-Cookie", voterIdentity.cookie);
  }
  return response;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.CORRECTIONS_DB) {
    return jsonResponse({ detail: "Chybí CORRECTIONS_DB" }, 500);
  }

  if (request.method === "GET") {
    try {
      return await handleGet(request, env);
    } catch (error) {
      logDatabaseError(
        "/api/group-review-votes",
        "load group review votes",
        error,
      );
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
      flow: "group",
      status: response.status,
    });
    return response;
  }

  return jsonResponse({ detail: "Method Not Allowed" }, 405);
}
