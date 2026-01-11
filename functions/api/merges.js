const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

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

async function handleGet(env) {
  const query = `
    WITH latest AS (
      SELECT group_id_a, group_id_b, MAX(id) AS any_id
      FROM merge_decisions
      GROUP BY group_id_a, group_id_b
    )
    SELECT
      m.group_id_a,
      m.group_id_b,
      m.verdict,
      m.created_at AS received_at
    FROM latest l
    JOIN merge_decisions m ON m.id = l.any_id
  `;

  const result = await env.CORRECTIONS_DB.prepare(query).all();
  const items = result?.results || [];
  return jsonResponse({ items, count: items.length });
}

async function handlePost(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (error) {
    return jsonResponse({ detail: "Neplatný JSON" }, 400);
  }

  let groupIdA = String(body?.group_id_a || "").trim();
  let groupIdB = String(body?.group_id_b || "").trim();
  if (!groupIdA || !groupIdB) {
    return jsonResponse({ detail: "Chybí skupina" }, 400);
  }
  if (groupIdA === groupIdB) {
    return jsonResponse({ detail: "Nelze sloučit stejnou skupinu" }, 400);
  }

  let verdict = String(body?.verdict || "").trim().toLowerCase();
  if (!verdict) verdict = "same";
  if (!["same", "different"].includes(verdict)) {
    return jsonResponse({ detail: "Neplatný typ rozhodnutí" }, 400);
  }

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

  if (groupIdA > groupIdB) {
    [groupIdA, groupIdB] = [groupIdB, groupIdA];
  }

  const statement = env.CORRECTIONS_DB.prepare(
    `
      INSERT INTO merge_decisions (
        group_id_a,
        group_id_b,
        verdict
      )
      VALUES (?, ?, ?)
    `,
  ).bind(groupIdA, groupIdB, verdict);

  await statement.run();

  return jsonResponse({ ok: true });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "GET") {
    return handleGet(env);
  }

  if (request.method === "POST") {
    return handlePost(request, env);
  }

  return jsonResponse({ detail: "Method Not Allowed" }, 405);
}
