import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const dataDirectory = process.env.COMMUNITY_DATA_DIR
  ? path.resolve(process.env.COMMUNITY_DATA_DIR)
  : path.join(repositoryRoot, "viewer", "static", "data");
const sourceNames = [
  "photos.geojson",
  "orphan_xids.json",
  "similarity_candidates.json",
  "series_version_clusters.json",
];
const optionalSourceNames = new Set([
  "orphan_xids.json",
  "similarity_candidates.json",
  "series_version_clusters.json",
]);
const hash = createHash("sha256");

for (const name of sourceNames) {
  hash.update(name);
  hash.update("\0");
  try {
    hash.update(await readFile(path.join(dataDirectory, name)));
  } catch (error) {
    if (error?.code !== "ENOENT" || !optionalSourceNames.has(name)) throw error;
    hash.update("<missing>");
  }
  hash.update("\0");
}

const payload = {
  version: `sha256:${hash.digest("hex")}`,
  sources: sourceNames,
};
await writeFile(
  path.join(dataDirectory, "community-data-version.json"),
  `${JSON.stringify(payload, null, 2)}\n`,
);
