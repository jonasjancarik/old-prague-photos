-- Run only against an isolated, migrated local database.
CREATE TABLE annotation_assertions (value INTEGER NOT NULL CHECK(value=1));
CREATE TABLE annotation_before AS SELECT current_revision FROM community_state_projection WHERE id=1;
INSERT INTO catalog_photos(xid,base_group_id,source_lon,source_lat,feature_json,search_text)
 VALUES('ANNOTATION_SMOKE_X1','ANNOTATION_SMOKE_G1',14.4,50.1,'{}','');
INSERT INTO photo_annotations VALUES('ANNOTATION_SMOKE_X1',1,'draft','{"public_text":"draft","place_mode":"keep","place_ids":[],"disputed_place_ids":[]}','private evidence',NULL,'now','authenticated-admin');
INSERT INTO annotation_assertions SELECT metadata_revision=0 FROM photo_annotation_metadata;
UPDATE photo_annotations SET revision=2,state='published',published_json='{"xid":"ANNOTATION_SMOKE_X1","revision":2,"public_text":"verified","place_mode":"keep","place_ids":[],"disputed_place_ids":[],"published_at":"now"}' WHERE xid='ANNOTATION_SMOKE_X1' AND revision=1;
INSERT INTO annotation_assertions SELECT metadata_revision=1 FROM photo_annotation_metadata;
UPDATE photo_annotations SET revision=3,state='draft',draft_json='{"public_text":"new draft"}' WHERE xid='ANNOTATION_SMOKE_X1' AND revision=2;
INSERT INTO annotation_assertions SELECT metadata_revision=1 FROM photo_annotation_metadata;
INSERT INTO annotation_assertions SELECT json_extract(published_json,'$.public_text')='verified' FROM photo_annotations WHERE xid='ANNOTATION_SMOKE_X1';
UPDATE photo_annotations SET revision=4,state='withdrawn',published_json=NULL WHERE xid='ANNOTATION_SMOKE_X1' AND revision=3;
INSERT INTO annotation_assertions SELECT metadata_revision=2 FROM photo_annotation_metadata;
INSERT INTO annotation_assertions SELECT COUNT(*)=4 FROM photo_annotation_history WHERE xid='ANNOTATION_SMOKE_X1';
INSERT INTO annotation_assertions SELECT current_revision=(SELECT current_revision FROM annotation_before) FROM community_state_projection WHERE id=1;
INSERT INTO annotation_assertions SELECT source_lon=14.4 AND source_lat=50.1 FROM catalog_photos WHERE xid='ANNOTATION_SMOKE_X1';
SELECT COUNT(*) AS passed_assertions FROM annotation_assertions;
