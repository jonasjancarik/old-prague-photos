#!/usr/bin/env node

import { isValidCandidatePayload } from "./smoke-pages-validation.mjs";

const baseUrl = String(process.argv[2] || "").replace(/\/$/, "");
if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
  console.error("Usage: node scripts/smoke-pages.mjs https://staging.example.com");
  process.exit(2);
}

const headers = { accept: "application/json" };
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
}

async function getJson(path, { expectedStatus = 200, extraHeaders = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { ...headers, ...extraHeaders },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${path}: expected ${expectedStatus}, got ${response.status}: ${body.slice(0, 300)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${path}: response was not JSON`);
  }
}

const config = await getJson("/api/config");
if (process.env.SMOKE_REQUIRE_SECURE_CONFIG === "1") {
  for (const key of ["turnstileSiteKey", "mapyCzApiKey"]) {
    if (!String(config[key] || "").trim()) {
      throw new Error(`/api/config: ${key} is not configured`);
    }
  }
}

for (const flow of ["location", "duplicate", "group"]) {
  const payload = await getJson(`/api/community-candidates?flow=${flow}&limit=1`);
  if (!isValidCandidatePayload(payload)) {
    throw new Error(`/api/community-candidates: invalid ${flow} payload`);
  }
}

if (process.env.SMOKE_REQUIRE_ACCESS === "1") {
  if (!process.env.CF_ACCESS_CLIENT_ID || !process.env.CF_ACCESS_CLIENT_SECRET) {
    throw new Error("Cloudflare Access service-token credentials are required for this smoke check");
  }
  if (!String(process.env.ADMIN_API_TOKEN || "").trim()) {
    throw new Error("ADMIN_API_TOKEN is required for this smoke check");
  }

  const blocked = await fetch(`${baseUrl}/api/admin/review`, {
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const accessLocation = String(blocked.headers.get("location") || "");
  const looksLikeAccess =
    [302, 401, 403].includes(blocked.status) &&
    (accessLocation.includes("cloudflareaccess.com") ||
      blocked.headers.has("cf-access-authenticated-user-email"));
  if (!looksLikeAccess) {
    throw new Error(`/api/admin/review: Cloudflare Access did not block the unauthenticated request (${blocked.status})`);
  }
}

const adminToken = String(process.env.ADMIN_API_TOKEN || "").trim();
if (adminToken) {
  const sessionResponse = await fetch(`${baseUrl}/api/admin/session`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      origin: new URL(baseUrl).origin,
    },
    body: JSON.stringify({ token: adminToken }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const sessionBody = await sessionResponse.text();
  if (sessionResponse.status !== 200) {
    throw new Error(`/api/admin/session: expected 200, got ${sessionResponse.status}: ${sessionBody.slice(0, 300)}`);
  }
  const setCookie = String(sessionResponse.headers.get("set-cookie") || "");
  if (
    !setCookie.startsWith("opp_admin_session=") ||
    !/HttpOnly/iu.test(setCookie) ||
    !/SameSite=Strict/iu.test(setCookie) ||
    setCookie.includes(adminToken)
  ) {
    throw new Error("/api/admin/session: missing protected admin session cookie");
  }
  const cookie = setCookie.split(";", 1)[0];
  const review = await getJson("/api/admin/review", {
    extraHeaders: { cookie },
  });
  if (
    !review?.operations?.projection?.current ||
    typeof review?.operations?.queues?.pendingCorrections !== "number" ||
    typeof review?.operations?.candidateRequests?.staleCursors24h !== "number"
  ) {
    throw new Error("/api/admin/review: operational diagnostics are missing or stale");
  }
} else {
  await getJson("/api/admin/review", { expectedStatus: 401 });
}

console.log(`Pages smoke checks passed for ${baseUrl}`);
