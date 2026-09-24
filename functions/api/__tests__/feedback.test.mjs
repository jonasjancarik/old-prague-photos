import assert from "node:assert/strict";
import test from "node:test";
import { onRequest as submit } from "../feedback.js";
import { onRequest as admin } from "../admin/feedback.js";
import { buildSessionCookie } from "../_security.js";
import { FakeD1, makeRequest } from "./test-helpers.mjs";

const xid = "PHOTO1";
const submissionId = "10000000-0000-4000-8000-000000000001";

function env() {
  const db = new FakeD1();
  db.catalogPhotos.set(xid, {
    properties: { id: xid, group_id: "G1" },
    geometry: { coordinates: [14.4, 50.1] },
  });
  return { CORRECTIONS_DB: db, TURNSTILE_SECRET_KEY: "test-session-secret", ADMIN_API_TOKEN: "test-admin" };
}

async function request(environment, data, { origin = "https://example.com", cookie = true } = {}) {
  const headers = { Origin: origin };
  if (cookie) {
    const issued = await buildSessionCookie(makeRequest("/api/verify", { headers }), environment);
    headers.Cookie = issued.cookie.split(";")[0];
  }
  return makeRequest("/api/feedback", { headers, jsonBody: data });
}

async function post(environment, data, options) {
  return submit({ request: await request(environment, data, options), env: environment });
}

function adminRequest(path, { method = "GET", data } = {}) {
  return makeRequest(path, { method, headers: { Authorization: "Bearer test-admin", Origin: "https://example.com" }, jsonBody: data });
}

test("feedback is idempotent, private, and independent of review revision", async () => {
  const environment = env();
  const body = { submission_id: submissionId, xid, message: "Historický popis se neshoduje." };
  const revision = environment.CORRECTIONS_DB.communityProjection.current_revision;
  const first = await post(environment, body);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, id: "1" });
  assert.equal((await post(environment, body)).status, 200);
  assert.equal((await post(environment, { ...body, message: "Jiná připomínka" })).status, 409);
  assert.equal(environment.CORRECTIONS_DB.photoFeedback.length, 1);
  assert.equal(environment.CORRECTIONS_DB.corrections.length, 0);
  assert.equal(environment.CORRECTIONS_DB.communityProjection.current_revision, revision);
  const denied = await admin({ request: makeRequest("/api/admin/feedback", { method: "GET" }), env: environment });
  assert.equal(denied.status, 401);
  const list = await admin({ request: adminRequest("/api/admin/feedback"), env: environment });
  assert.equal((await list.json()).items[0].message, body.message);
  const changed = await admin({ request: adminRequest("/api/admin/feedback", { method: "POST", data: { id: "1", status: "resolved" } }), env: environment });
  assert.equal(changed.status, 200);
  assert.equal(environment.CORRECTIONS_DB.communityProjection.current_revision, revision);
  assert.equal(environment.CORRECTIONS_DB.corrections.length, 0);
  const restored = await admin({ request: adminRequest("/api/admin/feedback", { method: "POST", data: { id: "1", status: "new" } }), env: environment });
  assert.equal(restored.status, 200);
  assert.equal(environment.CORRECTIONS_DB.photoFeedback[0].resolved_at, null);
});

test("feedback validates input, origin, session and shared write limit", async () => {
  const environment = env();
  const valid = { submission_id: submissionId, xid, message: "Platná připomínka" };
  assert.equal((await post(environment, { ...valid, xid: "UNKNOWN" })).status, 400);
  assert.equal((await post(environment, { ...valid, message: "  a  " })).status, 400);
  assert.equal((await post(environment, { ...valid, email: "bad" })).status, 400);
  assert.equal((await post(environment, { ...valid, submission_id: "bad" })).status, 400);
  assert.equal((await post(environment, valid, { origin: "https://other.example" })).status, 403);
  assert.equal((await post(environment, valid, { cookie: false })).status, 400);
  environment.API_RATE_LIMIT_WRITE_MAX = "1";
  assert.equal((await post(environment, valid)).status, 429);
});

test("admin feedback pages by ID and rejects invalid status", async () => {
  const environment = env();
  for (let index = 1; index <= 3; index += 1) {
    const id = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    assert.equal((await post(environment, { submission_id: id, xid, message: `Připomínka ${index}` })).status, 200);
  }
  const pageOne = await admin({ request: adminRequest("/api/admin/feedback?limit=2"), env: environment });
  const first = await pageOne.json();
  assert.deepEqual(first.items.map((row) => row.id), [3, 2]);
  assert.equal(first.next_before_id, 2);
  const pageTwo = await admin({ request: adminRequest(`/api/admin/feedback?limit=2&before_id=${first.next_before_id}`), env: environment });
  assert.deepEqual((await pageTwo.json()).items.map((row) => row.id), [1]);
  assert.equal((await admin({ request: adminRequest("/api/admin/feedback?status=invalid"), env: environment })).status, 400);
});
