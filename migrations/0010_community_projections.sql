CREATE TABLE IF NOT EXISTS current_merge_decisions (
  pair_key TEXT PRIMARY KEY,
  source_event_id INTEGER NOT NULL,
  group_id_a TEXT NOT NULL,
  group_id_b TEXT NOT NULL,
  verdict TEXT NOT NULL,
  voter_key TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

INSERT OR REPLACE INTO current_merge_decisions (
  pair_key, source_event_id, group_id_a, group_id_b, verdict,
  voter_key, user_agent, created_at
)
SELECT
  group_id_a || '::' || group_id_b,
  id,
  group_id_a,
  group_id_b,
  verdict,
  voter_key,
  user_agent,
  created_at
FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY group_id_a, group_id_b
    ORDER BY created_at DESC, id DESC
  ) AS row_number
  FROM merge_decisions
)
WHERE row_number = 1;

CREATE TABLE IF NOT EXISTS current_group_review_votes (
  group_id TEXT NOT NULL,
  voter_identity TEXT NOT NULL,
  source_event_id INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  voter_key TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, voter_identity)
);

INSERT OR REPLACE INTO current_group_review_votes (
  group_id, voter_identity, source_event_id, verdict,
  voter_key, user_agent, created_at
)
SELECT
  group_id,
  COALESCE(NULLIF(voter_key, ''), 'legacy:' || id),
  id,
  verdict,
  voter_key,
  user_agent,
  created_at
FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY group_id, COALESCE(NULLIF(voter_key, ''), 'legacy:' || id)
    ORDER BY created_at DESC, id DESC
  ) AS row_number
  FROM group_review_votes
)
WHERE row_number = 1;

CREATE TABLE IF NOT EXISTS community_state_projection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_revision INTEGER NOT NULL DEFAULT 0,
  computed_revision INTEGER NOT NULL DEFAULT -1,
  data_version TEXT NOT NULL DEFAULT '',
  payload_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO community_state_projection (id) VALUES (1);

CREATE TRIGGER IF NOT EXISTS merge_decisions_project_current
AFTER INSERT ON merge_decisions
BEGIN
  INSERT INTO current_merge_decisions (
    pair_key, source_event_id, group_id_a, group_id_b, verdict,
    voter_key, user_agent, created_at
  ) VALUES (
    NEW.group_id_a || '::' || NEW.group_id_b,
    NEW.id, NEW.group_id_a, NEW.group_id_b, NEW.verdict,
    NEW.voter_key, NEW.user_agent, NEW.created_at
  )
  ON CONFLICT(pair_key) DO UPDATE SET
    source_event_id = excluded.source_event_id,
    verdict = excluded.verdict,
    voter_key = excluded.voter_key,
    user_agent = excluded.user_agent,
    created_at = excluded.created_at;

  UPDATE community_state_projection
  SET current_revision = current_revision + 1
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS corrections_mark_projection_dirty
AFTER INSERT ON corrections
BEGIN
  UPDATE community_state_projection
  SET current_revision = current_revision + 1
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS group_review_votes_project_current
AFTER INSERT ON group_review_votes
BEGIN
  INSERT INTO current_group_review_votes (
    group_id, voter_identity, source_event_id, verdict,
    voter_key, user_agent, created_at
  ) VALUES (
    NEW.group_id,
    COALESCE(NULLIF(NEW.voter_key, ''), 'legacy:' || NEW.id),
    NEW.id, NEW.verdict, NEW.voter_key, NEW.user_agent, NEW.created_at
  )
  ON CONFLICT(group_id, voter_identity) DO UPDATE SET
    source_event_id = excluded.source_event_id,
    verdict = excluded.verdict,
    voter_key = excluded.voter_key,
    user_agent = excluded.user_agent,
    created_at = excluded.created_at;
END;

CREATE TRIGGER IF NOT EXISTS membership_overrides_mark_projection_dirty_insert
AFTER INSERT ON group_membership_overrides
BEGIN
  UPDATE community_state_projection
  SET current_revision = current_revision + 1
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS membership_overrides_mark_projection_dirty_update
AFTER UPDATE ON group_membership_overrides
BEGIN
  UPDATE community_state_projection
  SET current_revision = current_revision + 1
  WHERE id = 1;
END;
