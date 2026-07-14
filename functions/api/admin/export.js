import { authorizeAdmin } from "../_admin_auth.js";
import { loadCommunityDataVersion } from "../_data_version.js";
import { isMissingColumnError, logDatabaseError } from "../_db.js";

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

function parseEventTime(value) {
  const raw = normalizeId(value);
  if (!raw) return 0;
  if (/^\d{4}-\d{2}-\d{2} /.test(raw)) {
    const parsed = Date.parse(raw.replace(" ", "T") + "Z");
    if (Number.isFinite(parsed)) return parsed;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function escapeCsv(value) {
  let text = String(value ?? "");
  if (typeof value === "string" && /^[=+\-@\t\r]/u.test(text)) {
    text = `'${text}`;
  }
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function toCsv(rows, columns) {
  const lines = [];
  lines.push(columns.map((column) => escapeCsv(column)).join(","));
  rows.forEach((row) => {
    lines.push(
      columns.map((column) => escapeCsv(row[column] ?? "")).join(","),
    );
  });
  return lines.join("\n");
}

async function queryRows(env, query, ...args) {
  let statement = env.CORRECTIONS_DB.prepare(query);
  if (args.length) statement = statement.bind(...args);
  const result = await statement.all();
  return result?.results || [];
}

async function loadProjectedGroupState(request, env) {
  const row = await env.CORRECTIONS_DB.prepare(
    `
      SELECT current_revision, computed_revision, data_version, payload_json
      FROM community_state_projection
      WHERE id = 1
    `,
  ).first();
  const current = Number(row?.current_revision);
  const computed = Number(row?.computed_revision);
  const expectedDataVersion = await loadCommunityDataVersion(request, env);
  if (
    !row?.payload_json ||
    current !== computed ||
    String(row?.data_version || "") !== expectedDataVersion
  ) {
    return { items: [], current: false };
  }
  const payload = JSON.parse(row.payload_json);
  return {
    items: Array.isArray(payload?.groupCorrections)
      ? payload.groupCorrections
      : [],
    current: true,
  };
}

function keepAfterSince(rows, sinceTs) {
  if (!sinceTs) return rows.slice();
  return rows.filter((row) => {
    const ts = parseEventTime(row.received_at || row.created_at || "");
    return ts >= sinceTs;
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return jsonResponse({ detail: "Method Not Allowed" }, 405);
  }
  if (!env.CORRECTIONS_DB) {
    return jsonResponse({ detail: "Chybí CORRECTIONS_DB" }, 500);
  }
  const authResponse = authorizeAdmin(request, env);
  if (authResponse) return authResponse;

  const url = new URL(request.url);
  const format = normalizeId(url.searchParams.get("format")).toLowerCase() || "json";
  if (!["json", "csv"].includes(format)) {
    return jsonResponse({ detail: "Neplatný format" }, 400);
  }

  const sinceRaw = normalizeId(url.searchParams.get("since"));
  const sinceTs = sinceRaw ? parseEventTime(sinceRaw) : 0;
  if (sinceRaw && !sinceTs) {
    return jsonResponse({ detail: "Neplatný parametr since" }, 400);
  }

  const limit = Math.min(
    5000,
    Math.max(1, Number.parseInt(normalizeId(url.searchParams.get("limit")) || "500", 10) || 500),
  );
  const sinceSql = sinceTs
    ? new Date(sinceTs)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/u, "")
    : "";

  let correctionRows;
  try {
    correctionRows = await queryRows(env, `
      SELECT
        id,
        xid,
        group_id,
        lat,
        lon,
        has_coordinates,
        voter_key,
        verdict,
        message,
        email,
        user_agent,
        created_at
      FROM corrections
      WHERE (? = '' OR created_at >= ?)
      ORDER BY id DESC
      LIMIT ?
    `, sinceSql, sinceSql, limit);
  } catch (error) {
    logDatabaseError("/api/admin/export", "load corrections", error);
    return jsonResponse({ detail: "Export není dočasně dostupný" }, 503);
  }

  let mergeRows = [];
  try {
    mergeRows = await queryRows(
      env,
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
        WHERE (? = '' OR created_at >= ?)
        ORDER BY id DESC
        LIMIT ?
      `,
      sinceSql,
      sinceSql,
      limit,
    );
  } catch (error) {
    if (!isMissingColumnError(error, ["voter_key", "user_agent"])) {
      logDatabaseError("/api/admin/export", "load merges", error);
      return jsonResponse({ detail: "Export není dočasně dostupný" }, 503);
    }
    mergeRows = await queryRows(
      env,
      `
        SELECT
          id,
          group_id_a,
          group_id_b,
          verdict,
          created_at
        FROM merge_decisions
        WHERE (? = '' OR created_at >= ?)
        ORDER BY id DESC
        LIMIT ?
      `,
      sinceSql,
      sinceSql,
      limit,
    );
  }

  let groupReviewVoteRows;
  try {
    groupReviewVoteRows = await queryRows(env, `
      SELECT
        id,
        group_id,
        verdict,
        voter_key,
        user_agent,
        created_at
      FROM group_review_votes
      WHERE (? = '' OR created_at >= ?)
      ORDER BY id DESC
      LIMIT ?
    `, sinceSql, sinceSql, limit);
  } catch (error) {
    logDatabaseError("/api/admin/export", "load group review votes", error);
    return jsonResponse({ detail: "Export není dočasně dostupný" }, 503);
  }

  let projectedGroupState;
  try {
    projectedGroupState = await loadProjectedGroupState(request, env);
  } catch (error) {
    logDatabaseError("/api/admin/export", "load group state projection", error);
    return jsonResponse({ detail: "Export není dočasně dostupný" }, 503);
  }

  const filteredCorrections = keepAfterSince(correctionRows, sinceTs)
    .sort((a, b) => parseEventTime(b.created_at) - parseEventTime(a.created_at))
    .slice(0, limit);

  const filteredMerges = keepAfterSince(mergeRows, sinceTs)
    .sort((a, b) => parseEventTime(b.created_at) - parseEventTime(a.created_at))
    .slice(0, limit);

  const filteredGroupReviewVotes = keepAfterSince(groupReviewVoteRows, sinceTs)
    .sort((a, b) => parseEventTime(b.created_at) - parseEventTime(a.created_at))
    .slice(0, limit);

  if (format === "json") {
    return jsonResponse({
      generatedAt: new Date().toISOString(),
      since: sinceRaw || null,
      limit,
      corrections: filteredCorrections,
      merges: filteredMerges,
      groupReviewVotes: filteredGroupReviewVotes,
      groupState: projectedGroupState.items,
      groupStateCurrent: projectedGroupState.current,
    });
  }

  const exportRows = [];
  filteredCorrections.forEach((row) => {
    exportRows.push({
      record_type: "correction",
      id: row.id || "",
      xid: row.xid || "",
      group_id: row.group_id || "",
      group_id_a: "",
      group_id_b: "",
      verdict: row.verdict || "",
      correction_state: "",
      anchor_type: "",
      ok_votes: "",
      required_ok_votes: "",
      done: "",
      has_coordinates: row.has_coordinates ?? "",
      lat: row.lat ?? "",
      lon: row.lon ?? "",
      message: row.message || "",
      email: row.email || "",
      voter_key: row.voter_key || "",
      user_agent: row.user_agent || "",
      created_at: row.created_at || "",
    });
  });

  filteredMerges.forEach((row) => {
    exportRows.push({
      record_type: "merge",
      id: row.id || "",
      xid: "",
      group_id: "",
      group_id_a: row.group_id_a || "",
      group_id_b: row.group_id_b || "",
      verdict: row.verdict || "",
      correction_state: "",
      anchor_type: "",
      ok_votes: "",
      required_ok_votes: "",
      done: "",
      has_coordinates: "",
      lat: "",
      lon: "",
      message: "",
      email: "",
      voter_key: row.voter_key || "",
      user_agent: row.user_agent || "",
      created_at: row.created_at || "",
    });
  });

  filteredGroupReviewVotes.forEach((row) => {
    exportRows.push({
      record_type: "group_review_vote",
      id: row.id || "",
      xid: "",
      group_id: row.group_id || "",
      group_id_a: "",
      group_id_b: "",
      verdict: row.verdict || "",
      correction_state: "",
      anchor_type: "",
      ok_votes: "",
      required_ok_votes: "",
      done: "",
      has_coordinates: "",
      lat: "",
      lon: "",
      message: "",
      email: "",
      voter_key: row.voter_key || "",
      user_agent: row.user_agent || "",
      created_at: row.created_at || "",
    });
  });

  projectedGroupState.items.forEach((row) => {
    exportRows.push({
      record_type: "group_state",
      id: "",
      xid: row.xid || "",
      group_id: row.group_id || "",
      group_id_a: "",
      group_id_b: "",
      verdict: row.verdict || "",
      correction_state: row.correction_state || "",
      anchor_type: row.anchor_type || "",
      ok_votes: row.ok_votes ?? "",
      required_ok_votes: row.required_ok_votes ?? "",
      done: row.done ? "1" : "0",
      has_coordinates: row.has_coordinates ? "1" : "0",
      lat: row.lat ?? "",
      lon: row.lon ?? "",
      message: "",
      email: "",
      voter_key: "",
      user_agent: "",
      created_at: row.last_event_at || "",
    });
  });

  const columns = [
    "record_type",
    "id",
    "xid",
    "group_id",
    "group_id_a",
    "group_id_b",
    "verdict",
    "correction_state",
    "anchor_type",
    "ok_votes",
    "required_ok_votes",
    "done",
    "has_coordinates",
    "lat",
    "lon",
    "message",
    "email",
    "voter_key",
    "user_agent",
    "created_at",
  ];

  const csv = toCsv(exportRows, columns);
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="community-review-export.csv"`,
    },
  });
}
