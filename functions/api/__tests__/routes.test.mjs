import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as correctionsOnRequest } from "../corrections.js";
import { onRequest as adminExportOnRequest } from "../admin/export.js";
import { onRequest as adminGroupsOnRequest } from "../admin/groups.js";
import { onRequest as adminReviewOnRequest } from "../admin/review.js";
import { onRequest as adminGroupMembershipOnRequest } from "../admin/group-membership.js";
import { onRequest as adminSessionOnRequest } from "../admin/session.js";
import { onRequest as configOnRequest } from "../config.js";
import { onRequest as communityCandidatesOnRequest } from "../community-candidates.js";
import { onRequest as groupReviewVotesOnRequest } from "../group-review-votes.js";
import { onRequest as mergesOnRequest } from "../merges.js";
import { onRequest as previewUrlOnRequest } from "../preview-url.js";
import { onRequest as reviewStateOnRequest } from "../review-state.js";
import { onRequest as zoomifyOnRequest } from "../zoomify.js";
import { onRequest as verifyOnRequest } from "../verify.js";
import { recordOperation } from "../_operations.js";
import { FakeD1, makePhotosAsset, makeRequest } from "./test-helpers.mjs";

function makeEnv(overrides = {}) {
  return {
    CORRECTIONS_DB: new FakeD1(),
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    ADMIN_API_TOKEN: "admin-test-token",
    COMMUNITY_DATA_VERSION: "test-data-v1",
    ASSETS: makePhotosAsset([
      {
        properties: {
          id: "A1",
          group_id: "group-a",
        },
      },
      {
        properties: {
          id: "A2",
          group_id: "group-b",
        },
      },
      {
        properties: {
          id: "X1",
          group_id: "G1",
        },
      },
    ]),
    ...overrides,
  };
}

function makeCommunityAssets(features, similarityPairs = [], clusters = []) {
  return {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      let payload;
      if (path.endsWith("/photos.geojson")) {
        payload = { type: "FeatureCollection", features };
      } else if (path.endsWith("/orphan_xids.json")) {
        payload = { xids: [] };
      } else if (path.endsWith("/similarity_candidates.json")) {
        payload = { pairs: similarityPairs };
      } else if (path.endsWith("/series_version_clusters.json")) {
        payload = { clusters };
      } else if (path.endsWith("/community-data-version.json")) {
        payload = { version: "test-data-v1" };
      } else {
        return new Response("Not found", { status: 404 });
      }
      return new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

function candidateFeature(id, groupId) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [14.4, 50.1] },
    properties: { id, group_id: groupId, signature: id },
  };
}

test("POST /api/verify rejects cross-origin requests", async () => {
  const env = makeEnv();
  const request = makeRequest("/api/verify", {
    headers: { Origin: "https://evil.example" },
    jsonBody: { token: "ok" },
  });
  const response = await verifyOnRequest({ request, env });
  assert.equal(response.status, 403);
});

test("POST /api/verify enforces rate limit with Retry-After", async () => {
  const env = makeEnv({ API_RATE_LIMIT_VERIFY_MAX: "1" });
  const request = makeRequest("/api/verify", {
    headers: {
      Origin: "https://example.com",
      "CF-Connecting-IP": "8.8.8.8",
    },
    jsonBody: { token: "ok" },
  });
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          hostname: "example.com",
          action: "session_verify",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const first = await verifyOnRequest({ request, env });
    assert.equal(first.status, 200);

    const second = await verifyOnRequest({ request, env });
    assert.equal(second.status, 429);
    assert.equal(typeof second.headers.get("Retry-After"), "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/verify rejects invalid Turnstile hostname", async () => {
  const env = makeEnv();
  const request = makeRequest("/api/verify", {
    headers: { Origin: "https://example.com" },
    jsonBody: { token: "ok" },
  });
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          hostname: "evil.example",
          action: "session_verify",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const response = await verifyOnRequest({ request, env });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.match(String(payload.detail || ""), /hostname/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/corrections rejects invalid Turnstile action", async () => {
  const env = makeEnv();
  const request = makeRequest("/api/corrections", {
    headers: { Origin: "https://example.com" },
    jsonBody: {
      xid: "A1",
      lat: 50.087,
      lon: 14.421,
      verdict: "wrong",
      token: "ok",
    },
  });
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          hostname: "example.com",
          action: "session_verify",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const response = await correctionsOnRequest({ request, env });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.match(String(payload.detail || ""), /akce/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/corrections accepts same-origin with valid token", async () => {
  const env = makeEnv();
  const request = makeRequest("/api/corrections", {
    headers: { Origin: "https://example.com" },
    jsonBody: {
      xid: "A1",
      lat: 50.087,
      lon: 14.421,
      verdict: "wrong",
      token: "ok",
    },
  });
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          hostname: "example.com",
          action: "corrections_submit",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const response = await correctionsOnRequest({ request, env });
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/corrections accepts same-origin with valid session cookie", async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          hostname: "example.com",
          action: "session_verify",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const verifyRequest = makeRequest("/api/verify", {
      headers: { Origin: "https://example.com" },
      jsonBody: { token: "ok" },
    });
    const verifyResponse = await verifyOnRequest({ request: verifyRequest, env });
    assert.equal(verifyResponse.status, 200);

    const cookie = String(verifyResponse.headers.get("Set-Cookie") || "").split(";")[0];
    const correctionRequest = makeRequest("/api/corrections", {
      headers: { Origin: "https://example.com", Cookie: cookie },
      jsonBody: {
        xid: "A1",
        lat: 50.087,
        lon: 14.421,
        verdict: "wrong",
      },
    });

    const correctionResponse = await correctionsOnRequest({
      request: correctionRequest,
      env,
    });
    assert.equal(correctionResponse.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/corrections accepts the resolved root for a merged group", async () => {
  const env = makeEnv({ TURNSTILE_BYPASS: "1" });
  env.CORRECTIONS_DB.merges.push(
    {
      id: 1,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "merge-voter-a",
      created_at: "2026-01-01 00:00:00",
    },
    {
      id: 2,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "merge-voter-b",
      created_at: "2026-01-01 00:01:00",
    },
  );
  const request = makeRequest("/api/corrections", {
    host: "localhost",
    protocol: "http:",
    jsonBody: {
      xid: "A2",
      group_id: "group-a",
      verdict: "ok",
      location_revision: '["group-a",null]',
    },
  });

  const response = await correctionsOnRequest({ request, env });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.accepted_group_id, "group-a");
  assert.equal(env.CORRECTIONS_DB.corrections.length, 1);
  assert.equal(env.CORRECTIONS_DB.corrections[0].group_id, "group-b");
});

test("POST /api/corrections binds OK to the displayed location proposal", async () => {
  const env = makeEnv({ TURNSTILE_BYPASS: "1" });
  env.CORRECTIONS_DB.corrections.push({
    id: 1,
    xid: "A1",
    group_id: "group-a",
    lat: 50.087,
    lon: 14.421,
    has_coordinates: 1,
    voter_key: "proposal-author",
    verdict: "wrong",
    created_at: "2026-01-01 00:00:00",
  });

  const missingRevision = await correctionsOnRequest({
    request: makeRequest("/api/corrections", {
      host: "localhost",
      protocol: "http:",
      jsonBody: { xid: "A1", group_id: "group-a", verdict: "ok" },
    }),
    env,
  });
  assert.equal(missingRevision.status, 400);
  assert.equal(env.CORRECTIONS_DB.corrections.length, 1);

  const accepted = await correctionsOnRequest({
    request: makeRequest("/api/corrections", {
      host: "localhost",
      protocol: "http:",
      jsonBody: {
        xid: "A1",
        group_id: "group-a",
        verdict: "ok",
        location_revision: '["group-a","1"]',
        proposal_id: "1",
      },
    }),
    env,
  });
  assert.equal(accepted.status, 200);
  assert.equal(env.CORRECTIONS_DB.corrections.length, 2);

  env.CORRECTIONS_DB.corrections.push({
    id: 3,
    xid: "A1",
    group_id: "group-a",
    lat: 50.09,
    lon: 14.43,
    has_coordinates: 1,
    voter_key: "new-proposal-author",
    verdict: "wrong",
    created_at: "2026-01-01 00:02:00",
  });
  const stale = await correctionsOnRequest({
    request: makeRequest("/api/corrections", {
      host: "localhost",
      protocol: "http:",
      jsonBody: {
        xid: "A1",
        group_id: "group-a",
        verdict: "ok",
        location_revision: '["group-a","1"]',
        proposal_id: "1",
      },
    }),
    env,
  });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).detail, /mezitím změnila/u);
  assert.equal(env.CORRECTIONS_DB.corrections.length, 3);
});

test("GET /api/review-state fails closed when merge state cannot be read", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.failAllMatching(
    "from merge_decisions",
    new Error("D1 unavailable"),
  );
  const request = makeRequest("/api/review-state", { method: "GET" });

  const response = await reviewStateOnRequest({
    request,
    env,
    waitUntil() {},
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("GET /api/review-state omits contributor fingerprints", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.merges.push({
    id: 1,
    group_id_a: "group-a",
    group_id_b: "group-b",
    verdict: "different",
    voter_key: "private-voter-key",
    user_agent: "private-user-agent",
    created_at: "2026-01-01 00:00:00",
  });
  const request = makeRequest("/api/review-state?fresh=1", { method: "GET" });

  const response = await reviewStateOnRequest({
    request,
    env,
    waitUntil() {},
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.mergeDecisions.length, 1);
  assert.equal("voter_key" in payload.mergeDecisions[0], false);
  assert.equal("user_agent" in payload.mergeDecisions[0], false);
});

test("GET /api/review-state serves a current materialized projection", async () => {
  const env = makeEnv();
  const projectedPayload = {
    reviewStateSchemaVersion: 3,
    groupCorrections: [],
    doneGroupIds: ["group-a"],
    resolvedGroupByXid: { A1: "group-a" },
    groupRoots: { "group-a": "group-a" },
    mergeDecisions: [],
    counts: { doneGroups: 1 },
  };
  env.CORRECTIONS_DB.communityProjection = {
    current_revision: 4,
    computed_revision: 4,
    data_version: "test-data-v1",
    payload_json: JSON.stringify(projectedPayload),
  };
  env.CORRECTIONS_DB.failAllMatching(
    "from corrections",
    new Error("history should not be scanned"),
  );

  const request = makeRequest("/api/review-state", { method: "GET" });
  const response = await reviewStateOnRequest({ request, env });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), projectedPayload);
});

test("GET /api/review-state rebuilds a projection from an older state schema", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.communityProjection = {
    current_revision: 4,
    computed_revision: 4,
    data_version: "test-data-v1",
    payload_json: JSON.stringify({
      doneGroupIds: ["stale-group"],
      resolvedGroupByXid: { A1: "stale-group" },
    }),
  };

  const response = await reviewStateOnRequest({
    request: makeRequest("/api/review-state", { method: "GET" }),
    env,
    waitUntil() {},
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.reviewStateSchemaVersion, 3);
  assert.notDeepEqual(payload.doneGroupIds, ["stale-group"]);
  assert.equal(payload.resolvedGroupByXid.A1, "group-a");
});

test("GET /api/review-state does not cache a rebuild that lost a revision race", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.communityProjection = {
    current_revision: 4,
    computed_revision: 3,
    data_version: "test-data-v1",
    payload_json: null,
  };
  env.CORRECTIONS_DB.projectionUpdateChanges = 0;

  const response = await reviewStateOnRequest({
    request: makeRequest("/api/review-state", { method: "GET" }),
    env,
    waitUntil() {},
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Community-Revision-Stable"), "0");
});

test("GET /api/review-state invalidates projections with an older asset manifest", async () => {
  const env = makeEnv({ COMMUNITY_DATA_VERSION: "" });
  env.CORRECTIONS_DB.communityProjection = {
    current_revision: 4,
    computed_revision: 4,
    data_version: "old-static-data",
    payload_json: JSON.stringify({ doneGroupIds: ["stale-group"] }),
  };

  const response = await reviewStateOnRequest({
    request: makeRequest("/api/review-state", { method: "GET" }),
    env,
    waitUntil() {},
  });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("X-Community-Data-Version"),
    "test-data-v1",
  );
  assert.notDeepEqual((await response.json()).doneGroupIds, ["stale-group"]);
});

test("GET /api/review-state fails closed without a nonempty data version", async () => {
  const env = makeEnv({
    COMMUNITY_DATA_VERSION: "",
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  });
  const response = await reviewStateOnRequest({
    request: makeRequest("/api/review-state", { method: "GET" }),
    env,
    waitUntil() {},
  });
  assert.equal(response.status, 503);
});

test("GET /api/community-candidates returns bounded authoritative group pages", async () => {
  const features = [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [14.4, 50.1] },
      properties: { id: "A1", group_id: "group-a", signature: "A1" },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [14.4, 50.1] },
      properties: { id: "A2", group_id: "group-b", signature: "A2" },
    },
  ];
  const env = makeEnv({ ASSETS: makeCommunityAssets(features) });
  env.CORRECTIONS_DB.groupMembershipOverrides.set("A2", {
    xid: "A2",
    group_id: "group-a",
    source_group_id: "group-b",
    revision: 1,
  });

  const response = await communityCandidatesOnRequest({
    request: makeRequest("/api/community-candidates?flow=group&limit=1", {
      method: "GET",
    }),
    env,
    waitUntil() {},
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].items.length, 2);
  assert.equal(payload.items[0].id, "group-a");
  assert.deepEqual(
    payload.items[0].items[0].properties.original_coordinates,
    [14.4, 50.1],
  );
});

test("GET /api/community-candidates binds cursors to the state revision", async () => {
  const features = [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [14.4, 50.1] },
      properties: { id: "A1", group_id: "group-a" },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [14.5, 50.2] },
      properties: { id: "A2", group_id: "group-b" },
    },
  ];
  const env = makeEnv({ ASSETS: makeCommunityAssets(features) });
  env.CORRECTIONS_DB.communityProjection = {
    current_revision: 4,
    computed_revision: 3,
    data_version: "test-data-v1",
    payload_json: null,
  };
  const first = await communityCandidatesOnRequest({
    request: makeRequest(
      "/api/community-candidates?flow=location&limit=1",
      { method: "GET" },
    ),
    env,
    waitUntil() {},
  });
  const firstPayload = await first.json();
  assert.match(firstPayload.cursor, /^v[A-Za-z0-9_-]+:r4:0$/u);
  assert.match(firstPayload.nextCursor, /^v[A-Za-z0-9_-]+:r4:1$/u);

  env.CORRECTIONS_DB.communityProjection = {
    current_revision: 5,
    computed_revision: 4,
    data_version: "test-data-v1",
    payload_json: null,
  };
  const stale = await communityCandidatesOnRequest({
    request: makeRequest(
      `/api/community-candidates?flow=location&limit=1&cursor=${encodeURIComponent(firstPayload.nextCursor)}`,
      { method: "GET" },
    ),
    env,
    waitUntil() {},
  });
  assert.equal(stale.status, 409);
});

test("GET /api/community-candidates uses a current projection without history scans", async () => {
  const features = [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [14.4, 50.1] },
      properties: { id: "A1", group_id: "group-a" },
    },
  ];
  const env = makeEnv({ ASSETS: makeCommunityAssets(features) });
  env.CORRECTIONS_DB.communityProjection = {
    current_revision: 8,
    computed_revision: 8,
    data_version: "test-data-v1",
    payload_json: JSON.stringify({
      reviewStateSchemaVersion: 3,
      resolvedGroupByXid: { A1: "group-a" },
      groupRoots: { "group-a": "group-a" },
      groupCorrections: [],
      doneGroupIds: [],
      mergeDecisions: [],
    }),
  };
  env.CORRECTIONS_DB.failAllMatching(
    "from corrections",
    new Error("history should not be scanned"),
  );

  const response = await communityCandidatesOnRequest({
    request: makeRequest(
      "/api/community-candidates?flow=location&limit=1",
      { method: "GET" },
    ),
    env,
    waitUntil() {},
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.match(payload.cursor, /^v[A-Za-z0-9_-]+:r8:0$/u);
  assert.equal(payload.items[0].id, "group-a");
});

test("GET /api/community-candidates binds cursors to the static data version", async () => {
  const env = makeEnv({
    ASSETS: makeCommunityAssets([
      candidateFeature("A1", "group-a"),
      candidateFeature("A2", "group-b"),
    ]),
  });
  const first = await communityCandidatesOnRequest({
    request: makeRequest(
      "/api/community-candidates?flow=location&limit=1",
      { method: "GET" },
    ),
    env,
    waitUntil() {},
  });
  const cursor = (await first.json()).nextCursor;
  assert.ok(cursor);

  env.COMMUNITY_DATA_VERSION = "test-data-v2";
  const stale = await communityCandidatesOnRequest({
    request: makeRequest(
      `/api/community-candidates?flow=location&limit=1&cursor=${encodeURIComponent(cursor)}`,
      { method: "GET" },
    ),
    env,
    waitUntil() {},
  });
  assert.equal(stale.status, 409);
});

test("GET /api/community-candidates rejects unknown duplicate focus groups", async () => {
  const env = makeEnv({
    ASSETS: makeCommunityAssets([
      candidateFeature("A1", "group-a"),
      candidateFeature("A2", "group-b"),
    ]),
  });
  const response = await communityCandidatesOnRequest({
    request: makeRequest(
      "/api/community-candidates?flow=duplicate&group_id=attacker-value",
      { method: "GET" },
    ),
    env,
    waitUntil() {},
  });
  assert.equal(response.status, 400);
});

test("GET /api/community-candidates focuses a location review on the exact current root", async () => {
  const env = makeEnv({
    ASSETS: makeCommunityAssets([
      candidateFeature("A1", "group-a"),
      candidateFeature("A2", "group-b"),
    ]),
  });
  env.CORRECTIONS_DB.merges.push(
    {
      id: 1,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "focus-voter-a",
      created_at: "2026-01-01 09:00:00",
    },
    {
      id: 2,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "focus-voter-b",
      created_at: "2026-01-01 09:01:00",
    },
  );

  const response = await communityCandidatesOnRequest({
    request: makeRequest(
      "/api/community-candidates?flow=location&group_id=group-b",
      { method: "GET" },
    ),
    env,
    waitUntil() {},
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.total, 1);
  assert.equal(payload.items[0].id, "group-a");

  const unknown = await communityCandidatesOnRequest({
    request: makeRequest(
      "/api/community-candidates?flow=location&group_id=ghost-group",
      { method: "GET" },
    ),
    env,
    waitUntil() {},
  });
  assert.equal(unknown.status, 400);
});

test("GET /api/community-candidates retries a transient required asset failure", async () => {
  let photoAttempts = 0;
  const features = [candidateFeature("A1", "group-a")];
  const assets = {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/photos.geojson")) {
        photoAttempts += 1;
        if (photoAttempts === 1) {
          return new Response("Temporary failure", { status: 503 });
        }
        return new Response(JSON.stringify({
          type: "FeatureCollection",
          features,
        }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    },
  };
  const env = makeEnv({ ASSETS: assets });
  env.CORRECTIONS_DB.communityProjection = {
    current_revision: 0,
    computed_revision: 0,
    data_version: "test-data-v1",
    payload_json: JSON.stringify({
      reviewStateSchemaVersion: 3,
      resolvedGroupByXid: { A1: "group-a" },
      groupRoots: { "group-a": "group-a" },
      groupCorrections: [],
      doneGroupIds: [],
      mergeDecisions: [],
    }),
  };
  const request = () => makeRequest(
    "/api/community-candidates?flow=location",
    { method: "GET" },
  );
  const first = await communityCandidatesOnRequest({
    request: request(), env, waitUntil() {},
  });
  const second = await communityCandidatesOnRequest({
    request: request(), env, waitUntil() {},
  });
  assert.equal(first.status, 503);
  assert.equal(second.status, 200);
  assert.equal(photoAttempts, 2);
});

test("GET /api/merges returns the authoritative anonymous consensus projection", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.merges.push(
    {
      id: 1,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "private-voter-a",
      user_agent: "private-agent-a",
      created_at: "2026-01-01 09:00:00",
    },
    {
      id: 2,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "private-voter-a",
      user_agent: "private-agent-a",
      created_at: "2026-01-01 09:01:00",
    },
    {
      id: 3,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "private-voter-b",
      user_agent: "private-agent-b",
      created_at: "2026-01-01 09:02:00",
    },
  );

  const response = await mergesOnRequest({
    request: makeRequest("/api/merges", { method: "GET" }),
    env,
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.count, 1);
  assert.deepEqual(payload.items[0], {
    group_id_a: "group-a",
    group_id_b: "group-b",
    verdict: "same",
    same_votes: 2,
    different_votes: 0,
    required_same_votes: 2,
    received_at: "2026-01-01 09:02:00",
  });
  assert.equal("voter_key" in payload.items[0], false);
  assert.equal("user_agent" in payload.items[0], false);
});

test("POST /api/merges accepts same-origin with valid session cookie", async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          hostname: "example.com",
          action: "session_verify",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const verifyRequest = makeRequest("/api/verify", {
      headers: { Origin: "https://example.com" },
      jsonBody: { token: "ok" },
    });
    const verifyResponse = await verifyOnRequest({ request: verifyRequest, env });
    assert.equal(verifyResponse.status, 200);

    const cookie = String(verifyResponse.headers.get("Set-Cookie") || "").split(";")[0];
    const mergeRequest = makeRequest("/api/merges", {
      headers: { Origin: "https://example.com", Cookie: cookie },
      jsonBody: {
        group_id_a: "group-a",
        group_id_b: "group-b",
        verdict: "same",
        candidate_revision: 0,
      },
    });

    const mergeResponse = await mergesOnRequest({ request: mergeRequest, env });
    assert.equal(mergeResponse.status, 200);
    assert.equal(env.CORRECTIONS_DB.merges.length, 1);
    assert.equal(env.CORRECTIONS_DB.merges[0].verdict, "same");
    assert.equal(
      typeof env.CORRECTIONS_DB.merges[0].voter_key,
      "string",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/merges accepts undo verdict", async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          hostname: "example.com",
          action: "session_verify",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const verifyRequest = makeRequest("/api/verify", {
      headers: { Origin: "https://example.com" },
      jsonBody: { token: "ok" },
    });
    const verifyResponse = await verifyOnRequest({ request: verifyRequest, env });
    assert.equal(verifyResponse.status, 200);

    const cookie = String(verifyResponse.headers.get("Set-Cookie") || "").split(";")[0];
    const mergeRequest = makeRequest("/api/merges", {
      headers: {
        Origin: "https://example.com",
        Cookie: cookie,
        "User-Agent": "route-test-agent",
      },
      jsonBody: {
        group_id_a: "group-a",
        group_id_b: "group-b",
        verdict: "undo",
      },
    });

    const mergeResponse = await mergesOnRequest({ request: mergeRequest, env });
    assert.equal(mergeResponse.status, 200);
    assert.equal(env.CORRECTIONS_DB.merges.length, 1);
    assert.equal(env.CORRECTIONS_DB.merges[0].verdict, "undo");
    assert.equal(env.CORRECTIONS_DB.merges[0].user_agent, "route-test-agent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/merges can undo a pair that currently resolves to one root", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.merges.push(
    {
      id: 1,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "first-voter",
      created_at: "2026-01-01 09:00:00",
    },
    {
      id: 2,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "second-voter",
      created_at: "2026-01-01 09:01:00",
    },
  );
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      success: true,
      hostname: "example.com",
      action: "merges_submit",
    }), { headers: { "Content-Type": "application/json" } });
    const response = await mergesOnRequest({
      request: makeRequest("/api/merges", {
        headers: { Origin: "https://example.com" },
        jsonBody: {
          group_id_a: "group-a",
          group_id_b: "group-b",
          verdict: "undo",
          token: "ok",
        },
      }),
      env,
    });
    assert.equal(response.status, 200);
    assert.equal(env.CORRECTIONS_DB.merges.at(-1).verdict, "undo");
    assert.equal(env.CORRECTIONS_DB.merges.at(-1).group_id_a, "group-a");
    assert.equal(env.CORRECTIONS_DB.merges.at(-1).group_id_b, "group-b");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/merges allows a voter to mark the exact consensus pair different", async () => {
  const env = makeEnv({ TURNSTILE_BYPASS: "1" });
  const postDecision = (verdict, cookie = "") =>
    mergesOnRequest({
      request: makeRequest("/api/merges", {
        host: "localhost",
        protocol: "http:",
        headers: cookie ? { Cookie: cookie } : {},
        jsonBody: {
          group_id_a: "group-a",
          group_id_b: "group-b",
          verdict,
          candidate_revision: 0,
        },
      }),
      env,
      waitUntil() {},
    });

  const first = await postDecision("same");
  assert.equal(first.status, 200);
  const firstCookie = String(first.headers.get("Set-Cookie") || "").split(";")[0];
  assert.ok(firstCookie);

  const second = await postDecision("same");
  assert.equal(second.status, 200);

  const contrary = await postDecision("different", firstCookie);
  assert.equal(contrary.status, 200);
  assert.deepEqual((await contrary.json()).decision, {
    group_id_a: "group-a",
    group_id_b: "group-b",
    verdict: "different",
  });

  const stateResponse = await reviewStateOnRequest({
    request: makeRequest("/api/review-state?fresh=1", {
      method: "GET",
      host: "localhost",
      protocol: "http:",
    }),
    env,
    waitUntil() {},
  });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.groupRoots["group-a"], "group-a");
  assert.equal(state.groupRoots["group-b"], "group-b");
  assert.equal(state.mergeDecisions[0].same_votes, 1);
  assert.equal(state.mergeDecisions[0].different_votes, 1);
});

test("POST /api/merges keeps an undo on the exact historical pair", async () => {
  const env = makeEnv({
    ASSETS: makePhotosAsset([
      { properties: { id: "A1", group_id: "group-a" } },
      { properties: { id: "B1", group_id: "group-b" } },
      { properties: { id: "C1", group_id: "group-c" } },
    ]),
  });
  env.CORRECTIONS_DB.merges.push(
    {
      id: 1,
      group_id_a: "group-b",
      group_id_b: "group-c",
      verdict: "different",
      voter_key: "first-voter",
      created_at: "2026-01-01 09:00:00",
    },
    {
      id: 2,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "second-voter",
      created_at: "2026-01-01 09:01:00",
    },
  );
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      success: true,
      hostname: "example.com",
      action: "merges_submit",
    }), { headers: { "Content-Type": "application/json" } });
    const response = await mergesOnRequest({
      request: makeRequest("/api/merges", {
        headers: { Origin: "https://example.com" },
        jsonBody: {
          group_id_a: "group-b",
          group_id_b: "group-c",
          verdict: "undo",
          token: "ok",
        },
      }),
      env,
    });

    assert.equal(response.status, 200);
    assert.equal(env.CORRECTIONS_DB.merges.at(-1).group_id_a, "group-b");
    assert.equal(env.CORRECTIONS_DB.merges.at(-1).group_id_b, "group-c");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/merges rejects missing or stale candidate revisions before remapping roots", async () => {
  const env = makeEnv({ TURNSTILE_BYPASS: "1" });
  env.CORRECTIONS_DB.communityProjection = {
    current_revision: 7,
    computed_revision: 7,
    data_version: "test-data-v1",
    payload_json: JSON.stringify({
      reviewStateSchemaVersion: 3,
      resolvedGroupByXid: {
        A1: "group-a",
        A2: "group-b",
        X1: "G1",
      },
      groupRoots: {
        "group-a": "group-a",
        "group-b": "group-b",
        G1: "G1",
      },
      groupCorrections: [],
      doneGroupIds: [],
      mergeDecisions: [],
    }),
  };

  for (const verdict of ["same", "different"]) {
    const missing = await mergesOnRequest({
      request: makeRequest("/api/merges", {
        host: "localhost",
        protocol: "http:",
        jsonBody: {
          group_id_a: "group-a",
          group_id_b: "group-b",
          verdict,
        },
      }),
      env,
      waitUntil() {},
    });
    assert.equal(missing.status, 400);

    const stale = await mergesOnRequest({
      request: makeRequest("/api/merges", {
        host: "localhost",
        protocol: "http:",
        jsonBody: {
          group_id_a: "group-a",
          group_id_b: "group-b",
          verdict,
          candidate_revision: 6,
        },
      }),
      env,
      waitUntil() {},
    });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).detail, /mezitím změnila/u);
  }
  assert.equal(env.CORRECTIONS_DB.merges.length, 0);
});

test("POST /api/merges rejects a revision that changes during the guarded insert", async () => {
  const env = makeEnv({ TURNSTILE_BYPASS: "1" });
  env.CORRECTIONS_DB.communityProjection = {
    current_revision: 7,
    computed_revision: 7,
    data_version: "test-data-v1",
    payload_json: JSON.stringify({
      reviewStateSchemaVersion: 3,
      resolvedGroupByXid: {
        A1: "group-a",
        A2: "group-b",
      },
      groupRoots: {
        "group-a": "group-a",
        "group-b": "group-b",
      },
      groupCorrections: [],
      doneGroupIds: [],
      mergeDecisions: [],
    }),
  };
  env.CORRECTIONS_DB.beforeMergeInsert = (db) => {
    db.communityProjection.current_revision = 8;
  };

  const response = await mergesOnRequest({
    request: makeRequest("/api/merges", {
      host: "localhost",
      protocol: "http:",
      jsonBody: {
        group_id_a: "group-a",
        group_id_b: "group-b",
        verdict: "same",
        candidate_revision: 7,
      },
    }),
    env,
    waitUntil() {},
  });

  assert.equal(response.status, 409);
  assert.match((await response.json()).detail, /mezitím změnila/u);
  assert.equal(env.CORRECTIONS_DB.merges.length, 0);
});

test("POST /api/merges keeps the guarded legacy-column fallback", async () => {
  const env = makeEnv({ TURNSTILE_BYPASS: "1" });
  env.CORRECTIONS_DB.communityProjection = {
    current_revision: 7,
    computed_revision: 7,
    data_version: "test-data-v1",
    payload_json: JSON.stringify({
      reviewStateSchemaVersion: 3,
      resolvedGroupByXid: {
        A1: "group-a",
        A2: "group-b",
      },
      groupRoots: {
        "group-a": "group-a",
        "group-b": "group-b",
      },
      groupCorrections: [],
      doneGroupIds: [],
      mergeDecisions: [],
    }),
  };
  env.CORRECTIONS_DB.mergeAuditColumnsMissing = true;

  const response = await mergesOnRequest({
    request: makeRequest("/api/merges", {
      host: "localhost",
      protocol: "http:",
      jsonBody: {
        group_id_a: "group-a",
        group_id_b: "group-b",
        verdict: "same",
        candidate_revision: 7,
      },
    }),
    env,
    waitUntil() {},
  });

  assert.equal(response.status, 200);
  assert.equal(env.CORRECTIONS_DB.merges.length, 1);
  assert.equal(env.CORRECTIONS_DB.merges[0].voter_key, "");
  assert.equal(env.CORRECTIONS_DB.merges[0].user_agent, "");
});

test("POST /api/merges rejects unknown group ids", async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          hostname: "example.com",
          action: "session_verify",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const verifyRequest = makeRequest("/api/verify", {
      headers: { Origin: "https://example.com" },
      jsonBody: { token: "ok" },
    });
    const verifyResponse = await verifyOnRequest({ request: verifyRequest, env });
    assert.equal(verifyResponse.status, 200);

    const cookie = String(verifyResponse.headers.get("Set-Cookie") || "").split(";")[0];
    const mergeRequest = makeRequest("/api/merges", {
      headers: { Origin: "https://example.com", Cookie: cookie },
      jsonBody: {
        group_id_a: "group-a",
        group_id_b: "ghost-group",
        verdict: "same",
        candidate_revision: 0,
      },
    });

    const mergeResponse = await mergesOnRequest({ request: mergeRequest, env });
    assert.equal(mergeResponse.status, 400);
    const payload = await mergeResponse.json();
    assert.match(String(payload.detail || ""), /skupina/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/merges accepts an authoritative root after all members move", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.merges.push(
    {
      id: 1,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "merge-voter-a",
      created_at: "2026-01-01 09:00:00",
    },
    {
      id: 2,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "merge-voter-b",
      created_at: "2026-01-01 09:01:00",
    },
  );
  env.CORRECTIONS_DB.groupMembershipOverrides.set("A1", {
    xid: "A1",
    group_id: "G1",
    source_group_id: "group-a",
    revision: 1,
  });
  env.CORRECTIONS_DB.groupMembershipOverrides.set("A2", {
    xid: "A2",
    group_id: "G1",
    source_group_id: "group-b",
    revision: 1,
  });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      success: true,
      hostname: "example.com",
      action: "merges_submit",
    }), { headers: { "Content-Type": "application/json" } });
    const response = await mergesOnRequest({
      request: makeRequest("/api/merges", {
        headers: { Origin: "https://example.com" },
        jsonBody: {
          group_id_a: "group-a",
          group_id_b: "G1",
          verdict: "different",
          candidate_revision: 0,
          token: "ok",
        },
      }),
      env,
    });
    assert.equal(response.status, 200);
    assert.equal(env.CORRECTIONS_DB.merges.at(-1).group_id_a, "G1");
    assert.equal(env.CORRECTIONS_DB.merges.at(-1).group_id_b, "group-a");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/group-review-votes accepts same-origin with valid token", async () => {
  const env = makeEnv();
  const request = makeRequest("/api/group-review-votes", {
    headers: {
      Origin: "https://example.com",
      "CF-Connecting-IP": "3.3.3.3",
    },
    jsonBody: {
      group_id: "group-a",
      verdict: "ok",
      token: "ok",
    },
  });
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          hostname: "example.com",
          action: "group_review_submit",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const response = await groupReviewVotesOnRequest({ request, env });
    assert.equal(response.status, 200);
    assert.equal(env.CORRECTIONS_DB.groupReviewVotes.length, 1);
    assert.equal(env.CORRECTIONS_DB.groupReviewVotes[0].group_id, "group-a");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /api/group-review-votes aggregates ok votes and current user state", async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          hostname: "example.com",
          action: "group_review_submit",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const firstVoteRequest = makeRequest("/api/group-review-votes", {
      headers: {
        Origin: "https://example.com",
        "CF-Connecting-IP": "3.3.3.3",
      },
      jsonBody: {
        group_id: "group-a",
        verdict: "ok",
        token: "ok",
      },
    });
    const secondVoteRequest = makeRequest("/api/group-review-votes", {
      headers: {
        Origin: "https://example.com",
        "CF-Connecting-IP": "4.4.4.4",
      },
      jsonBody: {
        group_id: "group-a",
        verdict: "ok",
        token: "ok",
      },
    });

    const firstVoteResponse = await groupReviewVotesOnRequest({
      request: firstVoteRequest,
      env,
    });
    assert.equal(firstVoteResponse.status, 200);
    const voterCookieMatch = String(
      firstVoteResponse.headers.get("Set-Cookie") || "",
    ).match(/opp_voter_id=[^;,]+/u);
    assert.ok(voterCookieMatch);
    assert.equal(
      (await groupReviewVotesOnRequest({ request: secondVoteRequest, env })).status,
      200,
    );

    const getRequest = makeRequest("/api/group-review-votes", {
      method: "GET",
      headers: {
        Cookie: voterCookieMatch[0],
        "CF-Connecting-IP": "3.3.3.3",
      },
    });
    const response = await groupReviewVotesOnRequest({ request: getRequest, env });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.count, 1);
    assert.equal(payload.items[0].group_id, "group-a");
    assert.equal(payload.items[0].ok_votes, 2);
    assert.equal(payload.items[0].done, true);
    assert.equal(payload.items[0].current_user_voted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /api/group-review-votes promotes independent split proposals", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.groupReviewVotes.push(
    {
      id: 1,
      group_id: "group-a",
      verdict: "split",
      voter_key: "voter-a",
      created_at: "2026-01-01 10:00:00",
    },
    {
      id: 2,
      group_id: "group-a",
      verdict: "split",
      voter_key: "voter-b",
      created_at: "2026-01-01 10:01:00",
    },
  );
  const request = makeRequest("/api/group-review-votes", { method: "GET" });
  const response = await groupReviewVotesOnRequest({ request, env });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.items[0].split_votes, 2);
  assert.equal(payload.items[0].needs_split, true);
  assert.equal(payload.items[0].done, false);
});

test("GET /api/group-review-votes keeps constituent votes after groups merge", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.merges.push(
    {
      id: 1,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "merge-voter-a",
      created_at: "2026-01-01 09:00:00",
    },
    {
      id: 2,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "merge-voter-b",
      created_at: "2026-01-01 09:01:00",
    },
  );
  env.CORRECTIONS_DB.groupReviewVotes.push(
    {
      id: 1,
      group_id: "group-a",
      verdict: "ok",
      voter_key: "voter-a",
      created_at: "2026-01-01 10:00:00",
    },
    {
      id: 2,
      group_id: "group-b",
      verdict: "ok",
      voter_key: "voter-b",
      created_at: "2026-01-01 10:01:00",
    },
  );

  const response = await groupReviewVotesOnRequest({
    request: makeRequest("/api/group-review-votes", { method: "GET" }),
    env,
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.count, 1);
  assert.equal(payload.items[0].group_id, "group-a");
  assert.equal(payload.items[0].ok_votes, 2);
  assert.equal(payload.items[0].done, true);
});

test("POST /api/group-review-votes stores the current merged root", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.merges.push(
    {
      id: 1,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "merge-voter-a",
      created_at: "2026-01-01 09:00:00",
    },
    {
      id: 2,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "merge-voter-b",
      created_at: "2026-01-01 09:01:00",
    },
  );
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      success: true,
      hostname: "example.com",
      action: "group_review_submit",
    }), { headers: { "Content-Type": "application/json" } });
    const response = await groupReviewVotesOnRequest({
      request: makeRequest("/api/group-review-votes", {
        headers: { Origin: "https://example.com" },
        jsonBody: {
          group_id: "group-b",
          verdict: "ok",
          token: "ok",
        },
      }),
      env,
    });
    assert.equal(response.status, 200);
    assert.equal(env.CORRECTIONS_DB.groupReviewVotes[0].group_id, "group-a");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /api/group-review-votes fails closed when votes cannot be read", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.failAllMatching(
    "from current_group_review_votes",
    new Error("D1 unavailable"),
  );
  const request = makeRequest("/api/group-review-votes", { method: "GET" });

  const response = await groupReviewVotesOnRequest({ request, env });
  assert.equal(response.status, 503);
});

test("POST /api/group-review-votes rejects unknown group ids", async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          hostname: "example.com",
          action: "group_review_submit",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const request = makeRequest("/api/group-review-votes", {
      headers: { Origin: "https://example.com" },
      jsonBody: {
        group_id: "ghost-group",
        verdict: "ok",
        token: "ok",
      },
    });

    const response = await groupReviewVotesOnRequest({ request, env });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.match(String(payload.detail || ""), /skupina/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /api/admin/review exposes pending corrections", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.corrections.push({
    id: 1,
    xid: "X1",
    group_id: "G1",
    lat: 50.1,
    lon: 14.4,
    has_coordinates: 1,
    voter_key: "voter-a",
    verdict: "wrong",
    created_at: "2026-01-01 10:00:00",
  });

  const request = makeRequest("/api/admin/review", {
    method: "GET",
    headers: { Authorization: "Bearer admin-test-token" },
  });
  const response = await adminReviewOnRequest({ request, env });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.counts.pendingCorrections, 1);
});

test("GET /api/admin/review includes visual evidence, votes, and membership history", async () => {
  const env = makeEnv({
    ASSETS: makePhotosAsset([
      {
        properties: {
          id: "A1",
          group_id: "group-a",
          description: "Old Town square",
          date_label: "1910",
          author: "Photographer",
          signature: "I 1",
          scan_previews: ["https://images.example/A1.jpg"],
        },
        geometry: { type: "Point", coordinates: [14.4, 50.1] },
      },
      {
        properties: { id: "A2", group_id: "group-a" },
        geometry: { type: "Point", coordinates: [14.41, 50.11] },
      },
    ]),
  });
  env.CORRECTIONS_DB.groupReviewVotes.push(
    {
      id: 1,
      group_id: "group-a",
      verdict: "split",
      voter_key: "voter-a",
      created_at: "2026-01-01 10:00:00",
    },
    {
      id: 2,
      group_id: "group-a",
      verdict: "split",
      voter_key: "voter-b",
      created_at: "2026-01-01 10:01:00",
    },
  );
  env.CORRECTIONS_DB.groupMembershipEvents.push({
    id: 3,
    source_group_id: "group-old",
    target_group_id: "group-a",
    assignments_json: JSON.stringify(["A1"]),
    reason: "Reassigned after review",
    curator: "admin-token",
    created_at: "2026-01-01 09:00:00",
  });

  const response = await adminReviewOnRequest({
    request: makeRequest("/api/admin/review", {
      method: "GET",
      headers: { Authorization: "Bearer admin-test-token" },
    }),
    env,
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.splitCandidates[0].vote_history.length, 2);
  assert.equal(payload.splitCandidates[0].members[0].description, "Old Town square");
  assert.equal(payload.splitCandidates[0].members[0].lat, 50.1);
  assert.deepEqual(payload.membershipHistory[0].xids, ["A1"]);
  assert.equal(payload.membershipHistory[0].reason, "Reassigned after review");
});

test("GET /api/admin/groups searches existing series without exposing the full catalog", async () => {
  const env = makeEnv({
    ASSETS: makePhotosAsset([
      {
        properties: {
          id: "A1",
          group_id: "group-a",
          description: "Old Town square",
        },
      },
      {
        properties: {
          id: "A2",
          group_id: "group-a",
          description: "Old Town hall",
        },
      },
      {
        properties: {
          id: "B1",
          group_id: "group-b",
          description: "New Town",
        },
      },
    ]),
  });
  const response = await adminGroupsOnRequest({
    request: makeRequest("/api/admin/groups?query=Old%20Town", {
      method: "GET",
      headers: { Authorization: "Bearer admin-test-token" },
    }),
    env,
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].group_id, "group-a");
  assert.equal(payload.items[0].member_count, 2);
});

test("GET /api/admin/review rejects unauthenticated requests", async () => {
  const env = makeEnv();
  const request = makeRequest("/api/admin/review", { method: "GET" });
  const response = await adminReviewOnRequest({ request, env });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("admin token is exchanged for an HttpOnly session cookie", async () => {
  const env = makeEnv();
  const login = await adminSessionOnRequest({
    request: makeRequest("/api/admin/session", {
      headers: { Origin: "https://example.com" },
      jsonBody: { token: "admin-test-token" },
    }),
    env,
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("Set-Cookie") || "";
  assert.match(setCookie, /^opp_admin_session=/u);
  assert.match(setCookie, /HttpOnly/u);
  assert.match(setCookie, /SameSite=Strict/u);
  assert.match(setCookie, /Secure/u);

  const cookie = setCookie.split(";", 1)[0];
  const review = await adminReviewOnRequest({
    request: makeRequest("/api/admin/review", {
      method: "GET",
      headers: { Cookie: cookie },
    }),
    env,
  });
  assert.equal(review.status, 200);

  const logout = await adminSessionOnRequest({
    request: makeRequest("/api/admin/session", {
      method: "DELETE",
      headers: { Origin: "https://example.com" },
    }),
    env,
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("Set-Cookie") || "", /Max-Age=0/u);
});

test("admin session rejects an invalid token and tampered cookie", async () => {
  const env = makeEnv();
  const login = await adminSessionOnRequest({
    request: makeRequest("/api/admin/session", {
      headers: { Origin: "https://example.com" },
      jsonBody: { token: "wrong-token" },
    }),
    env,
  });
  assert.equal(login.status, 401);

  const review = await adminReviewOnRequest({
    request: makeRequest("/api/admin/review", {
      method: "GET",
      headers: { Cookie: "opp_admin_session=v1.9999999999." + "0".repeat(64) },
    }),
    env,
  });
  assert.equal(review.status, 401);
});

test("operational diagnostics aggregate projection, activity, and continuity", async () => {
  const env = makeEnv();
  const now = new Date().toISOString();
  env.CORRECTIONS_DB.communityProjection = {
    current_revision: 7,
    computed_revision: 7,
    data_version: "test-data-v1",
    payload_json: "{}",
    updated_at: now,
  };
  env.CORRECTIONS_DB.corrections.push({
    id: 1,
    xid: "A1",
    group_id: "group-a",
    verdict: "ok",
    voter_key: "returning-voter",
    created_at: now,
  });
  env.CORRECTIONS_DB.operationMetrics.push({
    bucket_hour: now,
    metric: "candidate_page",
    flow: "location",
    status_code: 409,
    count: 2,
  });

  const response = await adminReviewOnRequest({
    request: makeRequest("/api/admin/review", {
      method: "GET",
      headers: { Authorization: "Bearer admin-test-token" },
    }),
    env,
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.operations.projection.current, true);
  assert.equal(payload.operations.submissions.accepted24h, 1);
  assert.equal(payload.operations.candidateRequests.staleCursors24h, 2);
  assert.equal(payload.operations.contributors.active30d, 1);
});

test("hourly operation counters are bounded and aggregated", async () => {
  const env = makeEnv();
  const pending = [];
  const context = {
    env,
    waitUntil(promise) {
      pending.push(promise);
    },
  };
  recordOperation(context, {
    metric: "submission",
    flow: "group",
    status: 503,
  });
  recordOperation(context, {
    metric: "submission",
    flow: "group",
    status: 503,
  });
  await Promise.all(pending);
  assert.equal(env.CORRECTIONS_DB.operationMetrics.length, 1);
  assert.equal(env.CORRECTIONS_DB.operationMetrics[0].count, 2);
});

test("POST /api/admin/group-membership atomically moves selected members", async () => {
  const env = makeEnv({
    ASSETS: makePhotosAsset([
      { properties: { id: "A1", group_id: "group-a" } },
      { properties: { id: "A2", group_id: "group-a" } },
    ]),
  });
  const request = makeRequest("/api/admin/group-membership", {
    headers: {
      Authorization: "Bearer admin-test-token",
      Origin: "https://example.com",
    },
    jsonBody: {
      source_group_id: "group-a",
      target_group_id: "series_curated_a",
      xids: ["A2"],
      reason: "Different viewpoint",
    },
  });

  const response = await adminGroupMembershipOnRequest({ request, env });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.moved_xids, ["A2"]);
  assert.equal(
    env.CORRECTIONS_DB.groupMembershipOverrides.get("A2").group_id,
    "series_curated_a",
  );
  assert.equal(env.CORRECTIONS_DB.groupMembershipEvents.length, 1);
});

test("curator can move an entire source group into an existing series", async () => {
  const env = makeEnv({
    ASSETS: makePhotosAsset([
      { properties: { id: "A1", group_id: "group-a" } },
      { properties: { id: "B1", group_id: "group-b" } },
    ]),
  });
  const response = await adminGroupMembershipOnRequest({
    request: makeRequest("/api/admin/group-membership", {
      headers: {
        Authorization: "Bearer admin-test-token",
        Origin: "https://example.com",
      },
      jsonBody: {
        source_group_id: "group-a",
        target_group_id: "group-b",
        xids: ["A1"],
        reason: "Undo mistaken split",
      },
    }),
    env,
  });
  assert.equal(response.status, 200);
  assert.equal(env.CORRECTIONS_DB.groupMembershipOverrides.get("A1").group_id, "group-b");
  assert.equal(env.CORRECTIONS_DB.groupMembershipEvents.length, 1);
});

test("curator membership move consumes review votes for an existing target", async () => {
  const env = makeEnv({
    ASSETS: makePhotosAsset([
      { properties: { id: "A1", group_id: "group-a" } },
      { properties: { id: "A2", group_id: "group-a" } },
      { properties: { id: "C1", group_id: "group-c" } },
    ]),
  });
  env.CORRECTIONS_DB.groupReviewVotes.push(
    {
      id: 1,
      group_id: "group-a",
      verdict: "split",
      voter_key: "voter-a",
      created_at: "2026-01-01 10:00:00",
    },
    {
      id: 2,
      group_id: "group-c",
      verdict: "ok",
      voter_key: "voter-c",
      created_at: "2026-01-01 10:01:00",
    },
  );

  const response = await adminGroupMembershipOnRequest({
    request: makeRequest("/api/admin/group-membership", {
      headers: {
        Authorization: "Bearer admin-test-token",
        Origin: "https://example.com",
      },
      jsonBody: {
        source_group_id: "group-a",
        target_group_id: "group-c",
        xids: ["A2"],
        reason: "Belongs with existing target",
      },
    }),
    env,
  });
  assert.equal(response.status, 200);
  assert.equal(env.CORRECTIONS_DB.groupReviewResolutions.get("group-a"), 1);
  assert.equal(env.CORRECTIONS_DB.groupReviewResolutions.get("group-c"), 2);
});

test("curator membership move rejects a target merged into the source root", async () => {
  const env = makeEnv({
    ASSETS: makePhotosAsset([
      { properties: { id: "A1", group_id: "group-a" } },
      { properties: { id: "A2", group_id: "group-a" } },
      { properties: { id: "B1", group_id: "group-b" } },
    ]),
  });
  env.CORRECTIONS_DB.merges.push(
    {
      id: 1,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "merge-voter-a",
      created_at: "2026-01-01 09:00:00",
    },
    {
      id: 2,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "merge-voter-b",
      created_at: "2026-01-01 09:01:00",
    },
  );

  const response = await adminGroupMembershipOnRequest({
    request: makeRequest("/api/admin/group-membership", {
      headers: {
        Authorization: "Bearer admin-test-token",
        Origin: "https://example.com",
      },
      jsonBody: {
        source_group_id: "group-a",
        target_group_id: "group-b",
        xids: ["A2"],
      },
    }),
    env,
  });
  assert.equal(response.status, 400);
  assert.equal(env.CORRECTIONS_DB.groupMembershipEvents.length, 0);
  assert.equal(env.CORRECTIONS_DB.groupMembershipOverrides.size, 0);
  assert.equal(env.CORRECTIONS_DB.groupReviewResolutions.size, 0);
});

test("curator membership split consumes the split votes that opened it", async () => {
  const env = makeEnv({
    ASSETS: makePhotosAsset([
      { properties: { id: "A1", group_id: "group-a" } },
      { properties: { id: "A2", group_id: "group-a" } },
    ]),
  });
  env.CORRECTIONS_DB.groupReviewVotes.push(
    {
      id: 1,
      group_id: "group-a",
      verdict: "split",
      voter_key: "voter-a",
      created_at: "2026-01-01 10:00:00",
    },
    {
      id: 2,
      group_id: "group-a",
      verdict: "split",
      voter_key: "voter-b",
      created_at: "2026-01-01 10:01:00",
    },
  );

  const adminHeaders = {
    Authorization: "Bearer admin-test-token",
    Origin: "https://example.com",
  };
  const reviewBefore = await adminReviewOnRequest({
    request: makeRequest("/api/admin/review", {
      method: "GET",
      headers: adminHeaders,
    }),
    env,
  });
  assert.equal((await reviewBefore.json()).counts.splitCandidates, 1);

  const resolution = await adminGroupMembershipOnRequest({
    request: makeRequest("/api/admin/group-membership", {
      headers: adminHeaders,
      jsonBody: {
        source_group_id: "group-a",
        target_group_id: "series_curated_a",
        xids: ["A2"],
        reason: "Different viewpoint",
      },
    }),
    env,
  });
  assert.equal(resolution.status, 200);

  const reviewAfter = await adminReviewOnRequest({
    request: makeRequest("/api/admin/review", {
      method: "GET",
      headers: adminHeaders,
    }),
    env,
  });
  assert.equal((await reviewAfter.json()).counts.splitCandidates, 0);

  env.CORRECTIONS_DB.groupReviewVotes.push({
    id: 3,
    group_id: "group-a",
    verdict: "split",
    voter_key: "voter-c",
    created_at: "2026-01-01 10:02:00",
  });
  const publicState = await groupReviewVotesOnRequest({
    request: makeRequest("/api/group-review-votes", { method: "GET" }),
    env,
  });
  const publicPayload = await publicState.json();
  assert.equal(publicPayload.items[0].split_votes, 1);
  assert.equal(publicPayload.items[0].needs_split, false);
});

test("curator can split members from a merged review root", async () => {
  const env = makeEnv({
    ASSETS: makePhotosAsset([
      { properties: { id: "A1", group_id: "group-a" } },
      { properties: { id: "B1", group_id: "group-b" } },
    ]),
  });
  env.CORRECTIONS_DB.merges.push(
    {
      id: 1,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "merge-voter-a",
      created_at: "2026-01-01 10:00:00",
    },
    {
      id: 2,
      group_id_a: "group-a",
      group_id_b: "group-b",
      verdict: "same",
      voter_key: "merge-voter-b",
      created_at: "2026-01-01 10:00:30",
    },
  );
  env.CORRECTIONS_DB.groupReviewVotes.push(
    {
      id: 1,
      group_id: "group-a",
      verdict: "split",
      voter_key: "voter-a",
      created_at: "2026-01-01 10:01:00",
    },
    {
      id: 2,
      group_id: "group-b",
      verdict: "split",
      voter_key: "voter-b",
      created_at: "2026-01-01 10:02:00",
    },
  );
  const headers = {
    Authorization: "Bearer admin-test-token",
    Origin: "https://example.com",
  };

  const reviewResponse = await adminReviewOnRequest({
    request: makeRequest("/api/admin/review", { method: "GET", headers }),
    env,
  });
  const reviewPayload = await reviewResponse.json();
  assert.deepEqual(reviewPayload.splitCandidates[0].xids, ["A1", "B1"]);

  const splitResponse = await adminGroupMembershipOnRequest({
    request: makeRequest("/api/admin/group-membership", {
      headers,
      jsonBody: {
        source_group_id: "group-a",
        target_group_id: "series_curated_merged",
        xids: ["B1"],
      },
    }),
    env,
  });
  assert.equal(splitResponse.status, 200);
  assert.equal(
    env.CORRECTIONS_DB.groupMembershipOverrides.get("B1").group_id,
    "series_curated_merged",
  );
  assert.equal(env.CORRECTIONS_DB.groupReviewResolutions.get("group-a"), 1);
  assert.equal(env.CORRECTIONS_DB.groupReviewResolutions.get("group-b"), 2);
});

test("GET /api/admin/review treats undo as merge-conflict reset", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.merges.push(
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
      verdict: "different",
      created_at: "2026-01-01 10:01:00",
    },
    {
      id: 3,
      group_id_a: "G1",
      group_id_b: "G2",
      verdict: "undo",
      created_at: "2026-01-01 10:02:00",
    },
  );

  const request = makeRequest("/api/admin/review", {
    method: "GET",
    headers: { Authorization: "Bearer admin-test-token" },
  });
  const response = await adminReviewOnRequest({ request, env });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.counts.mergeConflicts, 0);
});

test("GET /api/admin/export supports CSV output", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.corrections.push({
    id: 1,
    xid: "X1",
    group_id: "G1",
    lat: 50.1,
    lon: 14.4,
    has_coordinates: 1,
    voter_key: "voter-a",
    verdict: "wrong",
    message: "=HYPERLINK(\"https://evil.example\")",
    created_at: "2026-01-01 10:00:00",
  });

  const request = makeRequest("/api/admin/export?format=csv", {
    method: "GET",
    headers: { Authorization: "Bearer admin-test-token" },
  });
  const response = await adminExportOnRequest({ request, env });
  assert.equal(response.status, 200);
  assert.match(
    String(response.headers.get("Content-Type") || ""),
    /text\/csv/u,
  );
  const body = await response.text();
  assert.match(body, /record_type/u);
  assert.match(body, /correction/u);
  assert.match(body, /'=HYPERLINK/u);
});

test("GET /api/admin/export includes group review votes in JSON output", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.groupReviewVotes.push({
    id: 1,
    group_id: "group-a",
    verdict: "ok",
    voter_key: "voter-a",
    user_agent: "route-test-agent",
    created_at: "2026-01-01 10:00:00",
  });

  const request = makeRequest("/api/admin/export?format=json", {
    method: "GET",
    headers: { Authorization: "Bearer admin-test-token" },
  });
  const response = await adminExportOnRequest({ request, env });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(Array.isArray(payload.groupReviewVotes), true);
  assert.equal(payload.groupReviewVotes.length, 1);
  assert.equal(payload.groupReviewVotes[0].group_id, "group-a");
});

test("GET /api/admin/export rejects a projection from an older data version", async () => {
  const env = makeEnv({ COMMUNITY_DATA_VERSION: "new-deploy" });
  env.CORRECTIONS_DB.communityProjection = {
    current_revision: 4,
    computed_revision: 4,
    data_version: "old-deploy",
    payload_json: JSON.stringify({
      groupCorrections: [{ group_id: "stale-group" }],
    }),
  };
  const response = await adminExportOnRequest({
    request: makeRequest("/api/admin/export?format=json", {
      method: "GET",
      headers: { Authorization: "Bearer admin-test-token" },
    }),
    env,
  });
  const payload = await response.json();
  assert.equal(payload.groupStateCurrent, false);
  assert.deepEqual(payload.groupState, []);
});

test("GET /api/admin/export rejects a projection from an older state schema", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.communityProjection = {
    current_revision: 4,
    computed_revision: 4,
    data_version: "test-data-v1",
    payload_json: JSON.stringify({
      groupCorrections: [{ group_id: "stale-group" }],
    }),
  };
  const response = await adminExportOnRequest({
    request: makeRequest("/api/admin/export?format=json", {
      method: "GET",
      headers: { Authorization: "Bearer admin-test-token" },
    }),
    env,
  });
  const payload = await response.json();
  assert.equal(payload.groupStateCurrent, false);
  assert.deepEqual(payload.groupState, []);
});

test("GET /api/admin/export fails closed when an event table is unavailable", async () => {
  const env = makeEnv();
  env.CORRECTIONS_DB.failAllMatching(
    "from group_review_votes",
    new Error("D1 unavailable"),
  );
  const request = makeRequest("/api/admin/export?format=json", {
    method: "GET",
    headers: { Authorization: "Bearer admin-test-token" },
  });
  const response = await adminExportOnRequest({ request, env });
  assert.equal(response.status, 503);
});

test("GET /api/config exposes client full-res download mode", async () => {
  const env = makeEnv();
  const request = makeRequest("/api/config", { method: "GET" });
  const response = await configOnRequest({ request, env });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.fullResDownloadMode, "client");
});

test("GET /api/preview-url falls back to feature preview metadata", async () => {
  const env = makeEnv({
    ASSETS: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            features: [
              {
                properties: {
                  id: "X1",
                  scan_previews: ["https://images.example/X1.jpg"],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    },
  });

  const request = makeRequest("/api/preview-url?xid=X1", { method: "GET" });
  const response = await previewUrlOnRequest({ request, env });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.xid, "X1");
  assert.equal(payload.url, "https://images.example/X1.jpg");
  assert.equal(payload.source, "feature_preview");
});

test("GET /api/preview-url skips archive URLs when archive fallback is disabled", async () => {
  const env = makeEnv({
    ASSETS: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            features: [
              {
                properties: {
                  id: "XA",
                  scan_previews: ["https://images.ahmp.cz/preview/XA.jpg"],
                  scan_zoomify_paths: ["https://images.ahmp.cz/zoomify/XA"],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    },
  });

  const request = makeRequest("/api/preview-url?xid=XA&scanIndex=0", {
    method: "GET",
  });
  const response = await previewUrlOnRequest({ request, env });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.xid, "XA");
  assert.equal(payload.scan_index, 0);
  assert.equal(payload.url, "");
  assert.equal(payload.source, "none");
});

test("GET /api/preview-url allows archive URLs when archive fallback is enabled", async () => {
  const env = makeEnv({
    ALLOW_ARCHIVE_FALLBACK: "1",
    ASSETS: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            features: [
              {
                properties: {
                  id: "XB",
                  scan_previews: ["https://images.ahmp.cz/preview/XB.jpg"],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    },
  });

  const request = makeRequest("/api/preview-url?xid=XB", { method: "GET" });
  const response = await previewUrlOnRequest({ request, env });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.url, "https://images.ahmp.cz/preview/XB.jpg");
  assert.equal(payload.source, "feature_preview");
});

test("GET /api/preview-url respects scanIndex for feature preview metadata", async () => {
  const env = makeEnv({
    ASSETS: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            features: [
              {
                properties: {
                  id: "X2",
                  scan_previews: [
                    "https://images.example/X2-scan1.jpg",
                    "https://images.example/X2-scan2.jpg",
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    },
  });

  const request = makeRequest("/api/preview-url?xid=X2&scanIndex=1", {
    method: "GET",
  });
  const response = await previewUrlOnRequest({ request, env });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.xid, "X2");
  assert.equal(payload.scan_index, 1);
  assert.equal(payload.url, "https://images.example/X2-scan2.jpg");
  assert.equal(payload.source, "feature_preview");
});

test("GET /api/zoomify resolves scanIndex from feature metadata", async () => {
  const env = makeEnv({
    ASSETS: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            features: [
              {
                properties: {
                  id: "Z1",
                  scan_zoomify_paths: [
                    "https://images.example/z1-scan1",
                    "https://images.example/z1-scan2",
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    },
  });

  const request = makeRequest("/api/zoomify?xid=Z1&scanIndex=1", { method: "GET" });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://images.example/z1-scan2/ImageProperties.xml") {
        return new Response(
          '<IMAGE_PROPERTIES WIDTH="1000" HEIGHT="800" TILESIZE="256" />',
          { status: 200, headers: { "Content-Type": "application/xml" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const response = await zoomifyOnRequest({ request, env });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.xid, "Z1");
    assert.equal(payload.scanIndex, 1);
    assert.equal(payload.zoomifyImgPath, "https://images.example/z1-scan2");
    assert.equal(payload.source, "feature_zoomify");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /api/zoomify avoids archive requests when archive fallback is disabled", async () => {
  const env = makeEnv({
    ASSETS: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            features: [
              {
                properties: {
                  id: "ZA",
                  scan_zoomify_paths: ["https://images.ahmp.cz/zoomify/ZA"],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    },
  });

  const request = makeRequest("/api/zoomify?xid=ZA&scanIndex=0", { method: "GET" });
  const originalFetch = globalThis.fetch;
  let archiveTouched = false;
  try {
    globalThis.fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("ahmp.cz")) {
        archiveTouched = true;
      }
      return new Response("not found", { status: 404 });
    };

    const response = await zoomifyOnRequest({ request, env });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.match(String(payload.detail || ""), /naší infrastruktuře/u);
    assert.equal(archiveTouched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /api/zoomify archive fallback resolves scan from permalink page", async () => {
  const env = makeEnv({
    ALLOW_ARCHIVE_FALLBACK: "1",
    ASSETS: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            features: [{ properties: { id: "ZB", scan_zoomify_paths: [] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    },
  });

  const request = makeRequest("/api/zoomify?xid=ZB&scanIndex=1", { method: "GET" });
  const originalFetch = globalThis.fetch;
  let zoomifyActionTouched = false;
  const scan2Path = "https://images.ahmp.cz/mrimage/ahmp_watermark/zoomify/cz/archives/ZB/scan2";

  try {
    globalThis.fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("Zoomify.action")) {
        zoomifyActionTouched = true;
        return new Response("unexpected", { status: 500 });
      }
      if (url === "https://katalog.ahmp.cz/pragapublica/permalink?xid=ZB&scan=2") {
        return new Response(
          `<html><script>var zoomifyImgPath = "${scan2Path}";</script></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      if (url === `${scan2Path}/ImageProperties.xml`) {
        return new Response(
          '<IMAGE_PROPERTIES WIDTH="1200" HEIGHT="900" TILESIZE="256" />',
          { status: 200, headers: { "Content-Type": "application/xml" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const response = await zoomifyOnRequest({ request, env });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.source, "archive");
    assert.equal(payload.scanIndex, 1);
    assert.equal(payload.zoomifyImgPath, scan2Path);
    assert.equal(zoomifyActionTouched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
