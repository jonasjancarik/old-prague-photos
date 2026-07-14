CREATE TABLE IF NOT EXISTS community_operation_metrics (
  bucket_hour TEXT NOT NULL,
  metric TEXT NOT NULL,
  flow TEXT NOT NULL DEFAULT '',
  status_code INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bucket_hour, metric, flow, status_code)
);

CREATE INDEX IF NOT EXISTS idx_community_operation_metrics_bucket
ON community_operation_metrics (bucket_hour);

CREATE INDEX IF NOT EXISTS idx_corrections_created
ON corrections (created_at);

CREATE INDEX IF NOT EXISTS idx_corrections_voter_created
ON corrections (voter_key, created_at);

CREATE INDEX IF NOT EXISTS idx_merge_decisions_created
ON merge_decisions (created_at);

CREATE INDEX IF NOT EXISTS idx_merge_decisions_voter_created
ON merge_decisions (voter_key, created_at);

CREATE INDEX IF NOT EXISTS idx_group_review_votes_created
ON group_review_votes (created_at);

CREATE INDEX IF NOT EXISTS idx_group_review_votes_voter_created
ON group_review_votes (voter_key, created_at);

CREATE TRIGGER IF NOT EXISTS community_operation_metrics_prune_insert
AFTER INSERT ON community_operation_metrics
BEGIN
  DELETE FROM community_operation_metrics
  WHERE julianday(bucket_hour) < julianday('now', '-90 days');
END;

CREATE TRIGGER IF NOT EXISTS community_operation_metrics_prune_update
AFTER UPDATE OF count ON community_operation_metrics
BEGIN
  DELETE FROM community_operation_metrics
  WHERE julianday(bucket_hour) < julianday('now', '-90 days');
END;
