const PHOTOS_CACHE_TTL_MS = 60 * 1000;
const SQLITE_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

let xidGroupCache = new Map();
let xidGroupCacheExpiresAt = 0;

function normalizeId(value) {
  return String(value || "").trim();
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

function buildLatestMerges(mergeRows) {
  const latestByPair = new Map();

  (mergeRows || []).forEach((row) => {
    let groupA = normalizeId(row.group_id_a);
    let groupB = normalizeId(row.group_id_b);
    const verdict = normalizeVerdict(row.verdict);

    if (!groupA || !groupB || groupA === groupB) return;
    if (groupA > groupB) {
      [groupA, groupB] = [groupB, groupA];
    }
    if (!["same", "different"].includes(verdict)) return;

    const candidate = {
      id: row.id,
      group_id_a: groupA,
      group_id_b: groupB,
      verdict,
      received_at: row.received_at || row.created_at || "",
      created_at: row.created_at || row.received_at || "",
    };

    const key = canonicalPair(groupA, groupB);
    const existing = latestByPair.get(key);
    if (!existing || isNewerRecord(candidate, existing)) {
      latestByPair.set(key, candidate);
    }
  });

  return latestByPair;
}

function normalizedCorrections(correctionRows, xidGroupMap) {
  const normalized = [];

  (correctionRows || []).forEach((row) => {
    const xid = normalizeId(row.xid);
    if (!xid) return;

    const mappedGroup = xidGroupMap.get(xid) || "";
    const storedGroup = normalizeId(row.group_id);
    const baseGroup = mappedGroup || storedGroup || xid;
    if (!baseGroup) return;

    const lat = toFiniteNumber(row.lat);
    const lon = toFiniteNumber(row.lon);
    const hasCoordinates =
      Number(row.has_coordinates) === 1 && lat !== null && lon !== null;

    normalized.push({
      id: row.id,
      xid,
      base_group_id: baseGroup,
      verdict: normalizeVerdict(row.verdict),
      received_at: row.received_at || row.created_at || "",
      created_at: row.created_at || row.received_at || "",
      has_coordinates: hasCoordinates,
      lat,
      lon,
    });
  });

  return normalized;
}

async function fetchPhotosJson(request, env) {
  if (!request || !env?.ASSETS) return null;

  const url = new URL(request.url);
  url.pathname = "/data/photos.geojson";
  url.search = "";

  const response = await env.ASSETS.fetch(new Request(url.toString()));
  if (!response.ok) return null;
  return response.json();
}

export async function loadXidGroupMap(request, env) {
  const now = Date.now();
  if (now < xidGroupCacheExpiresAt) {
    return xidGroupCache;
  }

  const mapping = new Map();
  try {
    const photos = await fetchPhotosJson(request, env);
    const features = Array.isArray(photos?.features) ? photos.features : [];
    features.forEach((feature) => {
      const props = feature?.properties || {};
      const xid = normalizeId(props.id);
      const groupId = normalizeId(props.group_id) || xid;
      if (!xid || !groupId) return;
      mapping.set(xid, groupId);
    });
  } catch (error) {
    // Keep empty mapping on read failure; API still works with xid fallback.
  }

  xidGroupCache = mapping;
  xidGroupCacheExpiresAt = now + PHOTOS_CACHE_TTL_MS;
  return xidGroupCache;
}

export function buildReviewState({ correctionRows, mergeRows, xidGroupMap }) {
  const xidToGroup = xidGroupMap || new Map();
  const latestMerges = buildLatestMerges(mergeRows);
  const normalized = normalizedCorrections(correctionRows, xidToGroup);

  const knownGroupIds = new Set();
  xidToGroup.forEach((groupId) => {
    if (groupId) knownGroupIds.add(groupId);
  });
  normalized.forEach((row) => {
    if (row.base_group_id) knownGroupIds.add(row.base_group_id);
  });
  latestMerges.forEach((merge) => {
    knownGroupIds.add(merge.group_id_a);
    knownGroupIds.add(merge.group_id_b);
  });

  const unionFind = createUnionFind(Array.from(knownGroupIds));
  latestMerges.forEach((merge) => {
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

  const latestAnyByResolvedGroup = new Map();
  const latestCoordsByResolvedGroup = new Map();

  normalized.forEach((row) => {
    const resolvedGroup = unionFind.find(row.base_group_id) || row.base_group_id;
    if (!resolvedGroup) return;

    const existingAny = latestAnyByResolvedGroup.get(resolvedGroup);
    if (!existingAny || isNewerRecord(row, existingAny)) {
      latestAnyByResolvedGroup.set(resolvedGroup, row);
    }

    if (row.has_coordinates) {
      const existingCoords = latestCoordsByResolvedGroup.get(resolvedGroup);
      if (!existingCoords || isNewerRecord(row, existingCoords)) {
        latestCoordsByResolvedGroup.set(resolvedGroup, row);
      }
    }
  });

  const groupCorrections = Array.from(latestAnyByResolvedGroup.entries())
    .map(([groupId, base]) => {
      const coords = latestCoordsByResolvedGroup.get(groupId);
      return {
        xid: base.xid,
        group_id: groupId,
        verdict: base.verdict || null,
        received_at: base.received_at || null,
        has_coordinates: Boolean(coords),
        lat: coords ? coords.lat : null,
        lon: coords ? coords.lon : null,
      };
    })
    .sort((a, b) => String(a.group_id).localeCompare(String(b.group_id)));

  const doneGroupIds = groupCorrections
    .filter((item) => item.has_coordinates || item.verdict === "ok")
    .map((item) => item.group_id)
    .sort((a, b) => String(a).localeCompare(String(b)));

  const mergeDecisions = Array.from(latestMerges.values())
    .map((item) => ({
      group_id_a: item.group_id_a,
      group_id_b: item.group_id_b,
      verdict: item.verdict,
      received_at: item.received_at || null,
    }))
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
