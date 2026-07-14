import { isLocalBypassAllowed } from "./_security.js";

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

export function authorizeAdmin(request, env) {
  if (isLocalBypassAllowed(request, env)) return null;

  const configuredToken = String(env.ADMIN_API_TOKEN || "").trim();
  const authorization = String(request.headers.get("Authorization") || "");
  const suppliedToken = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (
    configuredToken &&
    suppliedToken &&
    constantTimeEqual(configuredToken, suppliedToken)
  ) {
    return null;
  }

  return jsonResponse(
    { detail: "Pro tuto část je potřeba přihlášení správce" },
    401,
    { "WWW-Authenticate": "Bearer" },
  );
}
