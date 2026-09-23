(() => {
  const DEFAULT_COORDINATE_NEIGHBORS = 8;
  const assetPromises = new Map();
  let candidateCache = null;
  let cachedAssetVersion = "";

  function normalizeId(value) {
    return String(value || "").trim();
  }

  function canonicalPair(a, b) {
    if (!a || !b || a === b) return "";
    return a < b ? `${a}::${b}` : `${b}::${a}`;
  }

  function staleCursorError() {
    const error = new Error("Seznam se změnil. Načtěte ho znovu.");
    error.status = 409;
    return error;
  }

  function dataVersionToken(dataVersion) {
    const bytes = new TextEncoder().encode(normalizeId(dataVersion));
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
    const raw = normalizeId(cursor);
    if (!raw || raw === "0") return 0;
    const match = /^v([A-Za-z0-9_-]+):r(\d+):(\d+)$/u.exec(raw);
    if (
      !match ||
      match[1] !== dataVersionToken(dataVersion) ||
      Number(match[2]) !== (Number(revision) || 0)
    ) {
      throw staleCursorError();
    }
    return Number(match[3]) || 0;
  }

  function pageFor(items, cursor, limit, revision, dataVersion) {
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

  async function loadAsset(path, fallback) {
    if (!assetPromises.has(path)) {
      assetPromises.set(path, (async () => {
        const response = await fetch(path);
        if (!response.ok) {
          if (response.status === 404) return fallback;
          const error = new Error(`Statická data nejsou dostupná: ${path}`);
          error.status = response.status;
          throw error;
        }
        return response.json();
      })());
    }
    try {
      return await assetPromises.get(path);
    } catch (error) {
      if (assetPromises.get(path)) assetPromises.delete(path);
      throw error;
    }
  }

  async function fetchReviewSnapshot() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch("/api/review-state?snapshot=1");
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(
          payload?.detail || `Požadavek selhal: ${response.status}`,
        );
        error.status = response.status;
        throw error;
      }
      const reviewState = await response.json();
      if (response.headers.get("X-Community-Revision-Stable") !== "1") {
        continue;
      }
      const revision = Number(response.headers.get("X-Community-Revision")) || 0;
      const dataVersion = normalizeId(
        response.headers.get("X-Community-Data-Version"),
      );
      if (!dataVersion) {
        throw new Error("Verze dat komunity není dostupná");
      }
      return { reviewState, revision, dataVersion };
    }
    throw staleCursorError();
  }

  function orphanIdsFrom(payload) {
    const values = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.xids)
        ? payload.xids
        : [];
    return new Set(values.map(normalizeId).filter(Boolean));
  }

  function coordinateKey(group) {
    if (!Number.isFinite(group?.lat) || !Number.isFinite(group?.lon)) return "";
    return `${group.lat.toFixed(6)},${group.lon.toFixed(6)}`;
  }

  function buildVersionClusters(clusters, groupByXid) {
    const fragmentsByGroup = new Map();
    (Array.isArray(clusters) ? clusters : []).forEach((cluster) => {
      const buckets = new Map();
      (Array.isArray(cluster?.xids) ? cluster.xids : []).forEach((value) => {
        const xid = normalizeId(value);
        const groupId = groupByXid.get(xid)?.id;
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

    const byGroup = new Map();
    fragmentsByGroup.forEach((fragments, groupId) => {
      fragments.sort((left, right) => (
        left.sourceSeriesId.localeCompare(right.sourceSeriesId) ||
        left.sourceVersionId.localeCompare(right.sourceVersionId) ||
        String(left.xids[0] || "").localeCompare(String(right.xids[0] || ""))
      ));
      byGroup.set(groupId, fragments.map((fragment, index) => ({
        series_id: groupId,
        version_id: `v${index + 1}`,
        xids: fragment.xids,
        representative_xid: fragment.representative_xid,
        max_distance: fragment.max_distance,
      })));
    });
    return byGroup;
  }

  function buildDuplicateRefs(groups, groupById, similarityPairs, reviewState) {
    const grouping = window.OldPragueGrouping;
    const resolveGroup = (value) => grouping.resolveReviewGroupId(
      value,
      reviewState?.groupRoots,
    );
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

    const refs = [];
    const knownKeys = new Set();
    const add = (groupAId, groupBId, source) => {
      if (!groupAId || !groupBId) return;
      const key = canonicalPair(groupAId, groupBId);
      if (!key || decidedPairs.has(key) || knownKeys.has(key)) return;
      knownKeys.add(key);
      refs.push({ key, source, groupAId, groupBId });
    };

    (Array.isArray(similarityPairs) ? similarityPairs : []).forEach((item) => {
      const rawA = normalizeId(item?.group_id_a);
      const rawB = normalizeId(item?.group_id_b);
      const resolvedA = resolveGroup(
        reviewState?.resolvedGroupByXid?.[normalizeId(item?.xid_a)] || rawA,
      );
      const resolvedB = resolveGroup(
        reviewState?.resolvedGroupByXid?.[normalizeId(item?.xid_b)] || rawB,
      );
      if (!groupById.has(resolvedA) || !groupById.has(resolvedB)) return;
      add(resolvedA, resolvedB, "similarity");
    });

    const groupsByCoordinate = new Map();
    groups.forEach((group) => {
      const key = coordinateKey(group);
      if (!key) return;
      if (!groupsByCoordinate.has(key)) groupsByCoordinate.set(key, []);
      groupsByCoordinate.get(key).push(group);
    });
    groupsByCoordinate.forEach((coordinateGroups) => {
      if (coordinateGroups.length < 2) return;
      coordinateGroups.sort((left, right) => left.id.localeCompare(right.id));
      const neighborCount = Math.min(
        Math.max(1, DEFAULT_COORDINATE_NEIGHBORS),
        coordinateGroups.length - 1,
      );
      for (let index = 0; index < coordinateGroups.length; index += 1) {
        for (let distance = 1; distance <= neighborCount; distance += 1) {
          const otherIndex = (index + distance) % coordinateGroups.length;
          add(coordinateGroups[index].id, coordinateGroups[otherIndex].id, "coords");
        }
      }
    });
    return refs;
  }

  async function buildCache(snapshot, flow) {
    const grouping = window.OldPragueGrouping;
    if (!grouping) throw new Error("Chybí pomocník pro skupiny fotografií");
    const [photos, orphanPayload] = await Promise.all([
      loadAsset("/data/photos.geojson", { features: [] }),
      loadAsset("/data/orphan_xids.json", { xids: [] }),
    ]);
    const orphanIds = orphanIdsFrom(orphanPayload);
    const features = (Array.isArray(photos?.features) ? photos.features : [])
      .filter((feature) => !orphanIds.has(normalizeId(feature?.properties?.id)));
    const applied = grouping.applyReviewState(features, snapshot.reviewState);
    const groupIndex = grouping.buildGroups(features);
    const groups = groupIndex.groups.sort((left, right) => left.id.localeCompare(right.id));
    const groupById = new Map(groups.map((group) => [group.id, group]));
    const cache = {
      key: `${snapshot.dataVersion}:${snapshot.revision}`,
      revision: snapshot.revision,
      dataVersion: snapshot.dataVersion,
      reviewState: snapshot.reviewState,
      groups,
      groupById,
      groupByXid: groupIndex.groupByXid,
      locationIds: groups
        .filter((group) => !applied.doneGroupIds.has(group.id))
        .map((group) => group.id),
      groupIds: groups
        .filter((group) => group.items.length > 1)
        .map((group) => group.id),
      duplicateRefs: null,
      versionClustersByGroup: null,
    };

    if (flow === "duplicate") {
      const similarity = await loadAsset("/data/similarity_candidates.json", { pairs: [] });
      cache.duplicateRefs = buildDuplicateRefs(
        groups,
        groupById,
        similarity?.pairs || [],
        snapshot.reviewState,
      );
    }
    if (flow === "group") {
      const clusters = await loadAsset("/data/series_version_clusters.json", { clusters: [] });
      cache.versionClustersByGroup = buildVersionClusters(
        clusters?.clusters || [],
        groupIndex.groupByXid,
      );
    }
    return cache;
  }

  async function cacheFor(snapshot, flow) {
    if (cachedAssetVersion && cachedAssetVersion !== snapshot.dataVersion) {
      assetPromises.clear();
    }
    cachedAssetVersion = snapshot.dataVersion;
    const key = `${snapshot.dataVersion}:${snapshot.revision}`;
    if (!candidateCache || candidateCache.key !== key) {
      candidateCache = await buildCache(snapshot, flow);
      return candidateCache;
    }
    if (flow === "duplicate" && !candidateCache.duplicateRefs) {
      const similarity = await loadAsset("/data/similarity_candidates.json", { pairs: [] });
      candidateCache.duplicateRefs = buildDuplicateRefs(
        candidateCache.groups,
        candidateCache.groupById,
        similarity?.pairs || [],
        candidateCache.reviewState,
      );
    }
    if (flow === "group" && !candidateCache.versionClustersByGroup) {
      const clusters = await loadAsset("/data/series_version_clusters.json", { clusters: [] });
      candidateCache.versionClustersByGroup = buildVersionClusters(
        clusters?.clusters || [],
        candidateCache.groupByXid,
      );
    }
    return candidateCache;
  }

  function focusedIds(ids, cache, focusGroupId, flow) {
    const focus = window.OldPragueGrouping.resolveReviewGroupId(
      focusGroupId,
      cache.reviewState?.groupRoots,
    );
    if (!focus) return ids;
    if (!cache.groupById.has(focus)) {
      const error = new Error("Neznámá skupina");
      error.status = 400;
      throw error;
    }
    if (flow === "duplicate") {
      return ids.filter((item) => item.groupAId === focus || item.groupBId === focus);
    }
    return ids.filter((groupId) => groupId === focus);
  }

  function expandGroup(groupId, cache, includeClusters = false) {
    const group = cache.groupById.get(groupId) || null;
    if (!group || !includeClusters) return group;
    return {
      ...group,
      version_clusters: cache.versionClustersByGroup?.get(groupId) || [],
    };
  }

  async function loadPage({ flow, cursor = "0", limit = 20, focusGroupId = "" } = {}) {
    if (!new Set(["location", "group", "duplicate"]).has(flow)) {
      throw new Error("Neplatný typ kontroly");
    }
    const snapshot = await fetchReviewSnapshot();
    const cache = await cacheFor(snapshot, flow);
    let values;
    if (flow === "location") values = cache.locationIds;
    else if (flow === "group") values = cache.groupIds;
    else values = cache.duplicateRefs;
    values = focusedIds(values, cache, focusGroupId, flow);
    const page = pageFor(values, cursor, limit, cache.revision, cache.dataVersion);
    if (flow === "duplicate") return { flow, ...page };
    return {
      flow,
      ...page,
      items: page.items.map((groupId) => expandGroup(groupId, cache, flow === "group")),
    };
  }

  function expandDuplicatePair(reference) {
    if (!reference || !candidateCache) return null;
    const groupA = candidateCache.groupById.get(reference.groupAId);
    const groupB = candidateCache.groupById.get(reference.groupBId);
    if (!groupA || !groupB) return null;
    return {
      key: reference.key,
      source: reference.source,
      groupA,
      groupB,
    };
  }

  window.OldPragueCandidates = {
    loadPage,
    expandDuplicatePair,
  };
})();
