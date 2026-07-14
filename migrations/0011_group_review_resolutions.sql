CREATE TABLE IF NOT EXISTS group_review_resolutions (
  group_id TEXT PRIMARY KEY,
  through_event_id INTEGER NOT NULL,
  curator TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_group_review_resolutions_resolved_at
  ON group_review_resolutions (resolved_at);
