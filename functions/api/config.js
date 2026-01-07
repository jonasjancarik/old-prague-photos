const ARCHIVE_DEFAULT = "https://katalog.ahmp.cz/pragapublica";

function parseBool(value) {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export async function onRequest({ env }) {
  const payload = {
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || "",
    turnstileBypass: parseBool(env.TURNSTILE_BYPASS),
    archiveBaseUrl: (env.ARCHIVE_BASE_URL || ARCHIVE_DEFAULT).replace(/\/$/, ""),
  };

  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
