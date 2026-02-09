import { buildReviewState, loadXidGroupMap } from "./_review_state.js";

const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SESSION_COOKIE_NAME = "opp_turnstile_session";

function parseBool(value) {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
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

function sessionSecret(env) {
  return (env.TURNSTILE_SESSION_SECRET || env.TURNSTILE_SECRET_KEY || "").trim();
}

async function hasValidSession(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = parseCookies(cookieHeader);
  const raw = cookies[SESSION_COOKIE_NAME];
  if (!raw) return false;
  const [expStr, sig] = raw.split(".", 2);
  if (!expStr || !sig || !/^\d+$/.test(expStr)) return false;
  const exp = Number(expStr);
  if (exp < Math.floor(Date.now() / 1000)) return false;
  const secret = sessionSecret(env);
  if (!secret && parseBool(env.TURNSTILE_BYPASS)) {
    return true;
  }
  if (!secret) return false;
  const expected = await hmacSign(secret, expStr);
  return timingSafeEqual(expected, sig);
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

async function loadReviewState(request, env) {
  const correctionsResult = await env.CORRECTIONS_DB.prepare(
    `
      SELECT
        id,
        xid,
        group_id,
        lat,
        lon,
        has_coordinates,
        verdict,
        created_at
      FROM corrections
    `,
  ).all();
  const correctionRows = correctionsResult?.results || [];

  let mergeRows = [];
  try {
    const mergesResult = await env.CORRECTIONS_DB.prepare(
      `
        SELECT
          id,
          group_id_a,
          group_id_b,
          verdict,
          created_at
        FROM merge_decisions
      `,
    ).all();
    mergeRows = mergesResult?.results || [];
  } catch (error) {
    mergeRows = [];
  }

  const xidGroupMap = await loadXidGroupMap(request, env);
  return buildReviewState({
    correctionRows,
    mergeRows,
    xidGroupMap,
  });
}

async function handleGet(request, env) {
  const reviewState = await loadReviewState(request, env);
  const items = reviewState.groupCorrections || [];
  return jsonResponse({ items, count: items.length });
}

async function handlePost(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (error) {
    return jsonResponse({ detail: "Neplatný JSON" }, 400);
  }

  const xid = String(body?.xid || "").trim();
  if (!xid) {
    return jsonResponse({ detail: "Chybí xid" }, 400);
  }

  const groupId = String(body?.group_id || "").trim();
  const lat = body?.lat ?? null;
  const lon = body?.lon ?? null;
  const hasCoordinates = lat !== null && lon !== null;

  const verdictRaw = body?.verdict ? String(body.verdict).trim().toLowerCase() : "";
  let verdict = verdictRaw;
  if (!verdict) {
    verdict = hasCoordinates ? "wrong" : "flag";
  }
  if (!["ok", "wrong", "flag"].includes(verdict)) {
    return jsonResponse({ detail: "Neplatný typ hlášení" }, 400);
  }

  if ((lat === null) !== (lon === null)) {
    return jsonResponse({ detail: "Neplatná poloha" }, 400);
  }

  if (verdict === "ok" && hasCoordinates) {
    return jsonResponse({ detail: "Potvrzení OK nesmí obsahovat polohu" }, 400);
  }

  if (verdict === "wrong" && !hasCoordinates) {
    return jsonResponse({ detail: "Pro opravu je nutná poloha" }, 400);
  }

  if (hasCoordinates) {
    const latNum = Number(lat);
    const lonNum = Number(lon);
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
      return jsonResponse({ detail: "Neplatná poloha" }, 400);
    }
    if (latNum < -90 || latNum > 90 || lonNum < -180 || lonNum > 180) {
      return jsonResponse({ detail: "Neplatná poloha" }, 400);
    }
  }

  const email = String(body?.email || "").trim();
  if (email && !EMAIL_PATTERN.test(email)) {
    return jsonResponse({ detail: "Neplatný e-mail" }, 400);
  }

  const message = String(body?.message || "Nahlášena špatná poloha.").trim();

  const hasSession = await hasValidSession(request, env);
  if (!hasSession) {
    try {
      await verifyTurnstile(
        body?.token,
        env,
        request.headers.get("CF-Connecting-IP"),
      );
    } catch (error) {
      return jsonResponse({ detail: error.message || "Ověření selhalo" }, 400);
    }
  }

  const xidGroupMap = await loadXidGroupMap(request, env);
  const mappedGroupId = xidGroupMap.get(xid) || "";
  if (xidGroupMap.size > 0 && !mappedGroupId) {
    return jsonResponse({ detail: "Neznámé xid" }, 400);
  }
  if (mappedGroupId && groupId && groupId !== mappedGroupId) {
    return jsonResponse({ detail: "Neplatná skupina pro xid" }, 400);
  }
  const canonicalGroupId = mappedGroupId || groupId || xid;

  const statement = env.CORRECTIONS_DB.prepare(
    `
      INSERT INTO corrections (
        xid,
        group_id,
        lat,
        lon,
        has_coordinates,
        verdict,
        message,
        email,
        user_agent
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).bind(
    xid,
    canonicalGroupId || null,
    hasCoordinates ? Number(lat) : null,
    hasCoordinates ? Number(lon) : null,
    hasCoordinates ? 1 : 0,
    verdict,
    message,
    email || null,
    request.headers.get("User-Agent") || "",
  );

  await statement.run();

  return jsonResponse({ ok: true });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "GET") {
    return handleGet(request, env);
  }

  if (request.method === "POST") {
    return handlePost(request, env);
  }

  return jsonResponse({ detail: "Method Not Allowed" }, 405);
}
