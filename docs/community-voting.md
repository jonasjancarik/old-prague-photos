# Community Voting

Read this when:
- you need to remember what the different review UIs are actually voting on
- you need to debug why something is or is not marked done
- you are changing `/pomoc.html`, `/dup-review.html`, `/group-review.html`, or `review-state`

This app has 3 separate community review systems.

They look similar in the UI, but they answer different questions and write to different storage.

## 1. Location Review

UI:
- `/pomoc.html`
- main map correction modal on `/`

Question:
- “Is the map location correct?”

Possible outcomes:
- `ok`
  Means the location is correct.
- `wrong`
  Means the location is wrong and the voter supplies replacement coordinates.
- `flag`
  Means the voter thinks the current location is wrong or suspicious, but cannot place the correct point precisely.

Storage:
- Pages/D1: `corrections` table
- FastAPI local dev: `viewer/data/corrections.jsonl`

API:
- `POST /api/corrections`
- `GET /api/corrections`
- `GET /api/review-state`

Important fields:
- `xid`
- `group_id`
- `verdict`
- `lat`, `lon`
- `has_coordinates`
- `voter_key`

Meaning of `group_id` here:
- corrections apply to the whole metadata group, not only to one single photo version

Consensus rules:
- Latest anchor event matters.
- Anchor event means:
  - `wrong` with coordinates
  - `flag`
- If latest anchor is a coordinate correction:
  - it needs `1` independent later `ok` vote to become approved
- If latest anchor is a `flag`:
  - it needs `2` independent later `ok` votes to be considered resolved
- If there is no anchor event:
  - plain `ok` votes can still make the group “done” after `2` independent votes

Important consequence:
- location `ok` is not a generic “looks fine” signal
- it specifically affects location consensus

Core code:
- [functions/api/corrections.js](/Users/janca/projects/old-prague-photos/functions/api/corrections.js)
- [functions/api/_review_state.js](/Users/janca/projects/old-prague-photos/functions/api/_review_state.js)
- [viewer/static/pomoc.js](/Users/janca/projects/old-prague-photos/viewer/static/pomoc.js)

## 2. Duplicate / Merge Review

UI:
- `/dup-review.html`

Question:
- “Are these 2 groups actually the same shot/series?”

Possible outcomes:
- `same`
- `different`
- `undo`
  Reverts the last active decision for that pair

Storage:
- Pages/D1: `merge_decisions` table
- FastAPI local dev: `viewer/data/merges.jsonl`

API:
- `POST /api/merges`
- `GET /api/merges`
- `GET /api/review-state`

Important fields:
- `group_id_a`
- `group_id_b`
- `verdict`
- `voter_key`

Consensus model:
- this is not counted like correction `ok` votes
- instead, the latest active decision per pair wins
- `undo` clears the last active pair decision
- active `same` decisions feed the union-find merge resolver used by `review-state`

Important consequence:
- merge review changes which groups are considered the same root
- it does not say anything about map correctness

Core code:
- [functions/api/merges.js](/Users/janca/projects/old-prague-photos/functions/api/merges.js)
- [functions/api/_review_state.js](/Users/janca/projects/old-prague-photos/functions/api/_review_state.js)
- [viewer/static/dup-review.js](/Users/janca/projects/old-prague-photos/viewer/static/dup-review.js)

## 3. Group / Series Review

UI:
- `/group-review.html`

Question:
- “Does this metadata-based series look coherent?”
- In other words:
  - do these versions/scans belong together?
  - does this group seem internally fine?

Possible outcomes:
- `ok`
- `undo`

Storage:
- Pages/D1: `group_review_votes` table
- FastAPI local dev: `viewer/data/group_review_votes.jsonl`

API:
- `POST /api/group-review-votes`
- `GET /api/group-review-votes`

Important fields:
- `group_id`
- `verdict`
- `voter_key`

Consensus rules:
- a series is considered community-reviewed after `2` independent `ok` votes
- vote aggregation is per `group_id`
- only the latest vote per `(group_id, voter)` matters
- `undo` removes that voter’s active `ok` vote for the group

Important consequence:
- group-review votes are intentionally separate from location `ok`
- a voter saying “this series grouping looks right” does not imply “the map pin is correct”

Core code:
- [functions/api/group-review-votes.js](/Users/janca/projects/old-prague-photos/functions/api/group-review-votes.js)
- [viewer/static/group-review.js](/Users/janca/projects/old-prague-photos/viewer/static/group-review.js)

## Why These Are Separate

The 3 systems answer different questions:

- location review:
  “Is the pin correct?”
- merge review:
  “Should these 2 groups collapse into one?”
- group review:
  “Does this one group look internally coherent?”

Reusing one vote type for another would create bad state.

Example:
- if group-review “looks good” wrote a location `ok`
- then the app would treat “series seems coherent” as “location confirmed”
- that would incorrectly mark location review done

That is why group-review has its own table and endpoint.

## Shared vs Local State

Shared, server-backed state:
- corrections
- merge decisions
- group-review votes

Local browser-only state:
- `/group-review.html` also keeps a browser-local hide list
- this is just a convenience so the current browser session can move forward without immediately resurfacing already-clicked groups
- clearing that local list does not delete backend votes

Current UI wording:
- “Znovu ukázat moje série” only resets the browser-local hide list

## `review-state` Scope

`GET /api/review-state` currently covers:
- resolved merge roots
- location/correction consensus
- done groups for the location workflow
- latest merge decisions

It does not currently include:
- aggregated group-review vote state

That is intentional.

Reason:
- `review-state` is for location correction + merge resolution
- group-review has its own independent state model and API

## Independent Voters

All 3 systems use `voter_key` to distinguish independent votes.

`voter_key` is derived from request context and session/cookie material.

Practical meaning:
- 2 clicks from the same effective voter do not count as 2 independent community confirmations
- the system is designed to require distinct voters, not repeated clicks

Core code:
- [functions/api/_security.js](/Users/janca/projects/old-prague-photos/functions/api/_security.js)
- [viewer/app.py](/Users/janca/projects/old-prague-photos/viewer/app.py)

## Admin / Export

Maintainer export:
- `GET /api/admin/export`

It now includes:
- correction rows
- merge rows
- group-review vote rows
- derived group state from `review-state`

Admin review screen:
- `GET /api/admin/review`

It is still focused on:
- pending corrections
- unresolved flags
- merge conflicts

It does not currently expose a dedicated group-review moderation dashboard.

## Deploy / Migration Notes

New tables must exist in D1 before Pages code can use them.

Current migration for group-review votes:
- [migrations/0008_group_review_votes.sql](/Users/janca/projects/old-prague-photos/migrations/0008_group_review_votes.sql)

Apply:

```bash
npx wrangler d1 migrations apply CORRECTIONS_DB --local
npx wrangler d1 migrations apply CORRECTIONS_DB
```

If this migration is missing:
- Pages group-review vote writes will fail
- FastAPI local dev still works because it writes JSONL files directly

## Quick Mental Model

Use this when you have forgotten the system:

- `/pomoc.html`
  “Pin correct?”
- `/dup-review.html`
  “Same group or not?”
- `/group-review.html`
  “This group itself looks coherent?”

If you keep those 3 questions separate, the rest of the model stays understandable.
