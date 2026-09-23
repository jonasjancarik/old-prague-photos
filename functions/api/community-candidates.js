// Candidate ordering and pagination now run in the browser against the
// versioned static catalog and compact /api/review-state overlay. Rebuilding
// every group inside a Pages Function exceeds the Workers Free CPU limit.
function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export function onRequest({ request }) {
  if (request.method !== "GET") {
    return jsonResponse({ detail: "Method Not Allowed" }, 405);
  }
  return jsonResponse({ detail: "Tato adresa se již nepoužívá." }, 410);
}
