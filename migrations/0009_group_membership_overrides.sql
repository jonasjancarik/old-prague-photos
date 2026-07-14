CREATE TABLE IF NOT EXISTS group_membership_overrides (
  xid TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  source_group_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  curator TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_group_membership_overrides_group
  ON group_membership_overrides (group_id, xid);

CREATE TABLE IF NOT EXISTS group_membership_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_group_id TEXT NOT NULL,
  target_group_id TEXT NOT NULL,
  assignments_json TEXT NOT NULL,
  reason TEXT,
  curator TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_group_membership_events_created
  ON group_membership_events (created_at);
