-- Immutable, source-derived photo catalogue used by the public read API.
-- Community grouping changes are stored separately so this source assignment
-- remains stable across catalogue refreshes.
CREATE TABLE IF NOT EXISTS catalog_photos (
  xid TEXT PRIMARY KEY,
  base_group_id TEXT NOT NULL,
  source_lon REAL NOT NULL CHECK (source_lon >= -180 AND source_lon <= 180),
  source_lat REAL NOT NULL CHECK (source_lat >= -90 AND source_lat <= 90),
  feature_json TEXT NOT NULL CHECK (json_valid(feature_json)),
  search_text TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_catalog_photos_base_group_id
ON catalog_photos (base_group_id);

CREATE TRIGGER IF NOT EXISTS catalog_photos_base_group_id_immutable
BEFORE UPDATE OF base_group_id ON catalog_photos
WHEN OLD.base_group_id <> NEW.base_group_id
BEGIN
  SELECT RAISE(ABORT, 'catalog_photos.base_group_id is immutable');
END;

-- Exactly one row describes the source snapshot loaded into catalog_photos.
CREATE TABLE IF NOT EXISTS catalog_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  data_version TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0)
) WITHOUT ROWID;
