import { isLocalBypassAllowed } from "./_security.js";

const ARCHIVE_DEFAULT = "https://katalog.ahmp.cz/pragapublica";

export async function onRequest({ request, env }) {
  const payload = {
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || "",
    turnstileBypass: isLocalBypassAllowed(request, env),
    archiveBaseUrl: (env.ARCHIVE_BASE_URL || ARCHIVE_DEFAULT).replace(/\/$/, ""),
  };

  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
