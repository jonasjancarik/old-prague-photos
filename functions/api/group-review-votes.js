import { loadXidGroupMap } from "./_review_state.js";
import {
  assertSameOrigin,
  buildVoterKey,
  enforceRateLimit,
  hasValidSession,
  toHttpError,
  verifyTurnstileToken,
} from "./_security.js";

const REQUIRED_OK_VOTES = 2;
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

function summarizeVotes(rows, currentVoterKey, knownGroupIds) {
  const latestByGroupVoter = new Map();

  (rows || []).forEach((row) => {
    const groupId = normalizeId(row.group_id);
    const verdict = normalizeVerdict(row.verdict);
    if (!groupId || !knownGroupIds.has(groupId)) return;
    if (!["ok", "undo"].includes(verdict)) return;

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
    if (row.verdict !== "ok") return;
    if (!activeVotesByGroup.has(row.group_id)) {
      activeVotesByGroup.set(row.group_id, []);
    }
    activeVotesByGroup.get(row.group_id).push(row);
  });

  return Array.from(activeVotesByGroup.entries())
    .map(([groupId, votes]) => {
      const okVotes = votes.length;
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
        done: okVotes >= REQUIRED_OK_VOTES,
        current_user_voted: Boolean(currentUserVote),
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
        id,
        group_id,
        verdict,
        voter_key,
        user_agent,
        created_at
      FROM group_review_votes
    `,
  ).all();
  return result?.results || [];
}

async function loadKnownGroupIds(request, env) {
  const xidGroupMap = await loadXidGroupMap(request, env);
  if (xidGroupMap.size === 0) {
    return null;
  }
  return new Set(xidGroupMap.values());
}

async function handleGet(request, env) {
  const knownGroupIds = await loadKnownGroupIds(request, env);
  if (!knownGroupIds) {
    return jsonResponse({ detail: "Chybí metadata skupin" }, 500);
  }

  const rows = await queryRows(env).catch(() => []);
  const currentVoterKey = await buildVoterKey(request, env);
  const items = summarizeVotes(rows, currentVoterKey, knownGroupIds);
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
  if (!["ok", "undo"].includes(verdict)) {
    return jsonResponse({ detail: "Neplatný typ rozhodnutí" }, 400);
  }

  const knownGroupIds = await loadKnownGroupIds(request, env);
  if (!knownGroupIds) {
    return jsonResponse({ detail: "Chybí metadata skupin" }, 500);
  }
  if (!knownGroupIds.has(groupId)) {
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
        groupId,
        verdict,
        await buildVoterKey(request, env),
        request.headers.get("User-Agent") || "",
      )
      .run();
  } catch (error) {
    return jsonResponse({ detail: "Nepodařilo se uložit hlas" }, 500);
  }

  return jsonResponse({ ok: true });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.CORRECTIONS_DB) {
    return jsonResponse({ detail: "Chybí CORRECTIONS_DB" }, 500);
  }

  if (request.method === "GET") {
    return handleGet(request, env);
  }

  if (request.method === "POST") {
    return handlePost(request, env);
  }

  return jsonResponse({ detail: "Method Not Allowed" }, 405);
}
