const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const SESSION_COOKIE_NAME = "opp_turnstile_session";
const SESSION_TTL_SECONDS = 6 * 60 * 60;

function parseBool(value) {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

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

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSign(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return toHex(signature);
}

function sessionSecret(env) {
  return (env.TURNSTILE_SESSION_SECRET || env.TURNSTILE_SECRET_KEY || "").trim();
}

async function verifyTurnstile(token, env, remoteip) {
  if (parseBool(env.TURNSTILE_BYPASS)) {
    return;
  }

  const secret = (env.TURNSTILE_SECRET_KEY || "").trim();
  if (!secret) {
    throw new Error("Turnstile není nastaven");
  }
  if (!token) {
    throw new Error("Turnstile je povinný");
  }

  const form = new URLSearchParams({
    secret,
    response: token,
  });
  if (remoteip) {
    form.set("remoteip", remoteip);
  }

  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    throw new Error("Ověření Turnstile selhalo");
  }

  const payload = await response.json();
  if (!payload.success) {
    throw new Error("Ověření Turnstile selhalo");
  }
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return jsonResponse({ detail: "Method Not Allowed" }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return jsonResponse({ detail: "Neplatný JSON" }, 400);
  }

  try {
    await verifyTurnstile(
      String(body?.token || "").trim(),
      env,
      request.headers.get("CF-Connecting-IP"),
    );
  } catch (error) {
    return jsonResponse({ detail: error.message || "Ověření selhalo" }, 400);
  }

  let secret = sessionSecret(env);
  if (!secret && parseBool(env.TURNSTILE_BYPASS)) {
    secret = "dev-bypass";
  }
  if (!secret) {
    return jsonResponse({ detail: "Chybí session secret" }, 500);
  }

  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const sig = await hmacSign(secret, String(exp));
  const value = `${exp}.${sig}`;
  const isSecure = new URL(request.url).protocol === "https:";
  const cookie = [
    `${SESSION_COOKIE_NAME}=${value}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    isSecure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");

  return jsonResponse({ ok: true }, 200, { "Set-Cookie": cookie });
}
