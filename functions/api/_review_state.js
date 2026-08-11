const PHOTOS_CACHE_TTL_MS = 60 * 1000;
const REQUIRED_SAME_MERGE_VOTES = 2;
export const REVIEW_STATE_SCHEMA_VERSION = 3;
const SQLITE_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

let xidGroupCache = new Map();
let xidGroupCacheExpiresAt = 0;
let xidGroupCacheAsset = null;
let photoFeatureCache = new Map();
let photoFeatureCacheExpiresAt = 0;
let photoFeatureCacheAsset = null;

function normalizeId(value) {
  return String(value || "").trim();
}

export function buildLocationRevision(groupId, anchorId = null) {
  return JSON.stringify([
    normalizeId(groupId),
    normalizeId(anchorId) || null,
  ]);
}

function parseEventTime(value) {
  const raw = normalizeId(value);
  if (!raw) return 0;

  if (SQLITE_DATETIME_PATTERN.test(raw)) {
    const utc = raw.replace(" ", "T") + "Z";
    const parsed = Date.parse(utc);
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

function canonicalPair(a, b) {
  if (!a || !b) return "";
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function createUnionFind(initialIds) {
  const parent = new Map();

  const add = (id) => {
    if (!id || parent.has(id)) return;
    parent.set(id, id);
  };

  const find = (id) => {
    if (!id) return "";
    if (!parent.has(id)) {
      parent.set(id, id);
      return id;
    }
    const current = parent.get(id);
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };

  const union = (a, b) => {
    if (!a || !b) return;
    const rootA = find(a);
    const rootB = find(b);
    if (!rootA || !rootB || rootA === rootB) return;
    const winner = rootA < rootB ? rootA : rootB;
    const loser = winner === rootA ? rootB : rootA;
    parent.set(loser, winner);
  };

  (initialIds || []).forEach((id) => add(normalizeId(id)));
  return { add, find, union };
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeVerdict(value) {
  return normalizeId(value).toLowerCase();
}

function eventOrderTuple(record) {
  const eventTime = parseEventTime(record.received_at || record.created_at || "");
  const eventId = parseEventId(record.id);
  return {
    time: eventTime,
    numericId: eventId.numeric,
    textId: eventId.text,
  };
}

function compareEvents(left, right) {
  const leftOrder = eventOrderTuple(left);
  const rightOrder = eventOrderTuple(right);

  if (leftOrder.time !== rightOrder.time) {
    return leftOrder.time - rightOrder.time;
  }

  if (leftOrder.numericId !== null && rightOrder.numericId !== null) {
    return leftOrder.numericId - rightOrder.numericId;
  }
  if (leftOrder.numericId !== null && rightOrder.numericId === null) {
    return 1;
  }
  if (leftOrder.numericId === null && rightOrder.numericId !== null) {
    return -1;
  }

  return String(leftOrder.textId || "").localeCompare(
    String(rightOrder.textId || ""),
  );
}

function eventVoterIdentity(row) {
  const voterKey = normalizeId(row.voter_key);
  if (voterKey) return voterKey;
  const id = normalizeId(row.id);
  if (id) return `legacy:${id}`;
  return `legacy:${Number(row?._seq || 0)}`;
}

function isAnchorEvent(row) {
  if (!row) return false;
  if (row.verdict === "flag") return true;
  return row.verdict === "wrong" && row.has_coordinates;
}

function anchorTypeForRow(row) {
  if (!row) return "none";
  if (row.verdict === "flag") return "flag";
  if (row.verdict === "wrong" && row.has_coordinates) return "correction";
  return "none";
}

function okTargetsAnchor(event, groupId, anchor) {
  const submittedRevision = normalizeId(event.location_revision);
  const submittedProposalId = normalizeId(event.proposal_id);
  if (!submittedRevision && !submittedProposalId) {
    return true;
  }

  const anchorId = normalizeId(anchor?.id);
  const expectedProposalId =
    anchorTypeForRow(anchor) === "correction" ? anchorId : "";
  return (
    submittedRevision === buildLocationRevision(groupId, anchorId) &&
    submittedProposalId === expectedProposalId
  );
}

function countOkVotes(
  events,
  startIndex,
  excludedIdentity = "",
  groupId = "",
  anchor = null,
) {
  const unique = new Set();
  for (let i = startIndex; i < events.length; i += 1) {
    const event = events[i];
    if (event.verdict !== "ok") continue;
    if (!okTargetsAnchor(event, groupId, anchor)) continue;
    const identity = eventVoterIdentity(event);
    if (!identity || (excludedIdentity && identity === excludedIdentity)) {
      continue;
    }
    unique.add(identity);
  }
  return unique.size;
}

function latestApprovedCorrection(events, anchorIndices, groupId) {
  let approved = null;
  for (let i = 0; i < anchorIndices.length; i += 1) {
    const anchorIndex = anchorIndices[i];
    const anchor = events[anchorIndex];
    const anchorType = anchorTypeForRow(anchor);
    if (anchorType !== "correction") continue;

    const nextAnchorIndex =
      i + 1 < anchorIndices.length ? anchorIndices[i + 1] : events.length;
    const segment = events.slice(0, nextAnchorIndex);
    const okVotes = countOkVotes(
      segment,
      anchorIndex + 1,
      eventVoterIdentity(anchor),
      groupId,
      anchor,
    );
    if (okVotes >= 1) {
      approved = anchor;
    }
  }
  return approved;
}

function analyzeGroupEvents(events, groupId) {
  const ordered = (events || []).slice().sort(compareEvents);
  if (!ordered.length) {
    return null;
  }

  const latestEvent = ordered[ordered.length - 1];
  const anchorIndices = [];
  for (let i = 0; i < ordered.length; i += 1) {
    if (isAnchorEvent(ordered[i])) {
      anchorIndices.push(i);
    }
  }

  const approvedCorrection = latestApprovedCorrection(
    ordered,
    anchorIndices,
    groupId,
  );
  const latestAnchorIndex =
    anchorIndices.length > 0 ? anchorIndices[anchorIndices.length - 1] : -1;
  const latestAnchor = latestAnchorIndex >= 0 ? ordered[latestAnchorIndex] : null;
  const anchorType = anchorTypeForRow(latestAnchor);
  const requiredOkVotes = anchorType === "correction" ? 1 : 2;
  const okVotes = countOkVotes(
    ordered,
    latestAnchorIndex + 1,
    anchorType === "correction" ? eventVoterIdentity(latestAnchor) : "",
    groupId,
    latestAnchor,
  );
  const done = okVotes >= requiredOkVotes;

  let correctionState = "none";
  if (anchorType === "correction") {
    correctionState = done ? "approved" : "pending";
  } else if (anchorType === "flag") {
    correctionState = "pending";
  }

  const appliedCoords =
    approvedCorrection && approvedCorrection.has_coordinates
      ? approvedCorrection
      : null;
  const proposedCoords =
    anchorType === "correction" && latestAnchor?.has_coordinates
      ? latestAnchor
      : null;

  return {
    latestEvent,
    latestAnchor,
    anchorType,
    correctionState,
    requiredOkVotes,
    okVotes,
    done,
    appliedCoords,
    proposedCoords,
  };
}

function mergeVoterIdentity(row) {
  const voterKey = normalizeId(row.voter_key);
  // Pre-voter-key events cannot prove independence. Treat all legacy events
  // for a pair as one voter so a historical undo still clears that state and
  // repeated legacy rows cannot satisfy consensus by themselves.
  return voterKey || "legacy";
}

function buildMergeDecisions(mergeRows) {
  const latestByPairVoter = new Map();

  (mergeRows || []).forEach((row) => {
    let groupA = normalizeId(row.group_id_a);
    let groupB = normalizeId(row.group_id_b);
    const verdict = normalizeVerdict(row.verdict);

    if (!groupA || !groupB || groupA === groupB) return;
    if (groupA > groupB) {
      [groupA, groupB] = [groupB, groupA];
    }
    if (!["same", "different", "undo"].includes(verdict)) return;

    const candidate = {
      id: row.id,
      group_id_a: groupA,
      group_id_b: groupB,
      verdict,
      voter_key: normalizeId(row.voter_key),
      user_agent: normalizeId(row.user_agent),
      received_at: row.received_at || row.created_at || "",
      created_at: row.created_at || row.received_at || "",
    };

    const pairKey = canonicalPair(groupA, groupB);
    const voterKey = `${pairKey}\u0000${mergeVoterIdentity(candidate)}`;
    const existing = latestByPairVoter.get(voterKey);
    if (!existing || isNewerRecord(candidate, existing)) {
      latestByPairVoter.set(voterKey, candidate);
    }
  });

  const countsByPair = new Map();
  latestByPairVoter.forEach((item) => {
    if (item.verdict !== "same" && item.verdict !== "different") return;
    const pairKey = canonicalPair(item.group_id_a, item.group_id_b);
    if (!countsByPair.has(pairKey)) {
      countsByPair.set(pairKey, {
        group_id_a: item.group_id_a,
        group_id_b: item.group_id_b,
        same_votes: 0,
        different_votes: 0,
        latest_event: item,
      });
    }
    const state = countsByPair.get(pairKey);
    if (item.verdict === "same") state.same_votes += 1;
    else state.different_votes += 1;
    if (isNewerRecord(item, state.latest_event)) state.latest_event = item;
  });

  const decisions = new Map();
  countsByPair.forEach((state, pairKey) => {
    let verdict = "different";
    if (state.same_votes >= REQUIRED_SAME_MERGE_VOTES) {
      verdict = "same";
    } else if (state.same_votes > 0) {
      verdict = "pending";
    }
    decisions.set(pairKey, {
      group_id_a: state.group_id_a,
      group_id_b: state.group_id_b,
      verdict,
      same_votes: state.same_votes,
      different_votes: state.different_votes,
      required_same_votes: REQUIRED_SAME_MERGE_VOTES,
      received_at:
        state.latest_event.received_at || state.latest_event.created_at || "",
    });
  });

  return decisions;
}

function normalizedCorrections(correctionRows, xidGroupMap) {
  const normalized = [];

  (correctionRows || []).forEach((row, index) => {
    const xid = normalizeId(row.xid);
    if (!xid) return;

    const mappedGroup = xidGroupMap.get(xid) || "";
    const storedGroup = normalizeId(row.group_id);
    // Corrections belong to the group recorded when they were submitted. A
    // later curator move of the representative XID must not transfer history.
    const baseGroup = storedGroup || mappedGroup || xid;
    if (!baseGroup) return;

    const lat = toFiniteNumber(row.lat);
    const lon = toFiniteNumber(row.lon);
    const hasCoordinates =
      Number(row.has_coordinates) === 1 && lat !== null && lon !== null;

    normalized.push({
      id: normalizeId(row.id) || `legacy:${index + 1}`,
      xid,
      base_group_id: baseGroup,
      verdict: normalizeVerdict(row.verdict),
      received_at: row.received_at || row.created_at || "",
      created_at: row.created_at || row.received_at || "",
      has_coordinates: hasCoordinates,
      lat,
      lon,
      voter_key: normalizeId(row.voter_key),
      location_revision: normalizeId(row.location_revision),
      proposal_id: normalizeId(row.proposal_id),
      _seq: index + 1,
    });
  });

  return normalized;
}

async function fetchPhotosJson(request, env) {
  if (!request || !env?.ASSETS) {
    throw new Error("Missing ASSETS binding for photo metadata");
  }

  const url = new URL(request.url);
  url.pathname = "/data/photos.geojson";
  url.search = "";

  const response = await env.ASSETS.fetch(new Request(url.toString()));
  if (!response.ok) {
    throw new Error(`Photo metadata request failed: ${response.status}`);
  }
  return response.json();
}

export async function loadPhotoFeatureMap(request, env) {
  const now = Date.now();
  if (env?.ASSETS !== photoFeatureCacheAsset) {
    photoFeatureCache = new Map();
    photoFeatureCacheExpiresAt = 0;
    photoFeatureCacheAsset = env?.ASSETS || null;
  }
  if (now >= photoFeatureCacheExpiresAt) {
    const mapping = new Map();
    try {
      const photos = await fetchPhotosJson(request, env);
      const features = Array.isArray(photos?.features) ? photos.features : [];
      features.forEach((feature) => {
        const xid = normalizeId(feature?.properties?.id);
        if (xid) mapping.set(xid, feature);
      });
      if (mapping.size === 0) {
        throw new Error("Photo metadata contains no known photos");
      }
    } catch (error) {
      if (photoFeatureCache.size > 0) {
        photoFeatureCacheExpiresAt = now + 5_000;
      } else {
        throw error;
      }
    }
    if (mapping.size > 0) {
      photoFeatureCache = mapping;
      photoFeatureCacheExpiresAt = now + PHOTOS_CACHE_TTL_MS;
    }
  }
  return new Map(photoFeatureCache);
}

export async function loadXidGroupMap(request, env) {
  const now = Date.now();
  if (env?.ASSETS !== xidGroupCacheAsset) {
    xidGroupCache = new Map();
    xidGroupCacheExpiresAt = 0;
    xidGroupCacheAsset = env?.ASSETS || null;
  }
  if (now >= xidGroupCacheExpiresAt) {
    const mapping = new Map();
    try {
      const featureMap = await loadPhotoFeatureMap(request, env);
      featureMap.forEach((feature) => {
        const props = feature?.properties || {};
        const xid = normalizeId(props.id);
        const groupId = normalizeId(props.group_id) || xid;
        if (!xid || !groupId) return;
        mapping.set(xid, groupId);
      });
      if (mapping.size === 0) {
        throw new Error("Photo metadata contains no known groups");
      }
    } catch (error) {
      if (xidGroupCache.size > 0) {
        xidGroupCacheExpiresAt = now + 5_000;
      } else {
        throw error;
      }
    }
    if (mapping.size > 0) {
      xidGroupCache = mapping;
      xidGroupCacheExpiresAt = now + PHOTOS_CACHE_TTL_MS;
    }
  }

  const resolved = new Map(xidGroupCache);
  if (!env?.CORRECTIONS_DB) return resolved;
  try {
    const result = await env.CORRECTIONS_DB.prepare(
      `SELECT xid, group_id FROM group_membership_overrides`,
    ).all();
    (result?.results || []).forEach((row) => {
      const xid = normalizeId(row.xid);
      const groupId = normalizeId(row.group_id);
      if (xid && groupId && resolved.has(xid)) resolved.set(xid, groupId);
    });
  } catch (error) {
    if (!/no such table[^]*group_membership_overrides/iu.test(String(error?.message || error))) {
      throw error;
    }
  }
  return resolved;
}

export function buildReviewState({ correctionRows, mergeRows, xidGroupMap }) {
  const xidToGroup = xidGroupMap || new Map();
  const mergeDecisionsByPair = buildMergeDecisions(mergeRows);
  const normalized = normalizedCorrections(correctionRows, xidToGroup);

  const knownGroupIds = new Set();
  xidToGroup.forEach((groupId) => {
    if (groupId) knownGroupIds.add(groupId);
  });
  normalized.forEach((row) => {
    if (row.base_group_id) knownGroupIds.add(row.base_group_id);
  });
  mergeDecisionsByPair.forEach((merge) => {
    knownGroupIds.add(merge.group_id_a);
    knownGroupIds.add(merge.group_id_b);
  });

  const unionFind = createUnionFind(Array.from(knownGroupIds));
  mergeDecisionsByPair.forEach((merge) => {
    if (merge.verdict === "same") {
      unionFind.union(merge.group_id_a, merge.group_id_b);
    }
  });

  const resolvedGroupByXid = {};
  xidToGroup.forEach((groupId, xid) => {
    const root = unionFind.find(groupId) || groupId;
    resolvedGroupByXid[xid] = root;
  });

  const groupRoots = {};
  knownGroupIds.forEach((groupId) => {
    if (!groupId) return;
    groupRoots[groupId] = unionFind.find(groupId) || groupId;
  });

  const eventsByResolvedGroup = new Map();

  normalized.forEach((row) => {
    const resolvedGroup = unionFind.find(row.base_group_id) || row.base_group_id;
    if (!resolvedGroup) return;
    if (!eventsByResolvedGroup.has(resolvedGroup)) {
      eventsByResolvedGroup.set(resolvedGroup, []);
    }
    eventsByResolvedGroup.get(resolvedGroup).push(row);
  });

  const groupCorrections = Array.from(eventsByResolvedGroup.entries())
    .map(([groupId, events]) => {
      const analysis = analyzeGroupEvents(events, groupId);
      if (!analysis) return null;
      const base = analysis.latestEvent;
      const coords = analysis.appliedCoords;
      const proposedCoords = analysis.proposedCoords;
      const anchorId = analysis.latestAnchor
        ? normalizeId(analysis.latestAnchor.id)
        : "";
      return {
        xid: base.xid,
        group_id: groupId,
        verdict: base.verdict || null,
        received_at: base.received_at || null,
        last_event_at: base.received_at || base.created_at || null,
        has_coordinates: Boolean(coords),
        lat: coords ? coords.lat : null,
        lon: coords ? coords.lon : null,
        proposed_has_coordinates: Boolean(proposedCoords),
        proposed_id: proposedCoords ? normalizeId(proposedCoords.id) || null : null,
        proposed_lat: proposedCoords ? proposedCoords.lat : null,
        proposed_lon: proposedCoords ? proposedCoords.lon : null,
        location_revision: buildLocationRevision(groupId, anchorId),
        correction_state: analysis.correctionState,
        ok_votes: analysis.okVotes,
        required_ok_votes: analysis.requiredOkVotes,
        done: analysis.done,
        needs_confirmation: !analysis.done,
        anchor_type: analysis.anchorType,
        anchor_id: anchorId || null,
        anchor_at: analysis.latestAnchor
          ? analysis.latestAnchor.received_at || analysis.latestAnchor.created_at || null
          : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.group_id).localeCompare(String(b.group_id)));

  const doneGroupIds = groupCorrections
    .filter((item) => item.done)
    .map((item) => item.group_id)
    .sort((a, b) => String(a).localeCompare(String(b)));

  const mergeDecisions = Array.from(mergeDecisionsByPair.values())
    .map((item) => ({ ...item, received_at: item.received_at || null }))
    .sort((a, b) => {
      const left = `${a.group_id_a}::${a.group_id_b}`;
      const right = `${b.group_id_a}::${b.group_id_b}`;
      return left.localeCompare(right);
    });

  return {
    groupCorrections,
    doneGroupIds,
    resolvedGroupByXid,
    groupRoots,
    mergeDecisions,
  };
}
