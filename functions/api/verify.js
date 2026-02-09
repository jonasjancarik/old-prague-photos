import {
  assertSameOrigin,
  buildSessionCookie,
  enforceRateLimit,
  toHttpError,
  verifyTurnstileToken,
} from "./_security.js";

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
  if (request.method !== "POST") {
    return jsonResponse({ detail: "Method Not Allowed" }, 405);
  }

  try {
    assertSameOrigin(request, env);
    await enforceRateLimit({ request, env, bucket: "verify" });
  } catch (error) {
    const httpError = toHttpError(error, 400, "Ověření selhalo");
    return jsonResponse(
      { detail: httpError.detail },
      httpError.status,
      httpError.headers,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return jsonResponse({ detail: "Neplatný JSON" }, 400);
  }

  try {
    await verifyTurnstileToken({
      request,
      env,
      token: String(body?.token || "").trim(),
      expectedAction: "session_verify",
    });
    const { cookie } = await buildSessionCookie(request, env);
    return jsonResponse({ ok: true }, 200, { "Set-Cookie": cookie });
  } catch (error) {
    const httpError = toHttpError(error, 400, "Ověření selhalo");
    return jsonResponse(
      { detail: httpError.detail },
      httpError.status,
      httpError.headers,
    );
  }
}
