import assert from "node:assert/strict";
import test from "node:test";

import { buildReviewState } from "../_review_state.js";

function buildMap(entries) {
  return new Map(entries);
}

test("first correction is pending and not done", () => {
  const state = buildReviewState({
    correctionRows: [
      {
        id: 1,
        xid: "X1",
        group_id: "G1",
        lat: 50.1,
        lon: 14.4,
        has_coordinates: 1,
        voter_key: "voter-a",
        verdict: "wrong",
        created_at: "2026-01-01 10:00:00",
      },
    ],
    mergeRows: [],
    xidGroupMap: buildMap([["X1", "G1"]]),
  });

  assert.equal(state.groupCorrections.length, 1);
  const item = state.groupCorrections[0];
  assert.equal(item.correction_state, "pending");
  assert.equal(item.anchor_type, "correction");
  assert.equal(item.done, false);
  assert.equal(item.required_ok_votes, 1);
  assert.equal(item.ok_votes, 0);
  assert.equal(item.has_coordinates, true);
  assert.deepEqual(state.doneGroupIds, []);
});

test("correction + independent ok is approved and done", () => {
  const state = buildReviewState({
    correctionRows: [
      {
        id: 1,
        xid: "X1",
        group_id: "G1",
        lat: 50.1,
        lon: 14.4,
        has_coordinates: 1,
        voter_key: "voter-a",
        verdict: "wrong",
        created_at: "2026-01-01 10:00:00",
      },
      {
        id: 2,
        xid: "X1",
        group_id: "G1",
        has_coordinates: 0,
        voter_key: "voter-b",
        verdict: "ok",
        created_at: "2026-01-01 10:05:00",
      },
    ],
    mergeRows: [],
    xidGroupMap: buildMap([["X1", "G1"]]),
  });

  const item = state.groupCorrections[0];
  assert.equal(item.correction_state, "approved");
  assert.equal(item.done, true);
  assert.equal(item.ok_votes, 1);
  assert.equal(item.required_ok_votes, 1);
  assert.deepEqual(state.doneGroupIds, ["G1"]);
});

test("group without correction requires two independent ok votes", () => {
  const state = buildReviewState({
    correctionRows: [
      {
        id: 1,
        xid: "X1",
        group_id: "G1",
        has_coordinates: 0,
        voter_key: "voter-a",
        verdict: "ok",
        created_at: "2026-01-01 10:00:00",
      },
      {
        id: 2,
        xid: "X1",
        group_id: "G1",
        has_coordinates: 0,
        voter_key: "voter-b",
        verdict: "ok",
        created_at: "2026-01-01 10:05:00",
      },
    ],
    mergeRows: [],
    xidGroupMap: buildMap([["X1", "G1"]]),
  });

  const item = state.groupCorrections[0];
  assert.equal(item.anchor_type, "none");
  assert.equal(item.correction_state, "none");
  assert.equal(item.required_ok_votes, 2);
  assert.equal(item.ok_votes, 2);
  assert.equal(item.done, true);
});

test("same voter does not satisfy independent confirmations", () => {
  const state = buildReviewState({
    correctionRows: [
      {
        id: 1,
        xid: "X1",
        group_id: "G1",
        lat: 50.1,
        lon: 14.4,
        has_coordinates: 1,
        voter_key: "voter-a",
        verdict: "wrong",
        created_at: "2026-01-01 10:00:00",
      },
      {
        id: 2,
        xid: "X1",
        group_id: "G1",
        has_coordinates: 0,
        voter_key: "voter-a",
        verdict: "ok",
        created_at: "2026-01-01 10:05:00",
      },
      {
        id: 3,
        xid: "X1",
        group_id: "G1",
        has_coordinates: 0,
        voter_key: "voter-a",
        verdict: "ok",
        created_at: "2026-01-01 10:06:00",
      },
    ],
    mergeRows: [],
    xidGroupMap: buildMap([["X1", "G1"]]),
  });

  const item = state.groupCorrections[0];
  assert.equal(item.correction_state, "pending");
  assert.equal(item.ok_votes, 0);
  assert.equal(item.done, false);
});

test("new correction resets prior approvals", () => {
  const state = buildReviewState({
    correctionRows: [
      {
        id: 1,
        xid: "X1",
        group_id: "G1",
        lat: 50.1,
        lon: 14.4,
        has_coordinates: 1,
        voter_key: "voter-a",
        verdict: "wrong",
        created_at: "2026-01-01 10:00:00",
      },
      {
        id: 2,
        xid: "X1",
        group_id: "G1",
        has_coordinates: 0,
        voter_key: "voter-b",
        verdict: "ok",
        created_at: "2026-01-01 10:05:00",
      },
      {
        id: 3,
        xid: "X1",
        group_id: "G1",
        lat: 50.2,
        lon: 14.5,
        has_coordinates: 1,
        voter_key: "voter-c",
        verdict: "wrong",
        created_at: "2026-01-01 10:10:00",
      },
    ],
    mergeRows: [],
    xidGroupMap: buildMap([["X1", "G1"]]),
  });

  const item = state.groupCorrections[0];
  assert.equal(item.correction_state, "pending");
  assert.equal(item.done, false);
  assert.equal(item.lat, 50.2);
  assert.equal(item.lon, 14.5);
});

test("flag creates pending unresolved state while preserving last approved coords", () => {
  const state = buildReviewState({
    correctionRows: [
      {
        id: 1,
        xid: "X1",
        group_id: "G1",
        lat: 50.1,
        lon: 14.4,
        has_coordinates: 1,
        voter_key: "voter-a",
        verdict: "wrong",
        created_at: "2026-01-01 10:00:00",
      },
      {
        id: 2,
        xid: "X1",
        group_id: "G1",
        has_coordinates: 0,
        voter_key: "voter-b",
        verdict: "ok",
        created_at: "2026-01-01 10:02:00",
      },
      {
        id: 3,
        xid: "X1",
        group_id: "G1",
        has_coordinates: 0,
        voter_key: "voter-c",
        verdict: "flag",
        created_at: "2026-01-01 10:05:00",
      },
    ],
    mergeRows: [],
    xidGroupMap: buildMap([["X1", "G1"]]),
  });

  const item = state.groupCorrections[0];
  assert.equal(item.anchor_type, "flag");
  assert.equal(item.correction_state, "pending");
  assert.equal(item.done, false);
  assert.equal(item.required_ok_votes, 2);
  assert.equal(item.has_coordinates, true);
  assert.equal(item.lat, 50.1);
  assert.equal(item.lon, 14.4);
});

test("merge same resolves group roots across xids", () => {
  const state = buildReviewState({
    correctionRows: [],
    mergeRows: [
      {
        id: 1,
        group_id_a: "G1",
        group_id_b: "G2",
        verdict: "same",
        created_at: "2026-01-01 10:00:00",
      },
    ],
    xidGroupMap: buildMap([
      ["X1", "G1"],
      ["X2", "G2"],
    ]),
  });

  assert.equal(state.resolvedGroupByXid.X1, "G1");
  assert.equal(state.resolvedGroupByXid.X2, "G1");
  assert.equal(state.groupRoots.G2, "G1");
  assert.deepEqual(state.mergeDecisions, [
    {
      group_id_a: "G1",
      group_id_b: "G2",
      verdict: "same",
      voter_key: "",
      user_agent: "",
      received_at: "2026-01-01 10:00:00",
    },
  ]);
});

test("merge undo clears latest pair decision and keeps groups split", () => {
  const state = buildReviewState({
    correctionRows: [],
    mergeRows: [
      {
        id: 1,
        group_id_a: "G1",
        group_id_b: "G2",
        verdict: "same",
        created_at: "2026-01-01 10:00:00",
      },
      {
        id: 2,
        group_id_a: "G1",
        group_id_b: "G2",
        verdict: "undo",
        created_at: "2026-01-01 10:05:00",
      },
    ],
    xidGroupMap: buildMap([
      ["X1", "G1"],
      ["X2", "G2"],
    ]),
  });

  assert.equal(state.resolvedGroupByXid.X1, "G1");
  assert.equal(state.resolvedGroupByXid.X2, "G2");
  assert.deepEqual(state.mergeDecisions, []);
});
