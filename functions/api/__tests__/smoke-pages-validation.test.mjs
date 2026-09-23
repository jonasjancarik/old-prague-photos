import assert from "node:assert/strict";
import test from "node:test";

import { isValidReviewSnapshot } from "../../../scripts/smoke-pages-validation.mjs";

test("Pages smoke validation accepts an empty ready catalog", () => {
  const snapshot = {
    reviewStateSchemaVersion: 4,
    groupCorrections: [],
    doneGroupIds: [],
    mergeDecisions: [],
    resolvedGroupByXid: {},
    counts: { knownXids: 12518 },
  };
  assert.equal(isValidReviewSnapshot(snapshot), true);
  assert.equal(isValidReviewSnapshot({ ...snapshot, counts: { knownXids: 0 } }), false);
  assert.equal(isValidReviewSnapshot({ ...snapshot, reviewStateSchemaVersion: 3 }), false);
});
