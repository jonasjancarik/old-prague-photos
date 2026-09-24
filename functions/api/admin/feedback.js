import { authorizeAdmin } from "../_admin_auth.js";
import { logDatabaseError } from "../_db.js";
import { assertSameOrigin, toHttpError } from "../_security.js";

function reply(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequest({ request, env }) {
  const auth = await authorizeAdmin(request, env);
  if (auth) return auth;
  if (!env.CORRECTIONS_DB) return reply({ detail: "Chybí CORRECTIONS_DB" }, 500);
  const db = env.CORRECTIONS_DB;
  if (request.method === "GET") {
    const params = new URL(request.url).searchParams;
    const status = params.get("status") || "new";
    const rawLimit = params.get("limit");
    const rawBefore = params.get("before_id");
    const limit = rawLimit === null ? 30 : Number(rawLimit);
    const before = rawBefore === null ? Number.MAX_SAFE_INTEGER : Number(rawBefore);
    if (!["new", "resolved"].includes(status) || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1) {
      return reply({ detail: "Neplatné stránkování" }, 400);
    }
    try {
      const result = await db.prepare(
        `SELECT id, xid, message, email, status, created_at, resolved_at
         FROM photo_feedback WHERE status = ? AND id < ? ORDER BY id DESC LIMIT ?`,
      ).bind(status, before, limit + 1).all();
      const rows = result.results || [];
      const items = rows.slice(0, limit);
      return reply({ items, next_before_id: rows.length > limit ? items.at(-1).id : null });
    } catch (error) {
      logDatabaseError("/api/admin/feedback", "list feedback", error);
      return reply({ detail: "Připomínky nejsou dostupné" }, 503);
    }
  }
  if (request.method !== "POST") return reply({ detail: "Method Not Allowed" }, 405);
  try {
    assertSameOrigin(request, env);
  } catch (error) {
    const failure = toHttpError(error, 403, "Neplatný původ požadavku");
    return reply({ detail: failure.detail }, failure.status);
  }
  let body;
  try { body = await request.json(); } catch { return reply({ detail: "Neplatný JSON" }, 400); }
  const id = Number(body?.id);
  const status = body?.status;
  if (!Number.isSafeInteger(id) || id < 1 || !["new", "resolved"].includes(status)) {
    return reply({ detail: "Neplatná změna stavu" }, 400);
  }
  try {
    const result = await db.prepare(
      `UPDATE photo_feedback SET status = ?, resolved_at =
       CASE WHEN ? = 'resolved' THEN COALESCE(resolved_at, datetime('now')) ELSE NULL END
       WHERE id = ?`,
    ).bind(status, status, id).run();
    if (!result.meta.changes) return reply({ detail: "Připomínka neexistuje" }, 404);
    return reply({ ok: true, id: String(id), status });
  } catch (error) {
    logDatabaseError("/api/admin/feedback", "update feedback", error);
    return reply({ detail: "Stav připomínky se nepodařilo změnit" }, 503);
  }
}
