CREATE TABLE IF NOT EXISTS merge_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id_a TEXT NOT NULL,
  group_id_b TEXT NOT NULL,
  verdict TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_merge_decisions_pair
  ON merge_decisions (group_id_a, group_id_b);
