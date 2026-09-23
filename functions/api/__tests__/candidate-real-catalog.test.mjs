import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  buildDuplicateCandidates,
  buildEffectiveGroups,
} from "../_community_candidates.js";

const staticPath = (name) => new URL(`../../../viewer/static/${name}`, import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(staticPath(name), "utf8"));

test("browser candidate queues match the source rules at real catalog size", async () => {
  const assets = {
    "/data/photos.geojson": readJson("data/photos.geojson"),
    "/data/orphan_xids.json": readJson("data/orphan_xids.json"),
    "/data/similarity_candidates.json": readJson("data/similarity_candidates.json"),
    "/data/series_version_clusters.json": readJson("data/series_version_clusters.json"),
  };
  const version = readJson("data/community-data-version.json").version;
  const baselineGroups = buildEffectiveGroups({
    features: assets["/data/photos.geojson"].features,
    orphanIds: new Set(assets["/data/orphan_xids.json"]),
    reviewState: {},
  });
  const baselinePairs = buildDuplicateCandidates({
    groups: baselineGroups,
    similarityPairs: assets["/data/similarity_candidates.json"].pairs,
    reviewState: {},
  });

  const requestedPaths = [];
  const context = vm.createContext({
    window: {},
    TextEncoder,
    btoa,
    Response,
    fetch: async (input) => {
      const path = new URL(input, "https://example.test").pathname;
      requestedPaths.push(path);
      if (path === "/api/review-state") {
        return new Response(JSON.stringify({
          groupCorrections: [],
          doneGroupIds: [],
          mergeDecisions: [],
          groupRoots: {},
          resolvedGroupByXid: {},
          reviewStateSchemaVersion: 4,
          counts: { knownXids: 12518 },
        }), {
          headers: {
            "X-Community-Revision": "0",
            "X-Community-Revision-Stable": "1",
            "X-Community-Data-Version": version,
          },
        });
      }
      return new Response(JSON.stringify(assets[path]), {
        status: assets[path] ? 200 : 404,
      });
    },
  });
  vm.runInContext(readFileSync(staticPath("grouping.js"), "utf8"), context);
  vm.runInContext(readFileSync(staticPath("candidate-client.js"), "utf8"), context);

  const client = context.window.OldPragueCandidates;
  const location = await client.loadPage({ flow: "location", limit: 50 });
  const group = await client.loadPage({ flow: "group", limit: 50 });
  const duplicate = await client.loadPage({ flow: "duplicate", limit: 50 });

  assert.equal(location.total, baselineGroups.length);
  assert.equal(group.total, baselineGroups.filter((item) => item.items.length > 1).length);
  assert.equal(duplicate.total, baselinePairs.length);
  assert.deepEqual(
    Array.from(duplicate.items, (item) => item.key),
    baselinePairs.slice(0, 50).map((item) => item.key),
  );
  assert.equal(requestedPaths.includes("/api/community-candidates"), false);
});
