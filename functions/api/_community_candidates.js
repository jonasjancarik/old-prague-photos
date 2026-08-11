import { buildLocationRevision } from "./_review_state.js";

const DEFAULT_COORDINATE_NEIGHBORS = 8;

function normalizeId(value) {
  return String(value || "").trim();
}

function canonicalPair(a, b) {
  if (!a || !b || a === b) return "";
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function finiteCoordinate(value) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compareFeatures(left, right) {
  const leftProps = left?.properties || {};
  const rightProps = right?.properties || {};
  const leftSignature = normalizeId(leftProps.signature);
  const rightSignature = normalizeId(rightProps.signature);
  if (leftSignature || rightSignature) {
    const compared = leftSignature.localeCompare(rightSignature, "cs");
    if (compared !== 0) return compared;
  }
  return normalizeId(leftProps.id).localeCompare(normalizeId(rightProps.id));
}

function correctionByGroup(reviewState) {
  return new Map(
    (Array.isArray(reviewState?.groupCorrections)
      ? reviewState.groupCorrections
      : [])
      .map((item) => [normalizeId(item?.group_id), item])
      .filter(([groupId]) => Boolean(groupId)),
  );
}

export function buildEffectiveGroups({ features, orphanIds, reviewState }) {
  const excludedXids = orphanIds instanceof Set ? orphanIds : new Set(orphanIds || []);
  const resolvedByXid = reviewState?.resolvedGroupByXid || {};
  const corrections = correctionByGroup(reviewState);
  const groupsById = new Map();

  (Array.isArray(features) ? features : []).forEach((sourceFeature) => {
    const sourceProps = sourceFeature?.properties || {};
    const xid = normalizeId(sourceProps.id);
    if (!xid || excludedXids.has(xid)) return;
    const groupId =
      normalizeId(resolvedByXid[xid]) || normalizeId(sourceProps.group_id) || xid;
    if (!groupId) return;

    const correction = corrections.get(groupId) || null;
    const sourceCoordinates = sourceFeature?.geometry?.coordinates;
    let coordinates = Array.isArray(sourceCoordinates)
      ? sourceCoordinates.slice(0, 2)
      : [];
    const originalCoordinates = coordinates.slice();
    const correctedLat = finiteCoordinate(correction?.lat);
    const correctedLon = finiteCoordinate(correction?.lon);
    const proposedLat = finiteCoordinate(correction?.proposed_lat);
    const proposedLon = finiteCoordinate(correction?.proposed_lon);
    const proposedId = normalizeId(correction?.proposed_id);
    if (correctedLat !== null && correctedLon !== null) {
      coordinates = [correctedLon, correctedLat];
    }

    const properties = {
      ...sourceProps,
      original_coordinates: originalCoordinates,
      group_root: groupId,
      correction_state: correction?.correction_state || "none",
      anchor_type: correction?.anchor_type || "none",
      anchor_id: normalizeId(correction?.anchor_id) || null,
      needs_confirmation: Boolean(correction?.needs_confirmation),
      location_revision:
        normalizeId(correction?.location_revision) ||
        buildLocationRevision(groupId, correction?.anchor_id),
      proposed_id: proposedId || null,
      proposed_has_coordinates:
        Boolean(correction?.proposed_has_coordinates) &&
        proposedLat !== null &&
        proposedLon !== null,
      proposed_lat: proposedLat,
      proposed_lon: proposedLon,
    };
    if (correctedLat !== null && correctedLon !== null) {
      properties.corrected = { lat: correctedLat, lon: correctedLon };
    }
    const feature = {
      type: sourceFeature?.type || "Feature",
      geometry: {
        type: sourceFeature?.geometry?.type || "Point",
        coordinates,
      },
      properties,
    };

    if (!groupsById.has(groupId)) {
      groupsById.set(groupId, { id: groupId, items: [] });
    }
    groupsById.get(groupId).items.push(feature);
  });

  return Array.from(groupsById.values())
    .map((group) => {
      group.items.sort(compareFeatures);
      group.primary = group.items[0] || null;
      const coordinates = group.primary?.geometry?.coordinates || [];
      group.lon = finiteCoordinate(coordinates[0]);
      group.lat = finiteCoordinate(coordinates[1]);
      return group;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function remapVersionClusters(clusters, groups) {
  const groupByXid = new Map();
  (groups || []).forEach((group) => {
    (group?.items || []).forEach((feature) => {
      const xid = normalizeId(feature?.properties?.id);
      if (xid) groupByXid.set(xid, group.id);
    });
  });

  const fragmentsByGroup = new Map();
  (Array.isArray(clusters) ? clusters : []).forEach((cluster) => {
    const buckets = new Map();
    (Array.isArray(cluster?.xids) ? cluster.xids : []).forEach((value) => {
      const xid = normalizeId(value);
      const groupId = groupByXid.get(xid);
      if (!xid || !groupId) return;
      if (!buckets.has(groupId)) buckets.set(groupId, []);
      buckets.get(groupId).push(xid);
    });
    buckets.forEach((xids, groupId) => {
      if (!fragmentsByGroup.has(groupId)) fragmentsByGroup.set(groupId, []);
      const normalizedXids = Array.from(new Set(xids)).sort();
      const representative = normalizeId(cluster?.representative_xid);
      fragmentsByGroup.get(groupId).push({
        sourceSeriesId: normalizeId(cluster?.series_id),
        sourceVersionId: normalizeId(cluster?.version_id),
        xids: normalizedXids,
        representative_xid: normalizedXids.includes(representative)
          ? representative
          : normalizedXids[0],
        max_distance: cluster?.max_distance ?? null,
      });
    });
  });

  const remapped = new Map();
  fragmentsByGroup.forEach((fragments, groupId) => {
    fragments.sort((left, right) => (
      left.sourceSeriesId.localeCompare(right.sourceSeriesId) ||
      left.sourceVersionId.localeCompare(right.sourceVersionId) ||
      String(left.xids[0] || "").localeCompare(String(right.xids[0] || ""))
    ));
    remapped.set(
      groupId,
      fragments.map((fragment, index) => ({
        series_id: groupId,
        version_id: `v${index + 1}`,
        xids: fragment.xids,
        representative_xid: fragment.representative_xid,
        max_distance: fragment.max_distance,
      })),
    );
  });
  return remapped;
}

export function buildDuplicateCandidates({
  groups,
  similarityPairs,
  reviewState,
  focusGroupId = "",
  maxCoordinateNeighbors = DEFAULT_COORDINATE_NEIGHBORS,
}) {
  const groupById = new Map((groups || []).map((group) => [group.id, group]));
  const resolvedByXid = reviewState?.resolvedGroupByXid || {};
  const roots = reviewState?.groupRoots || {};
  const resolveGroup = (value) => {
    const id = normalizeId(value);
    return normalizeId(roots[id]) || id;
  };
  const focus = resolveGroup(focusGroupId);
  const decidedPairs = new Set();
  (Array.isArray(reviewState?.mergeDecisions)
    ? reviewState.mergeDecisions
    : []).forEach((item) => {
    const verdict = normalizeId(item?.verdict).toLowerCase();
    if (verdict !== "same" && verdict !== "different") return;
    const key = canonicalPair(
      resolveGroup(item?.group_id_a),
      resolveGroup(item?.group_id_b),
    );
    if (key) decidedPairs.add(key);
  });

  const candidates = [];
  const candidateKeys = new Set();
  const addCandidate = (groupA, groupB, source) => {
    if (!groupA || !groupB) return;
    if (focus && groupA.id !== focus && groupB.id !== focus) return;
    const key = canonicalPair(groupA.id, groupB.id);
    if (!key || decidedPairs.has(key) || candidateKeys.has(key)) return;
    candidateKeys.add(key);
    candidates.push({ key, source, groupA, groupB });
  };

  (Array.isArray(similarityPairs) ? similarityPairs : []).forEach((item) => {
    const rawA = normalizeId(item?.group_id_a);
    const rawB = normalizeId(item?.group_id_b);
    const resolvedA = resolveGroup(
      resolvedByXid[normalizeId(item?.xid_a)] || rawA,
    );
    const resolvedB = resolveGroup(
      resolvedByXid[normalizeId(item?.xid_b)] || rawB,
    );
    addCandidate(groupById.get(resolvedA), groupById.get(resolvedB), "similarity");
  });

  const groupsByCoordinate = new Map();
  (groups || []).forEach((group) => {
    if (group.lat === null || group.lon === null) return;
    const coordinateKey = `${group.lat.toFixed(6)},${group.lon.toFixed(6)}`;
    if (!groupsByCoordinate.has(coordinateKey)) {
      groupsByCoordinate.set(coordinateKey, []);
    }
    groupsByCoordinate.get(coordinateKey).push(group);
  });

  groupsByCoordinate.forEach((coordinateGroups) => {
    if (coordinateGroups.length < 2) return;
    coordinateGroups.sort((left, right) => left.id.localeCompare(right.id));
    const neighborCount = Math.min(
      Math.max(1, Number(maxCoordinateNeighbors) || DEFAULT_COORDINATE_NEIGHBORS),
      coordinateGroups.length - 1,
    );
    for (let index = 0; index < coordinateGroups.length; index += 1) {
      for (let distance = 1; distance <= neighborCount; distance += 1) {
        const otherIndex = (index + distance) % coordinateGroups.length;
        addCandidate(
          coordinateGroups[index],
          coordinateGroups[otherIndex],
          "coords",
        );
      }
    }
  });

  return candidates;
}

export class StaleCandidateCursorError extends Error {
  constructor() {
    super("Candidate cursor belongs to an older community revision");
    this.name = "StaleCandidateCursorError";
    this.status = 409;
  }
}

function dataVersionToken(dataVersion) {
  const bytes = new TextEncoder().encode(String(dataVersion || "").trim());
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "") || "none";
}

function cursorFor(revision, offset, dataVersion) {
  return `v${dataVersionToken(dataVersion)}:r${Number(revision) || 0}:${Math.max(0, offset)}`;
}

function offsetFromCursor(cursor, revision, dataVersion) {
  const raw = String(cursor || "").trim();
  if (!raw || raw === "0") return 0;
  const match = /^v([A-Za-z0-9_-]+):r(\d+):(\d+)$/u.exec(raw);
  if (
    !match ||
    match[1] !== dataVersionToken(dataVersion) ||
    Number(match[2]) !== (Number(revision) || 0)
  ) {
    throw new StaleCandidateCursorError();
  }
  return Number(match[3]) || 0;
}

export function paginateCandidates(
  items,
  cursor,
  limit,
  revision = 0,
  dataVersion = "",
) {
  const offset = offsetFromCursor(cursor, revision, dataVersion);
  const pageSize = Math.min(
    50,
    Math.max(1, Number.parseInt(String(limit || "20"), 10) || 20),
  );
  const values = Array.isArray(items) ? items : [];
  const page = values.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  return {
    items: page,
    total: values.length,
    cursor: cursorFor(revision, offset, dataVersion),
    nextCursor: nextOffset < values.length
      ? cursorFor(revision, nextOffset, dataVersion)
      : null,
    limit: pageSize,
    revision: Number(revision) || 0,
  };
}
