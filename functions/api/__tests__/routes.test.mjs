import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as correctionsOnRequest } from "../corrections.js";
import { onRequest as adminExportOnRequest } from "../admin/export.js";
import { onRequest as adminReviewOnRequest } from "../admin/review.js";
import { onRequest as configOnRequest } from "../config.js";
import { onRequest as mergesOnRequest } from "../merges.js";
import { onRequest as previewUrlOnRequest } from "../preview-url.js";
import { onRequest as zoomifyOnRequest } from "../zoomify.js";
import { onRequest as verifyOnRequest } from "../verify.js";
import { FakeD1, makeRequest } from "./test-helpers.mjs";

function makeEnv(overrides = {}) {
  return {
    CORRECTIONS_DB: new FakeD1(),
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    ...overrides,
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

  const request = makeRequest("/api/admin/review", { method: "GET" });
  const response = await adminReviewOnRequest({ request, env });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.counts.pendingCorrections, 1);
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

  const request = makeRequest("/api/admin/review", { method: "GET" });
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
    created_at: "2026-01-01 10:00:00",
  });

  const request = makeRequest("/api/admin/export?format=csv", { method: "GET" });
  const response = await adminExportOnRequest({ request, env });
  assert.equal(response.status, 200);
  assert.match(
    String(response.headers.get("Content-Type") || ""),
    /text\/csv/u,
  );
  const body = await response.text();
  assert.match(body, /record_type/u);
  assert.match(body, /correction/u);
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
