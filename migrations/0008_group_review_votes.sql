CREATE TABLE IF NOT EXISTS group_review_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  voter_key TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_group_review_votes_group_created
  ON group_review_votes (group_id, created_at);

CREATE INDEX IF NOT EXISTS idx_group_review_votes_group_voter_created
  ON group_review_votes (group_id, voter_key, created_at);
