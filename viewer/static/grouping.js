(() => {
  const ORIGINAL_COORDINATES_KEY = "__oldPragueOriginalCoordinates";

  function normalizeId(value) {
    const raw = String(value || "").trim();
    return raw || "";
  }

  function getOriginalCoordinates(feature) {
    if (!feature?.geometry) return null;
    const coords = feature.geometry.coordinates;
    if (!Array.isArray(coords)) return null;

    if (!Array.isArray(feature[ORIGINAL_COORDINATES_KEY])) {
      Object.defineProperty(feature, ORIGINAL_COORDINATES_KEY, {
        value: coords.slice(),
        writable: true,
        configurable: true,
      });
    }

    return feature[ORIGINAL_COORDINATES_KEY];
  }

  function restoreOriginalCoordinates(feature) {
    const original = getOriginalCoordinates(feature);
    if (!original || !feature?.geometry) return;
    feature.geometry.coordinates = original.slice();
  }

  function applyCorrectedCoordinates(feature, lat, lon) {
    getOriginalCoordinates(feature);
    feature.geometry.coordinates = [lon, lat];
  }

  function buildGroupIdByXid(features) {
    const map = new Map();
    const groupIds = new Set();

    (features || []).forEach((feature) => {
      const props = feature?.properties || {};
      const xid = normalizeId(props.id);
      const groupId = normalizeId(props.group_id) || xid;
      if (!xid || !groupId) return;
      map.set(xid, groupId);
      groupIds.add(groupId);
    });

    return { map, groupIds };
  }

  function createUnionFind(groupIds) {
    const parent = new Map();
    groupIds.forEach((id) => {
      if (id) parent.set(id, id);
    });

    const find = (id) => {
      if (!id) return "";
      if (!parent.has(id)) parent.set(id, id);
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
      if (rootA === rootB) return;
      const winner = rootA < rootB ? rootA : rootB;
      const loser = winner === rootA ? rootB : rootA;
      parent.set(loser, winner);
    };

    return { find, union };
  }

  function toFiniteCoord(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function buildMergeResolver(groupIds, decisions) {
    const unionFind = createUnionFind(groupIds);
    (decisions || []).forEach((item) => {
      if (!item || item.verdict !== "same") return;
      const a = normalizeId(item.group_id_a);
      const b = normalizeId(item.group_id_b);
      if (!a || !b || a === b) return;
      unionFind.union(a, b);
    });

    return (groupId) => {
      const id = normalizeId(groupId);
      return id ? unionFind.find(id) : "";
    };
  }

  function applyCorrections(features, corrections, groupIdByXid, resolveGroupId) {
    const correctionByGroup = new Map();
    (corrections || []).forEach((item) => {
      if (!item) return;
      const xid = normalizeId(item.xid);
      const baseGroup =
        normalizeId(item.group_id) || groupIdByXid.get(xid) || xid;
      if (!baseGroup) return;
      const groupId = resolveGroupId ? resolveGroupId(baseGroup) : baseGroup;
      correctionByGroup.set(groupId, item);
    });

    (features || []).forEach((feature) => {
      restoreOriginalCoordinates(feature);
      const props = feature?.properties || {};
      const baseGroup = normalizeId(props.group_id) || normalizeId(props.id);
      const groupId = resolveGroupId ? resolveGroupId(baseGroup) : baseGroup;
      if (!groupId || !correctionByGroup.has(groupId)) return;
      const correction = correctionByGroup.get(groupId);
      const lat = Number(correction.lat);
      const lon = Number(correction.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      applyCorrectedCoordinates(feature, lat, lon);
      props.corrected = { lat, lon };
    });

    return correctionByGroup;
  }

  function applyReviewState(features, reviewState) {
    const resolvedByXid = reviewState?.resolvedGroupByXid || {};
    const corrections = Array.isArray(reviewState?.groupCorrections)
      ? reviewState.groupCorrections
      : [];
    const correctionByGroup = new Map();

    corrections.forEach((item) => {
      if (!item) return;
      const groupId = normalizeId(item.group_id);
      if (!groupId) return;
      correctionByGroup.set(groupId, item);
    });

    (features || []).forEach((feature) => {
      restoreOriginalCoordinates(feature);
      const props = feature?.properties || {};
      const xid = normalizeId(props.id);
      const fallbackGroup = normalizeId(props.group_id) || xid;
      const resolvedGroup = normalizeId(resolvedByXid[xid]) || fallbackGroup;
      if (resolvedGroup) {
        props.group_root = resolvedGroup;
      }

      props.correction_state = "none";
      props.anchor_type = "none";
      props.needs_confirmation = false;
      delete props.corrected;

      if (!resolvedGroup || !correctionByGroup.has(resolvedGroup)) return;
      const correction = correctionByGroup.get(resolvedGroup);
      props.correction_state = correction?.correction_state || "none";
      props.anchor_type = correction?.anchor_type || "none";
      props.needs_confirmation = Boolean(correction?.needs_confirmation);
      const lat = toFiniteCoord(correction.lat);
      const lon = toFiniteCoord(correction.lon);
      if (lat === null || lon === null) return;
      applyCorrectedCoordinates(feature, lat, lon);
      props.corrected = { lat, lon };
    });

    const doneGroupIds = new Set(
      Array.isArray(reviewState?.doneGroupIds)
        ? reviewState.doneGroupIds.map((value) => normalizeId(value)).filter(Boolean)
        : [],
    );

    return { correctionByGroup, doneGroupIds };
  }

  function sortGroupItems(items) {
    return items.sort((a, b) => {
      const propsA = a?.properties || {};
      const propsB = b?.properties || {};
      const signatureA = normalizeId(propsA.signature);
      const signatureB = normalizeId(propsB.signature);
      if (signatureA && signatureB) {
        return signatureA.localeCompare(signatureB, "cs");
      }
      if (signatureA) return -1;
      if (signatureB) return 1;
      const idA = normalizeId(propsA.id);
      const idB = normalizeId(propsB.id);
      return idA.localeCompare(idB);
    });
  }

  function buildGroups(features, resolveGroupId) {
    const groupById = new Map();
    const groupByXid = new Map();
    const featureById = new Map();

    (features || []).forEach((feature) => {
      const props = feature?.properties || {};
      const xid = normalizeId(props.id);
      if (xid) featureById.set(xid, feature);

      const baseGroup =
        normalizeId(props.group_root) || normalizeId(props.group_id) || xid;
      const groupId = resolveGroupId ? resolveGroupId(baseGroup) : baseGroup;
      if (!groupId) return;

      props.group_root = groupId;

      if (!groupById.has(groupId)) {
        groupById.set(groupId, { id: groupId, items: [] });
      }
      const group = groupById.get(groupId);
      group.items.push(feature);
      if (xid) groupByXid.set(xid, group);
    });

    groupById.forEach((group) => {
      sortGroupItems(group.items);
      group.primary = group.items[0] || null;
      const coords = group.primary?.geometry?.coordinates || [];
      group.lon = Number(coords[0]);
      group.lat = Number(coords[1]);
    });

    return {
      groups: Array.from(groupById.values()),
      groupById,
      groupByXid,
      featureById,
    };
  }

  function buildDoneGroupSet(corrections, groupIdByXid, resolveGroupId) {
    const done = new Set();
    (corrections || []).forEach((item) => {
      if (!item) return;
      const xid = normalizeId(item.xid);
      const baseGroup =
        normalizeId(item.group_id) || groupIdByXid.get(xid) || xid;
      if (!baseGroup) return;
      const groupId = resolveGroupId ? resolveGroupId(baseGroup) : baseGroup;
      if (!groupId) return;
      if (item.has_coordinates || item.verdict === "ok") {
        done.add(groupId);
      }
    });
    return done;
  }

  window.OldPragueGrouping = {
    buildGroupIdByXid,
    buildMergeResolver,
    applyCorrections,
    applyReviewState,
    buildGroups,
    buildDoneGroupSet,
  };
})();
