ALTER TABLE merge_decisions ADD COLUMN voter_key TEXT;
ALTER TABLE merge_decisions ADD COLUMN user_agent TEXT;

CREATE INDEX IF NOT EXISTS idx_merge_decisions_pair_created
  ON merge_decisions (group_id_a, group_id_b, created_at);
