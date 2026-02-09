import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSameOrigin,
  buildSessionCookie,
  enforceRateLimit,
  hasValidSession,
  isLocalBypassAllowed,
  toHttpError,
  verifyTurnstileToken,
} from "../_security.js";
import { FakeD1, makeRequest } from "./test-helpers.mjs";

function expectHttpError(error, status) {
  const httpError = toHttpError(error);
  assert.equal(httpError.status, status);
  return httpError;
}

test("isLocalBypassAllowed only for localhost hosts", () => {
  const localRequest = makeRequest("/api/verify", {
    host: "localhost",
    protocol: "http:",
  });
  const publicRequest = makeRequest("/api/verify", {
    host: "viewer.example.com",
  });
  const env = { TURNSTILE_BYPASS: "1" };

  assert.equal(isLocalBypassAllowed(localRequest, env), true);
  assert.equal(isLocalBypassAllowed(publicRequest, env), false);
});

test("assertSameOrigin accepts matching origin and rejects mismatches", () => {
  const okRequest = makeRequest("/api/verify", {
    headers: { Origin: "https://example.com" },
  });
  assert.doesNotThrow(() => assertSameOrigin(okRequest, {}));

  const badRequest = makeRequest("/api/verify", {
    headers: { Origin: "https://evil.example" },
  });
  assert.throws(() => assertSameOrigin(badRequest, {}), (error) => {
    const httpError = expectHttpError(error, 403);
    assert.match(httpError.detail, /původ/u);
    return true;
  });
});

test("buildSessionCookie + hasValidSession validates cookie signature", async () => {
  const request = makeRequest("/api/verify", {
    headers: { Origin: "https://example.com" },
  });
  const env = { TURNSTILE_SECRET_KEY: "session-secret" };

  const { cookie, ttlSeconds } = await buildSessionCookie(request, env);
  assert.equal(ttlSeconds, 3600);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /SameSite=Strict/u);

  const sessionCookie = String(cookie.split(";")[0] || "");
  const requestWithCookie = makeRequest("/api/corrections", {
    headers: { Cookie: sessionCookie, Origin: "https://example.com" },
  });
  assert.equal(await hasValidSession(requestWithCookie, env), true);
});

test("verifyTurnstileToken enforces hostname and action", async () => {
  const request = makeRequest("/api/verify", {
    headers: { Origin: "https://example.com" },
  });
  const env = { TURNSTILE_SECRET_KEY: "turnstile-secret" };
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
    await verifyTurnstileToken({
      request,
      env,
      token: "ok",
      expectedAction: "session_verify",
    });

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          hostname: "evil.example",
          action: "session_verify",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    await assert.rejects(
      verifyTurnstileToken({
        request,
        env,
        token: "ok",
        expectedAction: "session_verify",
      }),
      (error) => {
        const httpError = expectHttpError(error, 400);
        assert.match(httpError.detail, /hostname/u);
        return true;
      },
    );

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          hostname: "example.com",
          action: "wrong_action",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    await assert.rejects(
      verifyTurnstileToken({
        request,
        env,
        token: "ok",
        expectedAction: "session_verify",
      }),
      (error) => {
        const httpError = expectHttpError(error, 400);
        assert.match(httpError.detail, /akce/u);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enforceRateLimit blocks after configured threshold", async () => {
  const request = makeRequest("/api/verify", {
    headers: { Origin: "https://example.com", "CF-Connecting-IP": "1.2.3.4" },
  });
  const env = {
    CORRECTIONS_DB: new FakeD1(),
    TURNSTILE_SECRET_KEY: "rate-secret",
    API_RATE_LIMIT_WINDOW_SECONDS: "3600",
    API_RATE_LIMIT_VERIFY_MAX: "2",
  };
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;

  try {
    await enforceRateLimit({ request, env, bucket: "verify" });
    await enforceRateLimit({ request, env, bucket: "verify" });

    await assert.rejects(
      enforceRateLimit({ request, env, bucket: "verify" }),
      (error) => {
        const httpError = expectHttpError(error, 429);
        assert.equal(typeof httpError.headers["Retry-After"], "string");
        return true;
      },
    );
  } finally {
    Date.now = realNow;
  }
});
