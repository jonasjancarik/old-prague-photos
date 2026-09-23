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

test("pending proposed coordinates preserve the public source location", () => {
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
          proposed_has_coordinates: true,
          proposed_id: "17",
          proposed_lat: 50.2,
          proposed_lon: 14.5,
          location_revision: '["G1","17"]',
          anchor_id: "17",
          correction_state: "pending",
          anchor_type: "correction",
        },
      ],
    },
  });

  assert.deepEqual(groups[0].primary.geometry.coordinates, [14.4, 50.1]);
  assert.equal(groups[0].lat, 50.1);
  assert.equal(groups[0].lon, 14.4);
  assert.equal(groups[0].primary.properties.corrected, undefined);
  assert.equal(groups[0].primary.properties.proposed_id, "17");
  assert.equal(groups[0].primary.properties.proposed_lat, 50.2);
  assert.equal(groups[0].primary.properties.proposed_lon, 14.5);
  assert.equal(
    groups[0].primary.properties.location_revision,
    '["G1","17"]',
  );
});

test("a pending same vote keeps the pair available for independent review", () => {
  const groups = buildEffectiveGroups({
    features: [feature("A1", "G1"), feature("A2", "G2")],
    orphanIds: new Set(),
    reviewState: {
      resolvedGroupByXid: { A1: "G1", A2: "G2" },
      groupCorrections: [],
    },
  });
  const candidates = buildDuplicateCandidates({
    groups,
    similarityPairs: [],
    reviewState: {
      groupRoots: { G1: "G1", G2: "G2" },
      mergeDecisions: [
        {
          group_id_a: "G1",
          group_id_b: "G2",
          verdict: "pending",
          same_votes: 1,
          required_same_votes: 2,
        },
      ],
    },
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].key, "G1::G2");
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

test("community controllers use browser candidate computation", () => {
  for (const path of [
    "viewer/static/pomoc.js",
    "viewer/static/group-review.js",
    "viewer/static/dup-review.js",
  ]) {
    const source = readFileSync(path, "utf8");
    assert.equal(source.includes("/data/photos.geojson"), false, path);
    assert.equal(source.includes("/data/series_version_clusters.json"), false, path);
    assert.equal(source.includes("/data/similarity_candidates.json"), false, path);
    assert.equal(source.includes("window.OldPragueCandidates.loadPage"), true, path);
  }
  const clientSource = readFileSync("viewer/static/candidate-client.js", "utf8");
  assert.equal(clientSource.includes("/data/photos.geojson"), true);
  assert.equal(clientSource.includes("/data/series_version_clusters.json"), true);
  assert.equal(clientSource.includes("/data/similarity_candidates.json"), true);
  const locationSource = readFileSync("viewer/static/pomoc.js", "utf8");
  assert.equal(
    locationSource.includes("applyReviewStateSnapshot(state.lastReviewState)"),
    false,
  );
  assert.equal(
    locationSource.includes('/api/review-state?snapshot=1'),
    true,
  );
  const endpointSource = readFileSync("functions/api/community-candidates.js", "utf8");
  assert.equal(endpointSource.includes("/data/photos.geojson"), false);
  const duplicateSource = readFileSync("viewer/static/dup-review.js", "utf8");
  assert.equal(
    duplicateSource.includes("state.lastSubmittedPair = result.decision"),
    true,
  );
});

test("location confirmations stay scoped to the evidence shown in the help flow", () => {
  const mapSource = readFileSync("viewer/static/app.js", "utf8");
  assert.equal(mapSource.includes('submitModalVerdict("ok")'), false);
  assert.equal(mapSource.includes("focusedLocationReviewUrl"), true);
  assert.equal(mapSource.includes('mode: "location"'), true);
  assert.equal(mapSource.includes("window.location.assign(reviewUrl)"), true);
  assert.equal(
    mapSource.includes('fetchJson("/api/review-state?snapshot=1")'),
    true,
  );

  const locationSource = readFileSync("viewer/static/pomoc.js", "utf8");
  assert.equal(locationSource.includes("locationEvidenceKey"), true);
  assert.equal(locationSource.includes("resetTransientLocationDecision"), true);
  assert.equal(locationSource.includes("setCurrentFeature(state.currentFeature)"), true);
  assert.equal(
    locationSource.includes("Prohlédněte si aktualizované body a rozhodněte se znovu."),
    true,
  );
});

test("duplicate decisions carry candidate revisions while exact undo remains revision-free", () => {
  const source = readFileSync("viewer/static/dup-review.js", "utf8");
  assert.equal(source.includes("candidate_revision: state.candidateRevision"), true);
  assert.equal(
    source.includes("Stále ho můžete vrátit tlačítkem Zpět."),
    true,
  );
  assert.equal(
    /verdict: "undo",\s*\}\);/u.test(source),
    true,
  );
});

test("community templates keep privacy context and keyboard evidence order", () => {
  const indexTemplate = readFileSync(
    "viewer/react/src/templates/index-body.html",
    "utf8",
  );
  assert.equal(indexTemplate.includes('aria-describedby="correction-email-privacy"'), true);
  assert.equal(
    indexTemplate.includes("použijeme ho jen pro případné upřesnění tohoto hlášení"),
    true,
  );

  const duplicateTemplate = readFileSync(
    "viewer/react/src/templates/dup-review-body.html",
    "utf8",
  );
  const orderedSections = [
    'data-review-section="preview-a"',
    'data-review-section="preview-b"',
    'data-review-section="details-a"',
    'data-review-section="details-b"',
  ].map((needle) => duplicateTemplate.indexOf(needle));
  assert.equal(orderedSections.every((position) => position >= 0), true);
  assert.deepEqual(orderedSections, orderedSections.slice().sort((a, b) => a - b));

  const styles = readFileSync("viewer/static/styles.css", "utf8");
  assert.equal(styles.includes(".duplicate-review-grid .review-column {\n    display: contents;"), false);
});
