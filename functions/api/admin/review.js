import { buildReviewState } from "../_review_state.js";
import { authorizeAdmin } from "../_admin_auth.js";
import {
  catalogFeature,
  requireCatalog,
} from "../_catalog.js";
import { isMissingColumnError } from "../_db.js";
import { loadOperationalDiagnostics } from "../_operations.js";

const MAX_REVIEW_EVENT_ROWS = 500;
const MAX_SPLIT_CANDIDATES = 10;
const MAX_SPLIT_GROUP_ALIASES = 100;
const MAX_SPLIT_MEMBERS_PER_GROUP = 100;

class ReviewReadLimitError extends Error {
  constructor() {
    super("Fronta kontroly je příliš rozsáhlá pro rychlé načtení. Zúžte ji nebo pokračujte po archivaci událostí.");
    this.name = "ReviewReadLimitError";
  }
}

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

function oldestTimestamp(values) {
  let oldest = null;
  (values || []).forEach((value) => {
    const timestamp = parseEventTime(value);
    if (!timestamp) return;
    if (!oldest || timestamp < oldest.timestamp) {
      oldest = { timestamp, value };
    }
  });
  return oldest?.value || null;
}

function toResolvedCorrectionRows({ correctionRows, xidGroupMap, reviewState }) {
  const out = [];
  const roots = reviewState.groupRoots || {};
  (correctionRows || []).forEach((row) => {
    const xid = normalizeId(row.xid);
    if (!xid) return;
    const mappedGroup = xidGroupMap.get(xid) || "";
    const storedGroup = normalizeId(row.group_id);
    const baseGroup = storedGroup || mappedGroup || xid;
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
  const eventsByPair = new Map();
  (mergeRows || []).forEach((row) => {
    let groupA = normalizeId(row.group_id_a);
    let groupB = normalizeId(row.group_id_b);
    const verdict = normalizeId(row.verdict).toLowerCase();
    if (!groupA || !groupB || groupA === groupB) return;
    if (!["same", "different", "undo"].includes(verdict)) return;
    if (groupA > groupB) {
      [groupA, groupB] = [groupB, groupA];
    }
    const key = canonicalPair(groupA, groupB);
    if (!key) return;
    if (!eventsByPair.has(key)) {
      eventsByPair.set(key, []);
    }
    eventsByPair.get(key).push({
      ...row,
      group_id_a: groupA,
      group_id_b: groupB,
      verdict,
    });
  });

  const conflictPairs = new Set();
  eventsByPair.forEach((events, key) => {
    events.sort((left, right) => {
      const ts = eventTimestamp(left) - eventTimestamp(right);
      if (ts !== 0) return ts;
      const leftId = Number(normalizeId(left.id));
      const rightId = Number(normalizeId(right.id));
      if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
        return leftId - rightId;
      }
      return normalizeId(left.id).localeCompare(normalizeId(right.id));
    });

    const activeVerdicts = new Set();
    events.forEach((item) => {
      if (item.verdict === "undo") {
        activeVerdicts.clear();
        return;
      }
      activeVerdicts.add(item.verdict);
    });

    if (activeVerdicts.has("same") && activeVerdicts.has("different")) {
      conflictPairs.add(key);
    }
  });
  return conflictPairs;
}

function buildSplitCandidates(voteRows, groupRoots) {
  const latestByGroupVoter = new Map();
  (voteRows || []).forEach((row) => {
    const rawGroupId = normalizeId(row.group_id);
    const groupId = normalizeId(groupRoots?.[rawGroupId]) || rawGroupId;
    const verdict = normalizeId(row.verdict).toLowerCase();
    if (!groupId || !["ok", "split", "undo"].includes(verdict)) return;
    const candidate = { ...row, group_id: groupId, verdict };
    const key = `${groupId}::${voterIdentity(candidate)}`;
    const current = latestByGroupVoter.get(key);
    if (!current || eventTimestamp(candidate) >= eventTimestamp(current)) {
      latestByGroupVoter.set(key, candidate);
    }
  });

  const splitVotesByGroup = new Map();
  const voteHistoryByGroup = new Map();
  latestByGroupVoter.forEach((row) => {
    if (!voteHistoryByGroup.has(row.group_id)) {
      voteHistoryByGroup.set(row.group_id, []);
    }
    voteHistoryByGroup.get(row.group_id).push({
      verdict: row.verdict,
      created_at: row.created_at || null,
    });
    if (row.verdict !== "split") return;
    splitVotesByGroup.set(
      row.group_id,
      Number(splitVotesByGroup.get(row.group_id) || 0) + 1,
    );
  });
  return Array.from(splitVotesByGroup.entries())
    .filter(([, splitVotes]) => splitVotes >= 2)
    .map(([groupId, splitVotes]) => ({
      group_id: groupId,
      split_votes: splitVotes,
      required_split_votes: 2,
      vote_history: (voteHistoryByGroup.get(groupId) || [])
        .slice()
        .sort((left, right) => parseEventTime(right.created_at) - parseEventTime(left.created_at)),
    }))
    .sort((left, right) => right.split_votes - left.split_votes);
}

function photoEvidence(feature, xid) {
  const props = feature?.properties || {};
  const coordinates = Array.isArray(feature?.geometry?.coordinates)
    ? feature.geometry.coordinates
    : [];
  const previews = Array.isArray(props.scan_previews) ? props.scan_previews : [];
  return {
    xid,
    description: normalizeId(props.description),
    date_label: normalizeId(props.date_label),
    author: normalizeId(props.author),
    signature: normalizeId(props.signature),
    preview_url: normalizeId(previews[0]),
    lon: toFiniteNumber(coordinates[0]),
    lat: toFiniteNumber(coordinates[1]),
  };
}

function parseMembershipHistory(rows) {
  return (rows || []).map((row) => {
    let xids = [];
    try {
      const parsed = JSON.parse(String(row.assignments_json || "[]"));
      if (Array.isArray(parsed)) {
        xids = parsed.map(normalizeId).filter(Boolean);
      }
    } catch (error) {
      xids = [];
    }
    return {
      id: row.id,
      source_group_id: normalizeId(row.source_group_id),
      target_group_id: normalizeId(row.target_group_id),
      xids,
      reason: normalizeId(row.reason),
      curator: normalizeId(row.curator),
      created_at: row.created_at || null,
    };
  });
}

async function queryRows(env, query, limit = null) {
  const result = await env.CORRECTIONS_DB.prepare(query).all();
  const rows = result?.results || [];
  if (limit !== null && rows.length > limit) throw new ReviewReadLimitError();
  return rows;
}

async function loadMergeRows(env, limit = MAX_REVIEW_EVENT_ROWS) {
  try {
    return await queryRows(
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
        ORDER BY id DESC
        LIMIT ${limit + 1}
      `,
      limit,
    );
  } catch (error) {
    if (!isMissingColumnError(error, ["voter_key", "user_agent"])) {
      throw error;
    }
    return queryRows(
      env,
      `
        SELECT
          id,
          group_id_a,
          group_id_b,
          verdict,
          created_at
        FROM merge_decisions
        ORDER BY id DESC
        LIMIT ${limit + 1}
      `,
      limit,
    );
  }
}

async function loadCatalogGroupsForXids(env, xids) {
  const ids = Array.from(new Set((xids || []).map(normalizeId).filter(Boolean)));
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const result = await env.CORRECTIONS_DB.prepare(
    `SELECT xid, base_group_id FROM catalog_photos WHERE xid IN (${placeholders})`,
  )
    .bind(...ids)
    .all();
  return new Map(
    (result?.results || [])
      .map((row) => [normalizeId(row.xid), normalizeId(row.base_group_id)])
      .filter(([xid, groupId]) => xid && groupId),
  );
}

function aliasesByRoot(groupRoots, candidates) {
  const aliases = new Set();
  const candidateRoots = new Set((candidates || []).map((item) => item.group_id));
  candidateRoots.forEach((groupId) => aliases.add(groupId));
  Object.entries(groupRoots || {}).forEach(([groupId, rootId]) => {
    if (candidateRoots.has(normalizeId(rootId))) aliases.add(normalizeId(groupId));
  });
  return Array.from(aliases).filter(Boolean);
}

async function loadSplitEvidence(env, splitCandidates, groupRoots) {
  if (!splitCandidates.length) return new Map();
  const aliases = aliasesByRoot(groupRoots, splitCandidates);
  if (aliases.length > MAX_SPLIT_GROUP_ALIASES) throw new ReviewReadLimitError();

  const placeholders = aliases.map(() => "?").join(", ");
  const result = await env.CORRECTIONS_DB.prepare(
    `
      SELECT
        photos.xid,
        photos.base_group_id,
        photos.source_lon,
        photos.source_lat,
        photos.feature_json,
        COALESCE(overrides.group_id, photos.base_group_id) AS current_group_id
      FROM catalog_photos AS photos
      LEFT JOIN group_membership_overrides AS overrides
        ON overrides.xid = photos.xid
      WHERE COALESCE(overrides.group_id, photos.base_group_id) IN (${placeholders})
      ORDER BY photos.xid
    `,
  )
    .bind(...aliases)
    .all();

  const membersByGroup = new Map();
  (result?.results || []).forEach((row) => {
    const currentGroup = normalizeId(row.current_group_id);
    const groupId = normalizeId(groupRoots?.[currentGroup]) || currentGroup;
    if (!membersByGroup.has(groupId)) membersByGroup.set(groupId, []);
    membersByGroup.get(groupId).push(photoEvidence(catalogFeature(row), normalizeId(row.xid)));
  });
  membersByGroup.forEach((members) => {
    if (members.length > MAX_SPLIT_MEMBERS_PER_GROUP) throw new ReviewReadLimitError();
  });
  return membersByGroup;
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return jsonResponse({ detail: "Method Not Allowed" }, 405);
  }
  if (!env.CORRECTIONS_DB) {
    return jsonResponse({ detail: "Chybí CORRECTIONS_DB" }, 500);
  }
  const authResponse = await authorizeAdmin(request, env);
  if (authResponse) return authResponse;

  try {
    await requireCatalog(request, env);
  } catch (error) {
    return jsonResponse({ detail: "Katalog fotografií není dočasně dostupný" }, 503);
  }

  let correctionRows;
  let mergeRows;
  let groupReviewVoteRows;
  let membershipRows;
  let operationalDiagnostics;
  let xidGroupMap;
  try {
    [
      correctionRows,
      mergeRows,
      groupReviewVoteRows,
      membershipRows,
      operationalDiagnostics,
    ] = await Promise.all([
      queryRows(
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
              location_revision,
              proposal_id,
              message,
              email,
              user_agent,
              created_at
            FROM corrections
            ORDER BY id DESC
            LIMIT ${MAX_REVIEW_EVENT_ROWS + 1}
        `,
        MAX_REVIEW_EVENT_ROWS,
      ),
      loadMergeRows(env),
      queryRows(
        env,
        `
            SELECT
              votes.source_event_id AS id,
              votes.group_id,
              votes.verdict,
              votes.voter_key,
              votes.created_at
            FROM current_group_review_votes AS votes
            LEFT JOIN group_review_resolutions AS resolutions
              ON resolutions.group_id = votes.group_id
            WHERE votes.source_event_id > COALESCE(resolutions.through_event_id, 0)
            ORDER BY votes.source_event_id DESC
            LIMIT ${MAX_REVIEW_EVENT_ROWS + 1}
        `,
        MAX_REVIEW_EVENT_ROWS,
      ),
      queryRows(
        env,
        `
            SELECT
              id,
              source_group_id,
              target_group_id,
              assignments_json,
              reason,
              curator,
              created_at
            FROM group_membership_events
            ORDER BY id DESC
            LIMIT 100
        `,
      ),
      loadOperationalDiagnostics(request, env),
    ]);
    xidGroupMap = await loadCatalogGroupsForXids(
      env,
      correctionRows
        .filter((row) => !normalizeId(row.group_id))
        .map((row) => row.xid),
    );
  } catch (error) {
    if (error instanceof ReviewReadLimitError) {
      return jsonResponse({ detail: error.message }, 503);
    }
    return jsonResponse({ detail: "Kontrola příspěvků není dočasně dostupná" }, 503);
  }
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
  let splitCandidates = buildSplitCandidates(
    groupReviewVoteRows,
    reviewState.groupRoots,
  );
  if (splitCandidates.length > MAX_SPLIT_CANDIDATES) {
    return jsonResponse({ detail: new ReviewReadLimitError().message }, 503);
  }
  try {
    const evidenceByGroup = await loadSplitEvidence(
      env,
      splitCandidates,
      reviewState.groupRoots,
    );
    splitCandidates = splitCandidates.map((candidate) => {
      const members = evidenceByGroup.get(candidate.group_id) || [];
      return {
        ...candidate,
        xids: members.map((member) => member.xid),
        members,
      };
    });
  } catch (error) {
    if (error instanceof ReviewReadLimitError) {
      return jsonResponse({ detail: error.message }, 503);
    }
    return jsonResponse({ detail: "Důkazy ke kontrole nejsou dočasně dostupné" }, 503);
  }
  const membershipHistory = parseMembershipHistory(membershipRows);

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
        voter_key: normalizeId(item.voter_key),
        user_agent: normalizeId(item.user_agent),
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
      splitCandidates: splitCandidates.length,
      membershipEvents: membershipHistory.length,
    },
    pendingCorrections,
    unresolvedFlags,
    conflictCandidates: [...locationConflicts, ...mergeConflicts],
    splitCandidates,
    membershipHistory,
    recentMerges,
    operations: {
      ...operationalDiagnostics,
      queues: {
        pendingCorrections: pendingCorrections.length,
        unresolvedFlags: unresolvedFlags.length,
        splitCandidates: splitCandidates.length,
        conflicts: locationConflicts.length + mergeConflicts.length,
        oldestPendingAt: oldestTimestamp([
          ...pendingCorrections.map((item) => item.last_event_at || item.received_at),
          ...unresolvedFlags.map((item) => item.last_event_at || item.received_at),
          ...splitCandidates.flatMap((item) =>
            (item.vote_history || []).map((vote) => vote.created_at),
          ),
        ]),
      },
    },
  };

  return jsonResponse(payload);
}
