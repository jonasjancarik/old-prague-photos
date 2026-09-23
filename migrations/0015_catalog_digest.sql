-- The source digest describes the normalized rows in catalog_photos.  Keep the
-- legacy empty value so an already seeded database can be upgraded safely.
ALTER TABLE catalog_metadata
ADD COLUMN catalog_digest TEXT NOT NULL DEFAULT '';
