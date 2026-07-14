import { isLocalBypassAllowed } from "./_security.js";

export const ADMIN_SESSION_COOKIE_NAME = "opp_admin_session";
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

function jsonResponse(payload, status, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function parseCookies(header) {
  const cookies = {};
  String(header || "").split(";").forEach((part) => {
    const [key, ...rest] = part.trim().split("=");
    if (key) cookies[key] = rest.join("=");
  });
  return cookies;
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
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

function configuredToken(env) {
  return String(env.ADMIN_API_TOKEN || "").trim();
}

function sessionTtl(env) {
  const parsed = Number.parseInt(String(env.ADMIN_SESSION_TTL_SECONDS || ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_SECONDS;
  return Math.min(24 * 60 * 60, Math.max(15 * 60, parsed));
}

function cookieAttributes(request, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `Path=/api/admin; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`;
}

export function hasValidAdminToken(suppliedToken, env) {
  const expected = configuredToken(env);
  const supplied = String(suppliedToken || "").trim();
  return Boolean(expected && supplied && constantTimeEqual(expected, supplied));
}

export async function buildAdminSessionCookie(request, env) {
  const secret = configuredToken(env);
  if (!secret) return "";
  const ttl = sessionTtl(env);
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const payload = `v1.${expiresAt}`;
  const signature = await hmacSign(secret, payload);
  return `${ADMIN_SESSION_COOKIE_NAME}=${payload}.${signature}; ${cookieAttributes(request, ttl)}`;
}

export function clearAdminSessionCookie(request) {
  return `${ADMIN_SESSION_COOKIE_NAME}=; ${cookieAttributes(request, 0)}`;
}

async function hasValidAdminSession(request, env) {
  const secret = configuredToken(env);
  if (!secret) return false;
  const value = parseCookies(request.headers.get("Cookie"))[
    ADMIN_SESSION_COOKIE_NAME
  ];
  const match = /^v1\.(\d+)\.([a-f0-9]{64})$/u.exec(String(value || ""));
  if (!match) return false;
  const expiresAt = Number(match[1]);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  if (expiresAt > now + sessionTtl(env) + 60) return false;
  const expected = await hmacSign(secret, `v1.${expiresAt}`);
  return constantTimeEqual(expected, match[2]);
}

export async function authorizeAdmin(request, env) {
  if (isLocalBypassAllowed(request, env)) return null;

  const authorization = String(request.headers.get("Authorization") || "");
  const bearerToken = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (
    hasValidAdminToken(bearerToken, env) ||
    (await hasValidAdminSession(request, env))
  ) {
    return null;
  }

  return jsonResponse(
    { detail: "Pro tuto část je potřeba přihlášení správce" },
    401,
    { "WWW-Authenticate": "Bearer" },
  );
}
