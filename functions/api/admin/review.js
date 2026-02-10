import { buildReviewState, loadXidGroupMap } from "../_review_state.js";

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

function canonicalPair(a, b) {
  if (!a || !b) return "";
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function voterIdentity(row) {
  const voter = normalizeId(row.voter_key);
  if (voter) return voter;
  const id = normalizeId(row.id);
  if (id) return `legacy:${id}`;
  return "legacy:unknown";
}

function eventTimestamp(row) {
  return parseEventTime(row.received_at || row.created_at || "");
}

function toResolvedCorrectionRows({ correctionRows, xidGroupMap, reviewState }) {
  const out = [];
  const roots = reviewState.groupRoots || {};
  (correctionRows || []).forEach((row) => {
    const xid = normalizeId(row.xid);
    if (!xid) return;
    const mappedGroup = xidGroupMap.get(xid) || "";
    const storedGroup = normalizeId(row.group_id);
    const baseGroup = mappedGroup || storedGroup || xid;
    const resolvedGroup = normalizeId(roots[baseGroup]) || baseGroup;
    if (!resolvedGroup) return;

    const lat = toFiniteNumber(row.lat);
    const lon = toFiniteNumber(row.lon);
    const hasCoordinates =
      Number(row.has_coordinates) === 1 && lat !== null && lon !== null;

    out.push({
      id: row.id,
      xid,
      group_id: resolvedGroup,
      verdict: normalizeId(row.verdict).toLowerCase(),
      has_coordinates: hasCoordinates,
      lat,
      lon,
      message: normalizeId(row.message),
      email: normalizeId(row.email),
      voter_key: normalizeId(row.voter_key),
      user_agent: normalizeId(row.user_agent),
      created_at: row.created_at || null,
      received_at: row.received_at || row.created_at || null,
      _event_ts: eventTimestamp(row),
    });
  });

  return out;
}

function buildLocationConflictByGroup(groupCorrections, correctionRowsByGroup) {
  const out = new Map();

  (groupCorrections || []).forEach((item) => {
    if (!item || item.correction_state === "approved") return;
    const groupId = normalizeId(item.group_id);
    if (!groupId || item.anchor_type !== "correction") return;
    const anchorAtTs = parseEventTime(item.anchor_at || "");
    const rows = correctionRowsByGroup.get(groupId) || [];
    const coordToVoters = new Map();
    const uniqueVoters = new Set();

    rows.forEach((row) => {
      if (!row.has_coordinates) return;
      if (row._event_ts < anchorAtTs) return;
      const coordKey = `${Number(row.lat).toFixed(6)},${Number(row.lon).toFixed(6)}`;
      if (!coordToVoters.has(coordKey)) {
        coordToVoters.set(coordKey, new Set());
      }
      const identity = voterIdentity(row);
      coordToVoters.get(coordKey).add(identity);
      uniqueVoters.add(identity);
    });

    const distinctCoords = coordToVoters.size;
    const hasConflict = distinctCoords >= 2 && uniqueVoters.size >= 2;
    out.set(groupId, hasConflict);
  });

  return out;
}

function buildMergeConflictPairs(mergeRows) {
  const verdictsByPair = new Map();
  (mergeRows || []).forEach((row) => {
    let groupA = normalizeId(row.group_id_a);
    let groupB = normalizeId(row.group_id_b);
    const verdict = normalizeId(row.verdict).toLowerCase();
    if (!groupA || !groupB || groupA === groupB) return;
    if (!["same", "different"].includes(verdict)) return;
    if (groupA > groupB) {
      [groupA, groupB] = [groupB, groupA];
    }
    const key = canonicalPair(groupA, groupB);
    if (!key) return;
    if (!verdictsByPair.has(key)) {
      verdictsByPair.set(key, new Set());
    }
    verdictsByPair.get(key).add(verdict);
  });

  const conflictPairs = new Set();
  verdictsByPair.forEach((verdicts, key) => {
    if (verdicts.has("same") && verdicts.has("different")) {
      conflictPairs.add(key);
    }
  });
  return conflictPairs;
}

async function queryRows(env, query) {
  const result = await env.CORRECTIONS_DB.prepare(query).all();
  return result?.results || [];
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return jsonResponse({ detail: "Method Not Allowed" }, 405);
  }
  if (!env.CORRECTIONS_DB) {
    return jsonResponse({ detail: "Chybí CORRECTIONS_DB" }, 500);
  }

  const correctionRows = await queryRows(
    env,
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
        message,
        email,
        user_agent,
        created_at
      FROM corrections
    `,
  );

  const mergeRows = await queryRows(
    env,
    `
      SELECT
        id,
        group_id_a,
        group_id_b,
        verdict,
        created_at
      FROM merge_decisions
    `,
  );

  const xidGroupMap = await loadXidGroupMap(request, env);
  const reviewState = buildReviewState({
    correctionRows,
    mergeRows,
    xidGroupMap,
  });

  const resolvedCorrectionRows = toResolvedCorrectionRows({
    correctionRows,
    xidGroupMap,
    reviewState,
  });

  const correctionRowsByGroup = new Map();
  resolvedCorrectionRows.forEach((row) => {
    if (!correctionRowsByGroup.has(row.group_id)) {
      correctionRowsByGroup.set(row.group_id, []);
    }
    correctionRowsByGroup.get(row.group_id).push(row);
  });

  const locationConflictByGroup = buildLocationConflictByGroup(
    reviewState.groupCorrections,
    correctionRowsByGroup,
  );
  const mergeConflictPairs = buildMergeConflictPairs(mergeRows);

  const pendingCorrections = reviewState.groupCorrections
    .filter((item) => item?.correction_state === "pending" && item?.anchor_type === "correction")
    .map((item) => ({
      ...item,
      location_conflict: Boolean(locationConflictByGroup.get(item.group_id)),
    }));

  const unresolvedFlags = reviewState.groupCorrections
    .filter((item) => item?.anchor_type === "flag" && !item?.done)
    .map((item) => ({
      ...item,
      location_conflict: false,
    }));

  const recentMerges = (mergeRows || [])
    .slice()
    .sort((a, b) => eventTimestamp(b) - eventTimestamp(a))
    .slice(0, 100)
    .map((item) => {
      let groupA = normalizeId(item.group_id_a);
      let groupB = normalizeId(item.group_id_b);
      if (groupA > groupB) {
        [groupA, groupB] = [groupB, groupA];
      }
      const pair = canonicalPair(groupA, groupB);
      return {
        group_id_a: groupA,
        group_id_b: groupB,
        verdict: normalizeId(item.verdict).toLowerCase(),
        received_at: item.created_at || null,
        merge_conflict: Boolean(pair && mergeConflictPairs.has(pair)),
      };
    });

  const locationConflicts = pendingCorrections
    .filter((item) => item.location_conflict)
    .map((item) => ({
      type: "location",
      group_id: item.group_id,
      correction_state: item.correction_state,
      anchor_type: item.anchor_type,
      received_at: item.received_at || null,
    }));

  const mergeConflicts = Array.from(mergeConflictPairs.values()).map((pair) => {
    const [groupA, groupB] = pair.split("::", 2);
    return {
      type: "merge",
      group_id_a: groupA,
      group_id_b: groupB,
    };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    counts: {
      pendingCorrections: pendingCorrections.length,
      unresolvedFlags: unresolvedFlags.length,
      locationConflicts: locationConflicts.length,
      mergeConflicts: mergeConflicts.length,
      recentMerges: recentMerges.length,
    },
    pendingCorrections,
    unresolvedFlags,
    conflictCandidates: [...locationConflicts, ...mergeConflicts],
    recentMerges,
  };

  return jsonResponse(payload);
}
