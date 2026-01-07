const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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
    WITH latest_any AS (
      SELECT xid, MAX(id) AS any_id
      FROM corrections
      GROUP BY xid
    ),
    latest_coords AS (
      SELECT xid, MAX(id) AS coord_id
      FROM corrections
      WHERE has_coordinates = 1
      GROUP BY xid
    )
    SELECT
      a.xid,
      a.verdict,
      a.created_at AS received_at,
      c.lat,
      c.lon,
      COALESCE(c.has_coordinates, 0) AS has_coordinates
    FROM latest_any la
    JOIN corrections a ON a.xid = la.xid AND a.id = la.any_id
    LEFT JOIN latest_coords lc ON lc.xid = a.xid
    LEFT JOIN corrections c ON c.xid = a.xid AND c.id = lc.coord_id
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

  const xid = String(body?.xid || "").trim();
  if (!xid) {
    return jsonResponse({ detail: "Chybí xid" }, 400);
  }

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

  try {
    await verifyTurnstile(
      body?.token,
      env,
      request.headers.get("CF-Connecting-IP"),
    );
  } catch (error) {
    return jsonResponse({ detail: error.message || "Ověření selhalo" }, 400);
  }

  const statement = env.CORRECTIONS_DB.prepare(
    `
      INSERT INTO corrections (
        xid,
        lat,
        lon,
        has_coordinates,
        verdict,
        message,
        email,
        user_agent
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).bind(
    xid,
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
    return handleGet(env);
  }

  if (request.method === "POST") {
    return handlePost(request, env);
  }

  return jsonResponse({ detail: "Method Not Allowed" }, 405);
}
