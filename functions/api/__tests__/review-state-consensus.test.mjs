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
  assert.equal(item.has_coordinates, false);
  assert.equal(item.lat, null);
  assert.equal(item.lon, null);
  assert.equal(item.proposed_has_coordinates, true);
  assert.equal(item.proposed_id, "1");
  assert.equal(item.proposed_lat, 50.1);
  assert.equal(item.proposed_lon, 14.4);
  assert.equal(item.anchor_id, "1");
  assert.equal(item.location_revision, '["G1","1"]');
  assert.deepEqual(state.doneGroupIds, []);
});

test("targeted OK for an older proposal cannot approve a newer proposal", () => {
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
        lat: 50.2,
        lon: 14.5,
        has_coordinates: 1,
        voter_key: "voter-b",
        verdict: "wrong",
        created_at: "2026-01-01 10:01:00",
      },
      {
        id: 3,
        xid: "X1",
        group_id: "G1",
        has_coordinates: 0,
        voter_key: "voter-c",
        verdict: "ok",
        location_revision: '["G1","1"]',
        proposal_id: "1",
        created_at: "2026-01-01 10:02:00",
      },
    ],
    mergeRows: [],
    xidGroupMap: buildMap([["X1", "G1"]]),
  });

  const item = state.groupCorrections[0];
  assert.equal(item.anchor_id, "2");
  assert.equal(item.location_revision, '["G1","2"]');
  assert.equal(item.proposed_id, "2");
  assert.equal(item.ok_votes, 0);
  assert.equal(item.done, false);
  assert.equal(item.has_coordinates, false);
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
  assert.equal(item.has_coordinates, true);
  assert.equal(item.lat, 50.1);
  assert.equal(item.lon, 14.4);
  assert.equal(item.proposed_has_coordinates, true);
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
  assert.equal(item.lat, 50.1);
  assert.equal(item.lon, 14.4);
  assert.equal(item.proposed_has_coordinates, true);
  assert.equal(item.proposed_lat, 50.2);
  assert.equal(item.proposed_lon, 14.5);
});

test("curator membership move does not transfer historical correction", () => {
  const state = buildReviewState({
    correctionRows: [
      {
        id: 1,
        xid: "X1",
        group_id: "SOURCE",
        lat: 50.1,
        lon: 14.4,
        has_coordinates: 1,
        voter_key: "voter-a",
        verdict: "wrong",
        created_at: "2026-01-01 10:00:00",
      },
    ],
    mergeRows: [],
    xidGroupMap: buildMap([["X1", "TARGET"]]),
  });

  assert.equal(state.resolvedGroupByXid.X1, "TARGET");
  assert.equal(state.groupCorrections.length, 1);
  assert.equal(state.groupCorrections[0].group_id, "SOURCE");
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
  assert.equal(item.proposed_has_coordinates, false);
});

test("one same vote stays pending and keeps groups split", () => {
  const state = buildReviewState({
    correctionRows: [],
    mergeRows: [
      {
        id: 1,
        group_id_a: "G1",
        group_id_b: "G2",
        verdict: "same",
        voter_key: "voter-a",
        created_at: "2026-01-01 10:00:00",
      },
    ],
    xidGroupMap: buildMap([
      ["X1", "G1"],
      ["X2", "G2"],
    ]),
  });

  assert.equal(state.resolvedGroupByXid.X1, "G1");
  assert.equal(state.resolvedGroupByXid.X2, "G2");
  assert.equal(state.groupRoots.G2, "G2");
  assert.deepEqual(state.mergeDecisions, [
    {
      group_id_a: "G1",
      group_id_b: "G2",
      verdict: "pending",
      same_votes: 1,
      different_votes: 0,
      required_same_votes: 2,
      received_at: "2026-01-01 10:00:00",
    },
  ]);
});

test("two independent same votes resolve group roots across xids", () => {
  const state = buildReviewState({
    correctionRows: [],
    mergeRows: [
      {
        id: 1,
        group_id_a: "G1",
        group_id_b: "G2",
        verdict: "same",
        voter_key: "voter-a",
        created_at: "2026-01-01 10:00:00",
      },
      {
        id: 2,
        group_id_a: "G1",
        group_id_b: "G2",
        verdict: "same",
        voter_key: "voter-b",
        created_at: "2026-01-01 10:05:00",
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
      same_votes: 2,
      different_votes: 0,
      required_same_votes: 2,
      received_at: "2026-01-01 10:05:00",
    },
  ]);
});

test("repeated same decisions from one voter do not satisfy merge consensus", () => {
  const state = buildReviewState({
    correctionRows: [],
    mergeRows: [
      {
        id: 1,
        group_id_a: "G1",
        group_id_b: "G2",
        verdict: "same",
        voter_key: "voter-a",
        created_at: "2026-01-01 10:00:00",
      },
      {
        id: 2,
        group_id_a: "G1",
        group_id_b: "G2",
        verdict: "same",
        voter_key: "voter-a",
        created_at: "2026-01-01 10:05:00",
      },
    ],
    xidGroupMap: buildMap([
      ["X1", "G1"],
      ["X2", "G2"],
    ]),
  });

  assert.equal(state.resolvedGroupByXid.X2, "G2");
  assert.equal(state.mergeDecisions[0].verdict, "pending");
  assert.equal(state.mergeDecisions[0].same_votes, 1);
});

test("a voter undo removes only that voter's active same decision", () => {
  const state = buildReviewState({
    correctionRows: [],
    mergeRows: [
      {
        id: 1,
        group_id_a: "G1",
        group_id_b: "G2",
        verdict: "same",
        voter_key: "voter-a",
        created_at: "2026-01-01 10:00:00",
      },
      {
        id: 2,
        group_id_a: "G1",
        group_id_b: "G2",
        verdict: "same",
        voter_key: "voter-b",
        created_at: "2026-01-01 10:01:00",
      },
      {
        id: 3,
        group_id_a: "G1",
        group_id_b: "G2",
        verdict: "undo",
        voter_key: "voter-b",
        created_at: "2026-01-01 10:02:00",
      },
    ],
    xidGroupMap: buildMap([
      ["X1", "G1"],
      ["X2", "G2"],
    ]),
  });

  assert.equal(state.resolvedGroupByXid.X2, "G2");
  assert.equal(state.mergeDecisions[0].verdict, "pending");
  assert.equal(state.mergeDecisions[0].same_votes, 1);
});

test("a contrary decision replaces that voter's same decision", () => {
  const state = buildReviewState({
    correctionRows: [],
    mergeRows: [
      {
        id: 1,
        group_id_a: "G1",
        group_id_b: "G2",
        verdict: "same",
        voter_key: "voter-a",
        created_at: "2026-01-01 10:00:00",
      },
      {
        id: 2,
        group_id_a: "G1",
        group_id_b: "G2",
        verdict: "same",
        voter_key: "voter-b",
        created_at: "2026-01-01 10:01:00",
      },
      {
        id: 3,
        group_id_a: "G1",
        group_id_b: "G2",
        verdict: "different",
        voter_key: "voter-b",
        created_at: "2026-01-01 10:02:00",
      },
    ],
    xidGroupMap: buildMap([
      ["X1", "G1"],
      ["X2", "G2"],
    ]),
  });

  assert.equal(state.resolvedGroupByXid.X2, "G2");
  assert.equal(state.mergeDecisions[0].verdict, "pending");
  assert.equal(state.mergeDecisions[0].same_votes, 1);
  assert.equal(state.mergeDecisions[0].different_votes, 1);
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
