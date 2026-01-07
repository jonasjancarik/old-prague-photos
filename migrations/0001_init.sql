CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  xid TEXT NOT NULL,
  lat REAL,
  lon REAL,
  has_coordinates INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  email TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_corrections_xid ON corrections (xid);
