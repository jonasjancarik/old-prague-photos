const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SESSION_COOKIE_NAME = "opp_turnstile_session";

class HttpError extends Error {
  constructor(status, detail, headers = {}) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.headers = headers;
  }
}

export function parseBool(value) {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseIntEnv(value, fallback, min = 1, max = 86400) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const [key, ...rest] = part.trim().split("=");
    if (!key) return;
    out[key] = rest.join("=");
  });
  return out;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
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

async function sha256Hex(payload) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return toHex(digest);
}

function getRequestUrl(request) {
  try {
    return new URL(request.url);
  } catch (error) {
    throw new HttpError(400, "Neplatný URL požadavku");
  }
}

export function isLocalBypassAllowed(request, env) {
  if (!parseBool(env.TURNSTILE_BYPASS)) return false;
  const url = getRequestUrl(request);
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function sessionSecret(request, env) {
  const secret = (
    env.TURNSTILE_SESSION_SECRET ||
    env.TURNSTILE_SECRET_KEY ||
    ""
  ).trim();
  if (secret) return secret;
  if (isLocalBypassAllowed(request, env)) return "dev-bypass";
  return "";
}

function rateLimitSecret(request, env) {
  const secret = (
    env.API_RATE_LIMIT_SECRET ||
    env.TURNSTILE_SESSION_SECRET ||
    env.TURNSTILE_SECRET_KEY ||
    ""
  ).trim();
  if (secret) return secret;
  if (isLocalBypassAllowed(request, env)) return "dev-rate-limit";
  return "";
}

function voterKeySecret(request, env) {
  const secret = (
    env.API_RATE_LIMIT_SECRET ||
    env.TURNSTILE_SESSION_SECRET ||
    env.TURNSTILE_SECRET_KEY ||
    ""
  ).trim();
  if (secret) return secret;
  if (isLocalBypassAllowed(request, env)) return "dev-voter-key";
  return "";
}

function clientIp(request) {
  const cfIp = String(request.headers.get("CF-Connecting-IP") || "").trim();
  if (cfIp) return cfIp;

  const xff = String(request.headers.get("X-Forwarded-For") || "").trim();
  if (!xff) return "unknown";
  return String(xff.split(",")[0] || "").trim() || "unknown";
}

function allowedTurnstileHostnames(request, env) {
  const csv = String(env.TURNSTILE_ALLOWED_HOSTNAMES || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (csv.length > 0) return new Set(csv);

  const requestHost = getRequestUrl(request).hostname.toLowerCase();
  return new Set([requestHost]);
}

function sameOrigin(left, right) {
  if (!left || !right) return false;
  return left === right;
}

export function assertSameOrigin(request, env) {
  if (isLocalBypassAllowed(request, env)) return;

  const requestUrl = getRequestUrl(request);
  const expectedOrigin = requestUrl.origin;
  const originHeader = String(request.headers.get("Origin") || "").trim();
  const refererHeader = String(request.headers.get("Referer") || "").trim();

  if (originHeader) {
    let parsed;
    try {
      parsed = new URL(originHeader);
    } catch (error) {
      throw new HttpError(403, "Neplatný původ požadavku");
    }
    if (!sameOrigin(parsed.origin, expectedOrigin)) {
      throw new HttpError(403, "Neplatný původ požadavku");
    }
    return;
  }

  if (refererHeader) {
    let parsed;
    try {
      parsed = new URL(refererHeader);
    } catch (error) {
      throw new HttpError(403, "Neplatný původ požadavku");
    }
    if (!sameOrigin(parsed.origin, expectedOrigin)) {
      throw new HttpError(403, "Neplatný původ požadavku");
    }
    return;
  }

  throw new HttpError(403, "Neplatný původ požadavku");
}

export async function verifyTurnstileToken({
  request,
  env,
  token,
  expectedAction,
}) {
  if (isLocalBypassAllowed(request, env)) {
    return;
  }

  const secret = String(env.TURNSTILE_SECRET_KEY || "").trim();
  if (!secret) {
    throw new HttpError(500, "Turnstile není nastaven");
  }
  if (!token) {
    throw new HttpError(400, "Turnstile je povinný");
  }

  const form = new URLSearchParams({
    secret,
    response: String(token).trim(),
  });
  const remoteip = clientIp(request);
  if (remoteip && remoteip !== "unknown") {
    form.set("remoteip", remoteip);
  }

  let response;
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: form,
    });
  } catch (error) {
    throw new HttpError(502, "Ověření Turnstile selhalo");
  }

  if (!response.ok) {
    throw new HttpError(502, "Ověření Turnstile selhalo");
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch (error) {
    throw new HttpError(502, "Ověření Turnstile selhalo");
  }

  if (!payload.success) {
    throw new HttpError(400, "Ověření Turnstile selhalo");
  }

  const allowedHosts = allowedTurnstileHostnames(request, env);
  const payloadHostname = String(payload.hostname || "")
    .trim()
    .toLowerCase();
  if (!payloadHostname || !allowedHosts.has(payloadHostname)) {
    throw new HttpError(400, "Neplatný Turnstile hostname");
  }

  if (expectedAction) {
    const payloadAction = String(payload.action || "").trim();
    if (payloadAction !== expectedAction) {
      throw new HttpError(400, "Neplatná Turnstile akce");
    }
  }
}

export async function hasValidSession(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = parseCookies(cookieHeader);
  const raw = cookies[SESSION_COOKIE_NAME];
  if (!raw) return false;

  const [expStr, sig] = raw.split(".", 2);
  if (!expStr || !sig || !/^\d+$/.test(expStr)) return false;

  const exp = Number(expStr);
  if (exp < Math.floor(Date.now() / 1000)) return false;

  const secret = sessionSecret(request, env);
  if (!secret) return false;

  const expected = await hmacSign(secret, expStr);
  return timingSafeEqual(expected, sig);
}

export async function buildSessionCookie(request, env) {
  const secret = sessionSecret(request, env);
  if (!secret) {
    throw new HttpError(500, "Chybí session secret");
  }

  const ttlSeconds = parseIntEnv(
    env.TURNSTILE_SESSION_TTL_SECONDS,
    3600,
    60,
    7 * 24 * 60 * 60,
  );
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await hmacSign(secret, String(exp));
  const value = `${exp}.${sig}`;
  const isSecure = getRequestUrl(request).protocol === "https:";
  const cookie = [
    `${SESSION_COOKIE_NAME}=${value}`,
    `Max-Age=${ttlSeconds}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    isSecure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");

  return { cookie, ttlSeconds };
}

export async function buildVoterKey(request, env) {
  const secret = voterKeySecret(request, env);
  if (!secret) return "";
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = parseCookies(cookieHeader);
  const sessionValue = String(cookies[SESSION_COOKIE_NAME] || "");
  const keyMaterial = `${secret}:${clientIp(request)}:${sessionValue}`;
  return sha256Hex(keyMaterial);
}

function maxForBucket(env, bucket) {
  if (bucket === "verify") {
    return parseIntEnv(env.API_RATE_LIMIT_VERIFY_MAX, 15, 1, 10000);
  }
  return parseIntEnv(env.API_RATE_LIMIT_WRITE_MAX, 30, 1, 10000);
}

export async function enforceRateLimit({ request, env, bucket }) {
  if (!env.CORRECTIONS_DB) {
    throw new HttpError(500, "Chybí CORRECTIONS_DB");
  }
  const secret = rateLimitSecret(request, env);
  if (!secret) {
    throw new HttpError(500, "Chybí API rate-limit secret");
  }

  const windowSeconds = parseIntEnv(
    env.API_RATE_LIMIT_WINDOW_SECONDS,
    3600,
    60,
    7 * 24 * 60 * 60,
  );
  const now = Math.floor(Date.now() / 1000);
  const windowEpoch = now - (now % windowSeconds);
  const keyMaterial = `${secret}:${clientIp(request)}:${bucket}:${windowEpoch}`;
  const key = await sha256Hex(keyMaterial);

  await env.CORRECTIONS_DB.prepare(
    `
      INSERT INTO api_rate_limits ("key", bucket, window_epoch, count, updated_at)
      VALUES (?, ?, ?, 1, datetime('now'))
      ON CONFLICT("key") DO UPDATE SET
        count = api_rate_limits.count + 1,
        updated_at = datetime('now')
    `,
  )
    .bind(key, bucket, windowEpoch)
    .run();

  const row = await env.CORRECTIONS_DB.prepare(
    `SELECT count FROM api_rate_limits WHERE "key" = ?`,
  )
    .bind(key)
    .first();
  const count = Number(row?.count || 0);
  const limit = maxForBucket(env, bucket);

  if (now % 17 === 0) {
    const cutoff = windowEpoch - windowSeconds * 4;
    env.CORRECTIONS_DB.prepare(
      `DELETE FROM api_rate_limits WHERE window_epoch < ?`,
    )
      .bind(cutoff)
      .run()
      .catch(() => {});
  }

  if (count > limit) {
    const retryAfter = Math.max(1, windowEpoch + windowSeconds - now);
    throw new HttpError(429, "Příliš mnoho požadavků", {
      "Retry-After": String(retryAfter),
    });
  }
}

export function toHttpError(error, fallbackStatus = 400, fallbackDetail = "Chyba") {
  if (error instanceof HttpError) return error;
  const status = Number(error?.status || error?.statusCode || fallbackStatus);
  const detail = String(error?.detail || error?.message || fallbackDetail);
  const headers = error?.headers && typeof error.headers === "object"
    ? error.headers
    : {};
  return new HttpError(status, detail, headers);
}
