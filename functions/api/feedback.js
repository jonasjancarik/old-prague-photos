import { findCatalogPhoto } from "./_catalog.js";
import { logDatabaseError } from "./_db.js";
import {
  assertSameOrigin,
  enforceRateLimit,
  hasValidSession,
  toHttpError,
  verifyTurnstileToken,
} from "./_security.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const MAX_BODY_BYTES = 8192;

function reply(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

async function existingFeedback(db, submissionId) {
  return db.prepare(
    "SELECT id, xid, message, email FROM photo_feedback WHERE submission_id = ?",
  ).bind(submissionId).first();
}

function duplicateReply(row, xid, message, email) {
  if (row.xid !== xid || row.message !== message || (row.email || null) !== email) {
    return reply({ detail: "Toto odeslání už obsahuje jinou připomínku" }, 409);
  }
  return reply({ ok: true, id: String(row.id) });
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return reply({ detail: "Method Not Allowed" }, 405);
  if (!env.CORRECTIONS_DB) return reply({ detail: "Chybí CORRECTIONS_DB" }, 500);
  try {
    assertSameOrigin(request, env);
    await enforceRateLimit({ request, env, bucket: "write" });
  } catch (error) {
    const failure = toHttpError(error, 400, "Ověření selhalo");
    return reply({ detail: failure.detail }, failure.status, failure.headers);
  }

  let body;
  try {
    if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) {
      return reply({ detail: "Připomínka je příliš dlouhá" }, 413);
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return reply({ detail: "Připomínka je příliš dlouhá" }, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return reply({ detail: "Neplatný JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reply({ detail: "Neplatný JSON" }, 400);
  }
  const submissionId = body.submission_id;
  const xid = body.xid;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const email = body.email == null || body.email === "" ? null :
    typeof body.email === "string" ? body.email.trim() : false;
  if (typeof submissionId !== "string" || !UUID.test(submissionId)) {
    return reply({ detail: "Neplatné ID odeslání" }, 400);
  }
  if (typeof xid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(xid)) {
    return reply({ detail: "Neplatné xid" }, 400);
  }
  if (message.length < 5 || message.length > 2000) {
    return reply({ detail: "Připomínka musí mít 5 až 2000 znaků" }, 400);
  }
  if (email === false || (email && (email.length > 254 || !EMAIL.test(email)))) {
    return reply({ detail: "Neplatný e-mail" }, 400);
  }

  if (!(await hasValidSession(request, env))) {
    try {
      await verifyTurnstileToken({ request, env, token: body.token, expectedAction: "feedback_submit" });
    } catch (error) {
      const failure = toHttpError(error, 400, "Ověření selhalo");
      return reply({ detail: failure.detail }, failure.status, failure.headers);
    }
  }
  try {
    if (!(await findCatalogPhoto(env, xid))) return reply({ detail: "Neznámé xid" }, 400);
    const db = env.CORRECTIONS_DB;
    const existing = await existingFeedback(db, submissionId);
    if (existing) return duplicateReply(existing, xid, message, email);
    try {
      const result = await db.prepare(
        "INSERT INTO photo_feedback (submission_id, xid, message, email) VALUES (?, ?, ?, ?)",
      ).bind(submissionId, xid, message, email).run();
      return reply({ ok: true, id: String(result.meta.last_row_id) });
    } catch (error) {
      // The unique constraint is authoritative when two identical requests race.
      const raced = await existingFeedback(db, submissionId);
      if (raced) return duplicateReply(raced, xid, message, email);
      throw error;
    }
  } catch (error) {
    logDatabaseError("/api/feedback", "store photo feedback", error);
    return reply({ detail: "Připomínku se nepodařilo uložit" }, 503);
  }
}
