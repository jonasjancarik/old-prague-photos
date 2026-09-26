-- Independent of community projections; editor revision and public revision differ.
CREATE TABLE photo_annotations (
  xid TEXT PRIMARY KEY REFERENCES catalog_photos(xid),
  revision INTEGER NOT NULL CHECK(revision > 0),
  state TEXT NOT NULL CHECK(state IN ('draft','published','withdrawn')),
  draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
  evidence_note TEXT NOT NULL DEFAULT '',
  published_json TEXT CHECK(published_json IS NULL OR json_valid(published_json)),
  updated_at TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE TABLE photo_annotation_history (
  xid TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL,
  draft_json TEXT NOT NULL, evidence_note TEXT NOT NULL,
  published_json TEXT, updated_at TEXT NOT NULL, actor TEXT NOT NULL,
  PRIMARY KEY(xid, revision)
);
CREATE TABLE photo_annotation_metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  metadata_revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO photo_annotation_metadata(singleton) VALUES(1);
CREATE TRIGGER photo_annotation_insert AFTER INSERT ON photo_annotations BEGIN
  INSERT INTO photo_annotation_history SELECT * FROM photo_annotations WHERE xid = NEW.xid;
  UPDATE photo_annotation_metadata SET metadata_revision = metadata_revision + 1
    WHERE NEW.published_json IS NOT NULL;
END;
CREATE TRIGGER photo_annotation_update AFTER UPDATE ON photo_annotations BEGIN
  INSERT INTO photo_annotation_history SELECT * FROM photo_annotations WHERE xid = NEW.xid;
  UPDATE photo_annotation_metadata SET metadata_revision = metadata_revision + 1
    WHERE OLD.published_json IS NOT NEW.published_json;
END;

-- Maintain indexed place lookups as catalog chunks are imported; parse each
-- changed record once on import, never the entire catalog on an admin request.
CREATE TABLE catalog_place_members (
  place_id TEXT NOT NULL,
  xid TEXT NOT NULL REFERENCES catalog_photos(xid) ON DELETE CASCADE,
  entity_json TEXT NOT NULL CHECK(json_valid(entity_json)),
  PRIMARY KEY(place_id, xid)
) WITHOUT ROWID;
CREATE INDEX catalog_place_members_xid ON catalog_place_members(xid);
INSERT INTO catalog_place_members
 SELECT json_extract(p.value,'$.id'), c.xid, p.value
 FROM catalog_photos c, json_each(c.feature_json,'$.places') p
 WHERE json_extract(p.value,'$.id') IS NOT NULL;
CREATE TRIGGER catalog_places_insert AFTER INSERT ON catalog_photos BEGIN
 INSERT INTO catalog_place_members SELECT json_extract(value,'$.id'),NEW.xid,value
 FROM json_each(NEW.feature_json,'$.places') WHERE json_extract(value,'$.id') IS NOT NULL;
END;
CREATE TRIGGER catalog_places_update AFTER UPDATE OF feature_json ON catalog_photos BEGIN
 DELETE FROM catalog_place_members WHERE xid=NEW.xid;
 INSERT INTO catalog_place_members SELECT json_extract(value,'$.id'),NEW.xid,value
 FROM json_each(NEW.feature_json,'$.places') WHERE json_extract(value,'$.id') IS NOT NULL;
END;
