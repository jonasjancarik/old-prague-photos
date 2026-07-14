import {
  buildAdminSessionCookie,
  clearAdminSessionCookie,
  hasValidAdminToken,
} from "../_admin_auth.js";
import {
  assertSameOrigin,
  enforceRateLimit,
  isLocalBypassAllowed,
  toHttpError,
} from "../_security.js";

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export async function onRequest({ request, env }) {
  if (!["POST", "DELETE"].includes(request.method)) {
    return jsonResponse({ detail: "Method Not Allowed" }, 405);
  }

  try {
    assertSameOrigin(request, env);
  } catch (error) {
    const httpError = toHttpError(error, 400, "Přihlášení selhalo");
    return jsonResponse(
      { detail: httpError.detail },
      httpError.status,
      httpError.headers,
    );
  }

  if (request.method === "DELETE") {
    return jsonResponse(
      { ok: true },
      200,
      { "Set-Cookie": clearAdminSessionCookie(request) },
    );
  }
  try {
    await enforceRateLimit({ request, env, bucket: "verify" });
  } catch (error) {
    const httpError = toHttpError(error, 400, "Přihlášení selhalo");
    return jsonResponse(
      { detail: httpError.detail },
      httpError.status,
      httpError.headers,
    );
  }
  if (isLocalBypassAllowed(request, env)) {
    return jsonResponse({ ok: true, localBypass: true });
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return jsonResponse({ detail: "Neplatný JSON" }, 400);
  }
  if (!hasValidAdminToken(body?.token, env)) {
    return jsonResponse({ detail: "Přístupový token není platný" }, 401);
  }

  const cookie = await buildAdminSessionCookie(request, env);
  if (!cookie) {
    return jsonResponse({ detail: "Přihlášení správce není nastavené" }, 503);
  }
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": cookie });
}
