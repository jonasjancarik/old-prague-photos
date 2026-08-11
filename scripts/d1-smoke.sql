INSERT INTO corrections (
  xid, group_id, has_coordinates, voter_key, verdict, location_revision
) VALUES (
  'SMOKE_X1', 'SMOKE_G1', 0, 'smoke-voter-a', 'ok', '["SMOKE_G1",null]'
);

INSERT INTO merge_decisions (
  group_id_a, group_id_b, verdict, voter_key
) VALUES ('SMOKE_G1', 'SMOKE_G2', 'same', 'smoke-voter-a');

INSERT INTO group_review_votes (
  group_id, verdict, voter_key
) VALUES ('SMOKE_G1', 'split', 'smoke-voter-a');

CREATE TABLE smoke_assertions (
  value INTEGER NOT NULL CHECK (value = 1)
);

INSERT INTO smoke_assertions
SELECT CASE WHEN (
  SELECT current_revision FROM community_state_projection WHERE id = 1
) = 2 THEN 1 ELSE 0 END;

INSERT INTO smoke_assertions
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM current_merge_decisions
  WHERE group_id_a = 'SMOKE_G1'
    AND group_id_b = 'SMOKE_G2'
    AND verdict = 'same'
) THEN 1 ELSE 0 END;

INSERT INTO smoke_assertions
SELECT CASE WHEN (
  SELECT COUNT(*)
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY
          group_id_a,
          group_id_b,
          COALESCE(NULLIF(voter_key, ''), 'legacy')
        ORDER BY created_at DESC, id DESC
      ) AS active_rank
    FROM merge_decisions
  )
  WHERE active_rank = 1
) = 1 THEN 1 ELSE 0 END;

INSERT INTO smoke_assertions
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM current_group_review_votes
  WHERE group_id = 'SMOKE_G1'
    AND voter_identity = 'smoke-voter-a'
    AND verdict = 'split'
) THEN 1 ELSE 0 END;

INSERT INTO group_review_resolutions (group_id, through_event_id, curator)
SELECT 'SMOKE_G1', MAX(source_event_id), 'smoke-curator'
FROM current_group_review_votes
WHERE group_id = 'SMOKE_G1';

DELETE FROM current_group_review_votes
WHERE group_id = 'SMOKE_G1'
  AND source_event_id <= (
    SELECT through_event_id
    FROM group_review_resolutions
    WHERE group_id = 'SMOKE_G1'
  );

INSERT INTO smoke_assertions
SELECT CASE WHEN NOT EXISTS (
  SELECT 1
  FROM current_group_review_votes AS votes
  LEFT JOIN group_review_resolutions AS resolutions
    ON resolutions.group_id = votes.group_id
  WHERE votes.group_id = 'SMOKE_G1'
    AND votes.source_event_id > COALESCE(resolutions.through_event_id, 0)
) THEN 1 ELSE 0 END;

INSERT INTO group_review_votes (
  group_id, verdict, voter_key
) VALUES ('SMOKE_G1', 'split', 'smoke-voter-b');

INSERT INTO smoke_assertions
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM current_group_review_votes AS votes
  LEFT JOIN group_review_resolutions AS resolutions
    ON resolutions.group_id = votes.group_id
  WHERE votes.group_id = 'SMOKE_G1'
    AND votes.source_event_id > COALESCE(resolutions.through_event_id, 0)
    AND votes.voter_identity = 'smoke-voter-b'
) THEN 1 ELSE 0 END;
