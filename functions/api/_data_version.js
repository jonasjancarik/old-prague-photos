const versionByAssets = new WeakMap();

function normalizeVersion(value) {
  return String(value || "").trim();
}

export async function loadCommunityDataVersion(request, env) {
  const configured = normalizeVersion(env?.COMMUNITY_DATA_VERSION);
  if (configured) return configured;
  if (!request || !env?.ASSETS?.fetch) {
    throw new Error("Missing community data version source");
  }

  let versionPromise = versionByAssets.get(env.ASSETS);
  if (!versionPromise) {
    versionPromise = (async () => {
      const url = new URL("/data/community-data-version.json", request.url);
      const response = await env.ASSETS.fetch(new Request(url.toString()));
      if (!response.ok) {
        throw new Error(`Community data version request failed: ${response.status}`);
      }
      const payload = await response.json();
      const version = normalizeVersion(payload?.version);
      if (!version) throw new Error("Community data version is empty");
      return version;
    })();
    versionByAssets.set(env.ASSETS, versionPromise);
  }

  try {
    return await versionPromise;
  } catch (error) {
    versionByAssets.delete(env.ASSETS);
    throw error;
  }
}
