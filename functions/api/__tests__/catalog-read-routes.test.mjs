import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as adminGroupsOnRequest } from "../admin/groups.js";
import { onRequest as adminReviewOnRequest } from "../admin/review.js";
import { onRequest as previewUrlOnRequest } from "../preview-url.js";
import { onRequest as zoomifyOnRequest } from "../zoomify.js";

function request(path, options = {}) {
  return new Request(`https://example.test${path}`, options);
}

function catalogRow(xid, groupId, properties = {}) {
  return {
    xid,
    base_group_id: groupId,
    source_lon: 14.4,
    source_lat: 50.1,
    feature_json: JSON.stringify(properties),
    search_text: [xid, groupId, properties.description, properties.author, properties.date_label]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("cs-CZ"),
  };
}

class CatalogD1 {
  constructor(rows) {
    this.rows = rows;
    this.catalogMetadata = { data_version: "catalog-v1", row_count: rows.length };
    this.corrections = [];
    this.merges = [];
    this.groupReviewVotes = [];
    this.groupMembershipEvents = [];
  }

  prepare(sql) {
    const db = this;
    let args = [];
    return {
      bind(...nextArgs) {
        args = nextArgs;
        return this;
      },
      first() {
        return db.first(sql, args);
      },
      all() {
        return db.all(sql, args);
      },
    };
  }

  first(sql, args) {
    const query = String(sql).toLowerCase();
    if (query.includes("from catalog_metadata")) return this.catalogMetadata;
    if (query.includes("from catalog_photos as p")) {
      const row = this.rows.find((item) => item.xid === String(args[0] || ""));
      return row ? { ...row, current_group_id: row.base_group_id } : null;
    }
    if (query.includes("community_state_projection")) return null;
    if (query.includes("operations_contributor_continuity")) {
      return { active_30d: 0, new_30d: 0, returning_30d: 0, repeat_30d: 0 };
    }
    return null;
  }

  all(sql, args) {
    const query = String(sql).toLowerCase();
    if (query.includes("operations_submission_counts")) {
      return { results: ["location", "duplicate", "group"].map((flow) => ({
        flow,
        accepted_24h: 0,
        accepted_7d: 0,
        latest_at: null,
      })) };
    }
    if (query.includes("community_operation_metrics")) return { results: [] };
    if (query.includes("from corrections")) return { results: this.corrections };
    if (query.includes("from merge_decisions")) return { results: this.merges };
    if (query.includes("from current_group_review_votes")) {
      return { results: this.groupReviewVotes };
    }
    if (query.includes("from group_membership_events")) {
      return { results: this.groupMembershipEvents };
    }
    if (query.includes("select xid, base_group_id from catalog_photos")) {
      return { results: this.rows.filter((row) => args.includes(row.xid)) };
    }
    if (query.includes("from catalog_photos as photos") && query.includes("having sum")) {
      const pattern = String(args[0] || "").replaceAll("%", "").replaceAll("\\", "");
      const matches = (row) =>
        row.search_text.includes(pattern) || row.base_group_id.toLowerCase().includes(pattern);
      const groups = new Map();
      this.rows.filter(matches).forEach((row) => {
        if (!groups.has(row.base_group_id)) groups.set(row.base_group_id, row);
      });
      return {
        results: Array.from(groups.entries()).map(([groupId, sample]) => ({
          group_id: groupId,
          member_count: this.rows.filter((row) => row.base_group_id === groupId).length,
          sample_xid: sample.xid,
          feature_json: sample.feature_json,
        })),
      };
    }
    if (query.includes("from catalog_photos as photos")) {
      return {
        results: this.rows
          .filter((row) => args.includes(row.base_group_id))
          .map((row) => ({ ...row, current_group_id: row.base_group_id })),
      };
    }
    return { results: [] };
  }
}

function environment(rows) {
  const requestedAssetPaths = [];
  return {
    requestedAssetPaths,
    env: {
      CORRECTIONS_DB: new CatalogD1(rows),
      COMMUNITY_DATA_VERSION: "catalog-v1",
      ADMIN_API_TOKEN: "admin-token",
      ASSETS: {
        fetch: async (assetRequest) => {
          requestedAssetPaths.push(new URL(assetRequest.url).pathname);
          return new Response("unexpected asset read", { status: 500 });
        },
      },
    },
  };
}

test("preview URL reads one catalog photo and never loads the GeoJSON asset", async () => {
  const { env, requestedAssetPaths } = environment([
    catalogRow("P1", "series-1", {
      scan_previews: ["https://images.example/P1.jpg"],
      scan_zoomify_paths: [],
    }),
  ]);

  const response = await previewUrlOnRequest({
    request: request("/api/preview-url?xid=P1", { method: "GET" }),
    env,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    xid: "P1",
    scan_index: 0,
    url: "https://images.example/P1.jpg",
    source: "feature_preview",
  });
  assert.deepEqual(requestedAssetPaths, []);
});

test("zoomify reads catalog metadata before preserving the feature fallback", async () => {
  const { env, requestedAssetPaths } = environment([
    catalogRow("Z1", "series-1", {
      scan_zoomify_paths: ["https://images.example/zoom/Z1"],
    }),
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://images.example/zoom/Z1/ImageProperties.xml");
    return new Response('<IMAGE_PROPERTIES WIDTH="1000" HEIGHT="800" TILESIZE="256" />');
  };
  try {
    const response = await zoomifyOnRequest({
      request: request("/api/zoomify?xid=Z1", { method: "GET" }),
      env,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).source, "feature_zoomify");
    assert.deepEqual(requestedAssetPaths, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image endpoints reject malformed inputs, unknown photos and unavailable scans before fetch", async () => {
  const { env } = environment([catalogRow("P1", "series-1", { scan_count: 2 })]);
  env.R2_TILES_BASE = "https://invalid-inputs.example/tiles";
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("No upstream request should be made");
  };
  try {
    for (const route of [previewUrlOnRequest, zoomifyOnRequest]) {
      for (const [query, status] of [
        ["xid=missing", 404],
        ["xid=P1&scanIndex=2", 404],
        ["xid=P1&scanIndex=999999999", 404],
        ["xid=../bad", 400],
        [`xid=${"x".repeat(129)}`, 400],
        ...["-1", "1.5", "1junk", "", "NaN", "9007199254740992"].map(
          (value) => [`xid=P1&scanIndex=${value}`, 400],
        ),
      ]) {
        const response = await route({ request: request(`/api/image?${query}`), env });
        assert.equal(response.status, status, query);
      }
      const response = await route({
        request: request("/api/image?xid=P1", { method: "POST" }), env,
      });
      assert.equal(response.status, 405);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image endpoints preserve multi-scan and legacy catalog records", async () => {
  const { env } = environment([
    catalogRow("COUNT", "s", { scan_count: 2 }),
    catalogRow("ARRAY", "s", { scan_count: 0, scan_previews: ["", ""] }),
    catalogRow("PATHS", "s", { scan_zoomify_paths: ["", ""] }),
    catalogRow("LEGACY", "s", {}),
  ]);
  env.R2_TILES_BASE = "https://valid-scans.example/tiles";
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response('<IMAGE_PROPERTIES WIDTH="100" HEIGHT="80" TILESIZE="256" />');
  };
  try {
    for (const route of [previewUrlOnRequest, zoomifyOnRequest]) {
      for (const xid of ["COUNT", "ARRAY", "PATHS", "LEGACY"]) {
        const index = xid === "LEGACY" ? 0 : 1;
        const response = await route({
          request: request(`/api/image?xid=${xid}&scanIndex=${index}`), env,
        });
        assert.equal(response.status, 200, `${xid}:${index}`);
        assert.match(urls.at(-1), new RegExp(`/${xid}/scan_${index}/`));
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preview probes reuse negative results and retry after expiry", async () => {
  const { env } = environment([catalogRow("EXPIRY", "s", {})]);
  env.R2_TILES_BASE = "https://expiry.example/tiles";
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = originalNow();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(null, { status: 404 }); };
  Date.now = () => now;
  const invoke = () => previewUrlOnRequest({ request: request("/api/preview-url?xid=EXPIRY"), env });
  try {
    assert.equal((await invoke()).status, 200);
    assert.equal((await invoke()).status, 200);
    assert.equal(calls, 1);
    now += 5 * 60 * 1000;
    assert.equal((await invoke()).status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("preview probe cache evicts old entries instead of growing with catalog traffic", async () => {
  const rows = Array.from({ length: 257 }, (_, index) => catalogRow(`CACHE${index}`, "s", {}));
  const { env } = environment(rows);
  env.R2_TILES_BASE = "https://capacity.example/tiles";
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(null, { status: 200 }); };
  const invoke = (xid) => previewUrlOnRequest({ request: request(`/api/preview-url?xid=${xid}`), env });
  try {
    for (const row of rows) assert.equal((await invoke(row.xid)).status, 200);
    assert.equal(calls, 257);
    await invoke("CACHE256");
    assert.equal(calls, 257, "recent entries remain cached");
    await invoke("CACHE0");
    assert.equal(calls, 258, "oldest entry was evicted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preview HEAD fallback discards the GET body", async () => {
  const { env } = environment([catalogRow("BODY", "s", {})]);
  env.R2_TILES_BASE = "https://body.example/tiles";
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  const methods = [];
  globalThis.fetch = async (_, options) => {
    methods.push(options.method);
    if (options.method === "HEAD") return new Response(null, { status: 405 });
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  };
  try {
    const response = await previewUrlOnRequest({ request: request("/api/preview-url?xid=BODY"), env });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).source, "r2_tile");
    assert.deepEqual(methods, ["HEAD", "GET"]);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("zoomify rejects oversized upstream metadata", async () => {
  const { env } = environment([catalogRow("LARGE", "s", {})]);
  env.R2_TILES_BASE = "https://large.example/tiles";
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }));
  try {
    const response = await zoomifyOnRequest({ request: request("/api/zoomify?xid=LARGE"), env });
    assert.equal(response.status, 502);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin group search returns catalog-backed group summaries without asset reads", async () => {
  const { env, requestedAssetPaths } = environment([
    catalogRow("A1", "series-a", { description: "Old Town square" }),
    catalogRow("A2", "series-a", { description: "Old Town hall" }),
    catalogRow("B1", "series-b", { description: "New Town" }),
  ]);
  const response = await adminGroupsOnRequest({
    request: request("/api/admin/groups?query=Old%20Town", {
      method: "GET",
      headers: { Authorization: "Bearer admin-token" },
    }),
    env,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    items: [{
      group_id: "series-a",
      member_count: 2,
      sample_xid: "A1",
      description: "Old Town square",
    }],
  });
  assert.deepEqual(requestedAssetPaths, []);
});

test("admin review loads catalog evidence only for split candidates", async () => {
  const { env, requestedAssetPaths } = environment([
    catalogRow("A1", "series-a", {
      description: "Old Town square",
      scan_previews: ["https://images.example/A1.jpg"],
    }),
    catalogRow("A2", "series-a", {}),
  ]);
  env.CORRECTIONS_DB.groupReviewVotes = [
    { id: 1, group_id: "series-a", verdict: "split", voter_key: "a", created_at: "2026-01-01 10:00:00" },
    { id: 2, group_id: "series-a", verdict: "split", voter_key: "b", created_at: "2026-01-01 10:01:00" },
  ];
  const response = await adminReviewOnRequest({
    request: request("/api/admin/review", {
      method: "GET",
      headers: { Authorization: "Bearer admin-token" },
    }),
    env,
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.splitCandidates[0].xids, ["A1", "A2"]);
  assert.equal(payload.splitCandidates[0].members[0].description, "Old Town square");
  assert.deepEqual(requestedAssetPaths, []);
});
