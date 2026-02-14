(() => {
  const ORPHAN_IDS_URL = "/data/orphan_xids.json";

  const state = {
    orphanIds: null,
    orphanIdsPromise: null,
  };

  function normalizeId(value) {
    const id = String(value || "").trim();
    return id || "";
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Požadavek selhal: ${response.status}`);
    }
    return response.json();
  }

  async function loadOrphanIds() {
    if (state.orphanIds) {
      return state.orphanIds;
    }
    if (state.orphanIdsPromise) {
      return state.orphanIdsPromise;
    }

    state.orphanIdsPromise = (async () => {
      try {
        const payload = await fetchJson(ORPHAN_IDS_URL);
        const ids = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.xids)
            ? payload.xids
            : [];
        const set = new Set(
          ids.map((value) => normalizeId(value)).filter(Boolean),
        );
        state.orphanIds = set;
        return set;
      } catch (error) {
        console.warn("Nepodařilo se načíst orphan_xids.json", error);
        state.orphanIds = new Set();
        return state.orphanIds;
      } finally {
        state.orphanIdsPromise = null;
      }
    })();

    return state.orphanIdsPromise;
  }

  function filterFeatures(features, orphanIds) {
    const input = Array.isArray(features) ? features : [];
    if (!orphanIds || orphanIds.size === 0) {
      return input;
    }

    return input.filter((feature) => {
      const xid = normalizeId(feature?.properties?.id);
      if (!xid) return false;
      return !orphanIds.has(xid);
    });
  }

  async function filterPhotoCollection(collection) {
    const base =
      collection && typeof collection === "object"
        ? collection
        : { type: "FeatureCollection", features: [] };
    const features = Array.isArray(base.features) ? base.features : [];
    const orphanIds = await loadOrphanIds();
    const filteredFeatures = filterFeatures(features, orphanIds);
    return {
      ...base,
      features: filteredFeatures,
    };
  }

  window.OldPragueMediaFilter = {
    loadOrphanIds,
    filterFeatures,
    filterPhotoCollection,
  };
})();
