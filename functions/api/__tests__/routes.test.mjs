import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as correctionsOnRequest } from "../corrections.js";
import { onRequest as mergesOnRequest } from "../merges.js";
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
  } finally {
    globalThis.fetch = originalFetch;
  }
});
