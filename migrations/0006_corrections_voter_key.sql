ALTER TABLE corrections ADD COLUMN voter_key TEXT;

CREATE INDEX IF NOT EXISTS idx_corrections_group_created
  ON corrections (group_id, created_at);

CREATE INDEX IF NOT EXISTS idx_corrections_group_verdict_created
  ON corrections (group_id, verdict, created_at);
