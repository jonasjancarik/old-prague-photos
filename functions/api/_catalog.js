import { loadCommunityDataVersion } from "./_data_version.js";

export class CatalogUnavailableError extends Error {
  constructor(message = "The photo catalog is not ready") {
    super(message);
    this.name = "CatalogUnavailableError";
  }
}

export async function requireCatalog(request, env) {
  if (!env?.CORRECTIONS_DB) throw new CatalogUnavailableError();
  const expectedVersion = await loadCommunityDataVersion(request, env);
  const metadata = await env.CORRECTIONS_DB.prepare(
    "SELECT data_version, row_count FROM catalog_metadata WHERE singleton = 1",
  ).first();
  if (
    !metadata ||
    String(metadata.data_version || "") !== expectedVersion ||
    !Number.isSafeInteger(Number(metadata.row_count)) ||
    Number(metadata.row_count) < 1
  ) {
    throw new CatalogUnavailableError();
  }
  return { dataVersion: expectedVersion, rowCount: Number(metadata.row_count) };
}

export async function findCatalogPhoto(env, xid) {
  const id = String(xid || "").trim();
  if (!id) return null;
  return env.CORRECTIONS_DB.prepare(
    `SELECT p.xid, p.base_group_id, p.source_lon, p.source_lat,
            p.feature_json,
            COALESCE(o.group_id, p.base_group_id) AS current_group_id
       FROM catalog_photos AS p
       LEFT JOIN group_membership_overrides AS o ON o.xid = p.xid
      WHERE p.xid = ?`,
  ).bind(id).first();
}

export async function catalogGroupExists(env, groupId) {
  const id = String(groupId || "").trim();
  if (!id) return false;
  const row = await env.CORRECTIONS_DB.prepare(
    `SELECT 1 AS found WHERE
       EXISTS(
         SELECT 1 FROM catalog_photos AS p
         WHERE p.base_group_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM group_membership_overrides AS moved
             WHERE moved.xid = p.xid
           )
       )
       OR EXISTS(SELECT 1 FROM group_membership_overrides WHERE group_id = ?)`,
  ).bind(id, id).first();
  return Boolean(row?.found);
}

export function catalogFeature(row) {
  if (!row) return null;
  const properties = JSON.parse(String(row.feature_json || "{}"));
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [Number(row.source_lon), Number(row.source_lat)],
    },
    properties: {
      ...properties,
      id: String(row.xid),
      group_id: String(row.base_group_id),
    },
  };
}
