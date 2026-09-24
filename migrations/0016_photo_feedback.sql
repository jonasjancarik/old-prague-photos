CREATE TABLE IF NOT EXISTS photo_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL UNIQUE,
  xid TEXT NOT NULL,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 5 AND 2000),
  email TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_photo_feedback_status_id
ON photo_feedback (status, id);
