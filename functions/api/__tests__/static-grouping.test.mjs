import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const groupingPath = path.resolve(
  __dirname,
  "../../../viewer/static/grouping.js",
);

function loadGrouping() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(groupingPath, "utf8"), sandbox);
  return sandbox.window.OldPragueGrouping;
}

function feature(id, groupId, coordinates) {
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: coordinates.slice(),
    },
    properties: {
      id,
      group_id: groupId,
    },
  };
}

function coordinatesOf(item) {
  return Array.from(item.geometry.coordinates);
}

function plainObject(value) {
  return value ? { ...value } : value;
}

test("applyReviewState restores original coordinates after merge split", () => {
  const grouping = loadGrouping();
  const features = [
    feature("X1", "G1", [14.1, 50.1]),
    feature("X2", "G2", [14.2, 50.2]),
  ];

  grouping.applyReviewState(features, {
    resolvedGroupByXid: {
      X1: "G1",
      X2: "G1",
    },
    groupCorrections: [
      {
        group_id: "G1",
        lat: 51.1,
        lon: 15.1,
        correction_state: "approved",
        anchor_type: "correction",
      },
    ],
  });

  assert.deepEqual(coordinatesOf(features[0]), [15.1, 51.1]);
  assert.deepEqual(coordinatesOf(features[1]), [15.1, 51.1]);

  grouping.applyReviewState(features, {
    resolvedGroupByXid: {
      X1: "G1",
      X2: "G2",
    },
    groupCorrections: [
      {
        group_id: "G1",
        lat: 51.1,
        lon: 15.1,
        correction_state: "approved",
        anchor_type: "correction",
      },
    ],
  });

  assert.deepEqual(coordinatesOf(features[0]), [15.1, 51.1]);
  assert.deepEqual(coordinatesOf(features[1]), [14.2, 50.2]);
  assert.deepEqual(plainObject(features[0].properties.corrected), {
    lat: 51.1,
    lon: 15.1,
  });
  assert.equal(features[1].properties.corrected, undefined);
});
