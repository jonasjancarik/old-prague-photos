import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildDuplicateCandidates,
  buildEffectiveGroups,
  paginateCandidates,
  remapVersionClusters,
} from "../_community_candidates.js";

function feature(id, groupId, lon = 14.4, lat = 50.1) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { id, group_id: groupId, signature: id },
  };
}

test("effective candidates use resolved groups, corrections, and orphan filtering", () => {
  const groups = buildEffectiveGroups({
    features: [feature("A1", "G1"), feature("A2", "G2"), feature("ORPHAN", "G3")],
    orphanIds: new Set(["ORPHAN"]),
    reviewState: {
      resolvedGroupByXid: { A1: "ROOT", A2: "ROOT", ORPHAN: "G3" },
      groupCorrections: [
        {
          group_id: "ROOT",
          lat: 50.2,
          lon: 14.5,
          correction_state: "approved",
          anchor_type: "correction",
        },
      ],
    },
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, "ROOT");
  assert.equal(groups[0].items.length, 2);
  assert.deepEqual(groups[0].primary.geometry.coordinates, [14.5, 50.2]);
});

test("corrections without coordinates preserve the source location", () => {
  const groups = buildEffectiveGroups({
    features: [feature("A1", "G1", 14.4, 50.1)],
    orphanIds: new Set(),
    reviewState: {
      resolvedGroupByXid: {},
      groupCorrections: [
        {
          group_id: "G1",
          lat: null,
          lon: null,
          correction_state: "pending",
          anchor_type: "flag",
        },
      ],
    },
  });

  assert.deepEqual(groups[0].primary.geometry.coordinates, [14.4, 50.1]);
  assert.equal(groups[0].lat, 50.1);
  assert.equal(groups[0].lon, 14.4);
  assert.equal(groups[0].primary.properties.corrected, undefined);
});

test("duplicate coordinate expansion is bounded for large buckets", () => {
  const groups = buildEffectiveGroups({
    features: Array.from({ length: 212 }, (_, index) =>
      feature(`X${String(index).padStart(3, "0")}`, `G${String(index).padStart(3, "0")}`),
    ),
    orphanIds: new Set(),
    reviewState: { resolvedGroupByXid: {}, groupCorrections: [] },
  });
  const candidates = buildDuplicateCandidates({
    groups,
    similarityPairs: [],
    reviewState: { groupRoots: {}, mergeDecisions: [] },
    maxCoordinateNeighbors: 8,
  });

  assert.ok(candidates.length <= 212 * 8);
  assert.ok(candidates.length < (212 * 211) / 2);
  assert.equal(new Set(candidates.map((item) => item.key)).size, candidates.length);
});

test("similarity pairs follow the paired XID after a membership move", () => {
  const reviewState = {
    resolvedGroupByXid: { A1: "MOVED", B1: "G2" },
    groupRoots: { G1: "G1", G2: "G2", MOVED: "MOVED" },
    groupCorrections: [],
    mergeDecisions: [],
  };
  const groups = buildEffectiveGroups({
    features: [feature("A1", "G1", 14.1), feature("B1", "G2", 14.2)],
    orphanIds: new Set(),
    reviewState,
  });
  const candidates = buildDuplicateCandidates({
    groups,
    similarityPairs: [
      { xid_a: "A1", group_id_a: "G1", xid_b: "B1", group_id_b: "G2" },
    ],
    reviewState,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].key, "G2::MOVED");
});

test("version clusters follow current XID membership and drop missing members", () => {
  const reviewState = {
    resolvedGroupByXid: { A1: "TARGET", A2: "SOURCE", B1: "TARGET" },
    groupCorrections: [],
  };
  const groups = buildEffectiveGroups({
    features: [
      feature("A1", "SOURCE"),
      feature("A2", "SOURCE"),
      feature("B1", "TARGET"),
    ],
    orphanIds: new Set(),
    reviewState,
  });
  const remapped = remapVersionClusters([
    {
      series_id: "SOURCE",
      version_id: "v1",
      xids: ["A1", "A2", "REMOVED"],
      representative_xid: "A1",
      max_distance: 3,
    },
    {
      series_id: "TARGET",
      version_id: "v1",
      xids: ["B1"],
      representative_xid: "B1",
      max_distance: 0,
    },
  ], groups);

  assert.deepEqual(remapped.get("SOURCE")[0].xids, ["A2"]);
  assert.deepEqual(
    remapped.get("TARGET").flatMap((cluster) => cluster.xids).sort(),
    ["A1", "B1"],
  );
  assert.deepEqual(
    remapped.get("TARGET").map((cluster) => cluster.version_id),
    ["v1", "v2"],
  );
});

test("candidate pagination caps payload pages at fifty items", () => {
  const result = paginateCandidates(
    Array.from({ length: 125 }, (_, id) => id),
    "vZGF0YS12MQ:r7:50",
    500,
    7,
    "data-v1",
  );
  assert.equal(result.items.length, 50);
  assert.equal(result.nextCursor, "vZGF0YS12MQ:r7:100");
  assert.equal(result.total, 125);
});

test("candidate cursors reject a different community revision", () => {
  assert.throws(
    () => paginateCandidates(
      [1, 2, 3],
      "vZGF0YS12MQ:r6:1",
      1,
      7,
      "data-v1",
    ),
    /older community revision/u,
  );
  assert.throws(
    () => paginateCandidates(
      [1, 2, 3],
      "vZGF0YS12MQ:r7:1",
      1,
      7,
      "data-v2",
    ),
    /older community revision/u,
  );
});

test("community controllers do not download full-corpus artifacts", () => {
  for (const path of [
    "viewer/static/pomoc.js",
    "viewer/static/group-review.js",
    "viewer/static/dup-review.js",
  ]) {
    const source = readFileSync(path, "utf8");
    assert.equal(source.includes("/data/photos.geojson"), false, path);
    assert.equal(source.includes("/data/series_version_clusters.json"), false, path);
    assert.equal(source.includes("/data/similarity_candidates.json"), false, path);
    assert.equal(source.includes("/api/community-candidates"), true, path);
  }
  const locationSource = readFileSync("viewer/static/pomoc.js", "utf8");
  assert.equal(
    locationSource.includes("applyReviewStateSnapshot(state.lastReviewState)"),
    false,
  );
  assert.equal(
    locationSource.includes('/api/review-state?snapshot=1'),
    true,
  );
  const endpointSource = readFileSync(
    "functions/api/community-candidates.js",
    "utf8",
  );
  assert.equal(
    endpointSource.includes("${dataVersion}:${revision}:${flow}:${focusGroupId}"),
    false,
  );
  const duplicateSource = readFileSync("viewer/static/dup-review.js", "utf8");
  assert.equal(
    duplicateSource.includes("state.lastSubmittedPair = result.decision"),
    true,
  );
});
