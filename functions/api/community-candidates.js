import {
  buildDuplicateCandidates,
  buildEffectiveGroups,
  paginateCandidates,
  remapVersionClusters,
  StaleCandidateCursorError,
} from "./_community_candidates.js";
import { logDatabaseError } from "./_db.js";
import { recordOperation } from "./_operations.js";
import { onRequest as reviewStateOnRequest } from "./review-state.js";

const staticCacheByAssets = new WeakMap();
const candidateCacheByDatabase = new WeakMap();

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function loadAssetJson(request, env, path) {
  if (!env.ASSETS?.fetch) throw new Error("Missing ASSETS binding");
  let cache = staticCacheByAssets.get(env.ASSETS);
  if (!cache) {
    cache = new Map();
    staticCacheByAssets.set(env.ASSETS, cache);
  }
  if (!cache.has(path)) {
    const promise = (async () => {
      const response = await env.ASSETS.fetch(
        new Request(new URL(path, request.url).toString()),
      );
      if (!response.ok) {
        const error = new Error(`Static candidate data unavailable: ${path}`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    })();
    cache.set(path, promise);
  }
  const promise = cache.get(path);
  try {
    return await promise;
  } catch (error) {
    if (cache.get(path) === promise) cache.delete(path);
    throw error;
  }
}

function orphanIdsFrom(payload) {
  const values = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.xids)
      ? payload.xids
      : [];
  return new Set(values.map((value) => String(value || "").trim()).filter(Boolean));
}

function optionalAssetFallback(error, fallback) {
  if (Number(error?.status) === 404) return fallback;
  throw error;
}

async function loadReviewState(request, env, waitUntil) {
  const stateUrl = new URL("/api/review-state?snapshot=1", request.url);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await reviewStateOnRequest({
      request: new Request(stateUrl.toString(), { method: "GET", headers: request.headers }),
      env,
      waitUntil: typeof waitUntil === "function" ? waitUntil : () => {},
    });
    if (!response.ok) {
      throw new Error(`Review state unavailable: ${response.status}`);
    }
    const payload = await response.json();
    const stable = response.headers.get("X-Community-Revision-Stable") === "1";
    if (stable) {
      return {
        payload,
        revision: Number(response.headers.get("X-Community-Revision")) || 0,
        dataVersion: String(
          response.headers.get("X-Community-Data-Version") || "",
        ).trim(),
      };
    }
  }
  throw new Error("Review state changed while candidates were built");
}

function candidateCache(env) {
  let cache = candidateCacheByDatabase.get(env.CORRECTIONS_DB);
  if (!cache) {
    cache = new Map();
    candidateCacheByDatabase.set(env.CORRECTIONS_DB, cache);
  }
  return cache;
}

export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  if (request.method !== "GET") {
    return jsonResponse({ detail: "Method Not Allowed" }, 405);
  }
  if (!env.CORRECTIONS_DB || !env.ASSETS) {
    return jsonResponse({ detail: "Stav komunity není dostupný" }, 500);
  }

  const url = new URL(request.url);
  const flow = String(url.searchParams.get("flow") || "").trim();
  if (!new Set(["location", "group", "duplicate"]).has(flow)) {
    return jsonResponse({ detail: "Neplatný typ kontroly" }, 400);
  }
  const trackedResponse = (response) => {
    recordOperation(context, {
      metric: "candidate_page",
      flow,
      status: response.status,
    });
    return response;
  };

  try {
    const [photos, orphanPayload, reviewSnapshot] = await Promise.all([
      loadAssetJson(request, env, "/data/photos.geojson"),
      loadAssetJson(request, env, "/data/orphan_xids.json").catch(
        (error) => optionalAssetFallback(error, { xids: [] }),
      ),
      loadReviewState(request, env, waitUntil),
    ]);
    const reviewState = reviewSnapshot.payload;
    const revision = reviewSnapshot.revision;
    const dataVersion = reviewSnapshot.dataVersion;
    if (!dataVersion) throw new Error("Community data version is unavailable");
    const requestedFocusGroupId = String(
      url.searchParams.get("group_id") || "",
    ).trim();
    const focusGroupId = requestedFocusGroupId
      ? String(reviewState?.groupRoots?.[requestedFocusGroupId] || requestedFocusGroupId)
      : "";
    if (["location", "duplicate"].includes(flow) && focusGroupId) {
      const knownGroupIds = new Set(
        Object.values(reviewState?.resolvedGroupByXid || {}),
      );
      if (!knownGroupIds.has(focusGroupId)) {
        return trackedResponse(
          jsonResponse({ detail: "Neznámá skupina" }, 400),
        );
      }
    }
    const cache = candidateCache(env);
    const cacheKey = `${dataVersion}:${revision}:${flow}`;
    let candidatePromise = cache.get(cacheKey);
    if (!candidatePromise) {
      candidatePromise = (async () => {
        const groups = buildEffectiveGroups({
          features: photos?.features || [],
          orphanIds: orphanIdsFrom(orphanPayload),
          reviewState,
        });
        if (flow === "location") {
          const doneGroups = new Set(reviewState?.doneGroupIds || []);
          return groups.filter((group) => !doneGroups.has(group.id));
        }
        if (flow === "group") {
          const clusterPayload = await loadAssetJson(
            request,
            env,
            "/data/series_version_clusters.json",
          ).catch((error) => optionalAssetFallback(error, { clusters: [] }));
          const clustersBySeries = remapVersionClusters(
            clusterPayload?.clusters || [],
            groups,
          );
          return groups
            .filter((group) => group.items.length > 1)
            .map((group) => ({
              ...group,
              version_clusters: clustersBySeries.get(group.id) || [],
            }));
        }
        const similarityPayload = await loadAssetJson(
          request,
          env,
          "/data/similarity_candidates.json",
        ).catch((error) => optionalAssetFallback(error, { pairs: [] }));
        return buildDuplicateCandidates({
          groups,
          similarityPairs: similarityPayload?.pairs || [],
          reviewState,
        });
      })();
      cache.set(cacheKey, candidatePromise);
      if (cache.size > 6) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey && oldestKey !== cacheKey) cache.delete(oldestKey);
      }
    }
    let candidates;
    try {
      candidates = await candidatePromise;
    } catch (error) {
      if (cache.get(cacheKey) === candidatePromise) cache.delete(cacheKey);
      throw error;
    }

    let pageCandidates = candidates;
    if (flow === "location" && focusGroupId) {
      pageCandidates = candidates.filter(
        (candidate) => candidate?.id === focusGroupId,
      );
    } else if (flow === "duplicate" && focusGroupId) {
      pageCandidates = candidates.filter((candidate) => (
        candidate?.groupA?.id === focusGroupId ||
        candidate?.groupB?.id === focusGroupId
      ));
    }
    return trackedResponse(
      jsonResponse({
        flow,
        ...paginateCandidates(
          pageCandidates,
          url.searchParams.get("cursor"),
          url.searchParams.get("limit"),
          revision,
          dataVersion,
        ),
      }),
    );
  } catch (error) {
    if (error instanceof StaleCandidateCursorError) {
      return trackedResponse(
        jsonResponse(
          { detail: "Seznam se změnil. Načtěte ho znovu." },
          409,
        ),
      );
    }
    logDatabaseError("/api/community-candidates", `load ${flow} candidates`, error);
    return trackedResponse(
      jsonResponse(
        { detail: "Seznam ke kontrole není dočasně dostupný" },
        503,
      ),
    );
  }
}
