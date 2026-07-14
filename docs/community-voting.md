# Community Help Workflows

Read this when:
- you need to understand what the community help pages are asking users to decide
- you need to debug why a group is or is not marked reviewed, merged, corrected, or done
- you are changing `/pomoc.html`, `/dup-review.html`, `/group-review.html`, `review-state`, or any community vote API

This is the maintainer-facing reference. For user-facing Czech instructions, see
[Komunitní pomoc](./komunitni-pomoc.md).

The app has three separate community workflows. They share visual patterns and
verification/session logic, but they answer different questions and write to
different storage.

## Quick Model

- `/pomoc.html`
  asks: "Is the map location correct?"
- `/dup-review.html`
  asks: "Are these two groups the same shot or series?"
- `/group-review.html`
  asks: "Does this one metadata-based group look internally coherent?"

Keep those questions separate. A group-review "looks good" vote is not a
location confirmation, and a location `ok` vote is not a duplicate/merge
decision.

## Workflow 1: Location Review

UI:
- `/pomoc.html`
- correction modal on `/`

Question:
- "Is the map location correct?"

Verdicts:
- `ok`
  The map location is correct.
- `wrong`
  The map location is wrong and the voter supplies replacement coordinates.
- `flag`
  The map location is wrong or suspicious, but the voter cannot place the
  correct point precisely.

Storage:
- Cloudflare Pages/D1: `corrections`
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

Scope:
- Corrections apply to `group_id`, not only to one photo version.
- Metadata suggests initial membership, but immutable series IDs survive metadata
  corrections. Versioned D1 membership overrides are the curator authority.
- Fresh run-directory derivations carry XID-to-series assignments from the
  published `photos.geojson`; an empty run output does not mint replacement IDs.
- A correction stays with the group recorded when it was submitted. Moving its
  representative XID later does not transfer the historical correction.

Consensus rules:
- The latest anchor event controls the current state.
- Anchor events are:
  - `wrong` with coordinates
  - `flag`
- If the latest anchor is a coordinate correction, it needs one independent
  later `ok` vote to become approved.
- If the latest anchor is a `flag`, it needs two independent later `ok` votes to
  be considered resolved.
- If there is no anchor event, plain `ok` votes can still mark the location
  workflow done after two independent votes.
- The correction author's own later `ok` vote does not confirm their correction.

Frontend behavior:
- `review-state` can include pending corrected coordinates. The UI may show a
  proposed correction immediately while marking it as pending confirmation.
- When a later state removes a merge or correction from a feature, the frontend
  restores that feature's original GeoJSON coordinates before applying the new
  state. This prevents stale corrected coordinates after merge undo/split flows.

Core code:
- [functions/api/corrections.js](../functions/api/corrections.js)
- [functions/api/_review_state.js](../functions/api/_review_state.js)
- [viewer/static/grouping.js](../viewer/static/grouping.js)
- [viewer/static/pomoc.js](../viewer/static/pomoc.js)
- [viewer/static/correction-ui.js](../viewer/static/correction-ui.js)

## Workflow 2: Duplicate / Merge Review

UI:
- `/dup-review.html`
- `/group-review.html` can open this page focused on one group

Question:
- "Are these two groups actually the same shot or series?"

Verdicts:
- `same`
  The two groups should collapse into one resolved group.
- `different`
  The two groups should stay separate.
- `undo`
  Clears the latest active decision for that pair.

Storage:
- Cloudflare Pages/D1: `merge_decisions`
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

Candidate sources:
- groups with matching coordinates
- visual similarity pairs from `viewer/static/data/similarity_candidates.json`

Consensus model:
- This is not a counted voting workflow.
- The latest event for a canonical pair wins.
- Active `same` decisions feed a union-find resolver in `review-state`.
- Active `different` decisions suppress that candidate pair but do not affect map
  correctness.
- `undo` clears the active pair decision so the pair can be considered again.
- An `undo` remains attached to the exact submitted historical pair even when a
  later merge has changed one member's current resolved root.

Runtime behavior:
- After a merge decision is saved, the duplicate-review UI fetches
  `/api/review-state?fresh=1` before rebuilding candidates.
- If that fresh-state fetch fails, the UI keeps the existing state and shows an
  error instead of applying an empty state. This avoids reintroducing already
  decided pairs.

Core code:
- [functions/api/merges.js](../functions/api/merges.js)
- [functions/api/_review_state.js](../functions/api/_review_state.js)
- [viewer/static/dup-review.js](../viewer/static/dup-review.js)

## Workflow 3: Group / Series Review

UI:
- `/group-review.html`

Question:
- "Does this metadata-based group look internally coherent?"
- In practical terms:
  - do these versions/scans belong together?
  - does this group seem like one coherent series rather than mixed subjects?

Verdicts:
- `ok`
- `split`
  The group mixes different photographs and should enter the curator split queue.
- `undo`

Current public UI:
- lets a user submit `ok` or `split`
- keeps a browser-local hide list so already-clicked groups do not immediately
  reappear
- does not expose a prominent backend undo button

Storage:
- Cloudflare Pages/D1: `group_review_votes`
- FastAPI local dev: `viewer/data/group_review_votes.jsonl`

API:
- `POST /api/group-review-votes`
- `GET /api/group-review-votes`

Important fields:
- `group_id`
- `verdict`
- `voter_key`

Consensus rules:
- A series is community-reviewed after two independent active `ok` votes.
- A series becomes a curator split candidate after two independent active
  `split` votes. Any active split vote prevents the group from being marked done.
- Completing a curator split records a vote-resolution boundary in the same D1
  transaction as the membership changes and audit event. Votes through that
  boundary are consumed; later votes start a new review round and projection
  rebuilds cannot reopen the resolved candidate.
- FastAPI local development persists the equivalent membership assignments and
  vote boundaries together as one append-only event in
  `viewer/data/group_membership_events.jsonl`; its admin review and split API
  expose the same curator flow as Pages.
- Curators see thumbnails, descriptive metadata, and the active split-vote
  timestamps before moving members. They can search for an existing series,
  and every move or reversal remains an append-only membership event rather
  than rewriting history.
- Split candidates and curator validation use merged-root membership, including
  members from every merged constituent group. Similarity candidates follow
  each referenced XID after a curator moves it to another series.
- Version clusters are split, filtered, and reattached by each XID's effective
  membership, so moved-away versions disappear from the source and appear on
  the target series immediately.
- Pages and FastAPI both resolve historical constituent `group_id` values to
  the current merged root before aggregation, and new votes are stored on that
  root.
- Only the latest vote per `(resolved group root, voter)` counts.
- `undo` removes that voter's active `ok` vote for the group.

Important consequence:
- Group-review votes are intentionally separate from location `ok`.
- A voter saying "this series looks coherent" does not imply "the map pin is
  correct."

Core code:
- [functions/api/group-review-votes.js](../functions/api/group-review-votes.js)
- [viewer/static/group-review.js](../viewer/static/group-review.js)

## Shared State vs Local Browser State

Shared, server-backed state:
- location corrections
- merge decisions
- group-review votes

The three contribution pages consume `/api/community-candidates` in bounded
pages. They no longer download `photos.geojson`, version clusters, or similarity
data directly. The server resolves current memberships and corrections first;
corrected candidates retain `properties.original_coordinates` so the browser
can restore the source position after a split or merge undo;
large exact-coordinate duplicate buckets use a bounded neighbor graph instead
of every possible pair. Pagination cursors carry the state revision, so a write
between pages causes a current-page restart instead of an offset skip.

Local browser-only state:
- `/group-review.html` keeps a hide list in local storage after the current user
  clicks "Série vypadá dobře".
- This only helps the current browser move forward through the queue.
- Clearing the list does not delete backend votes.

Current UI wording:
- "Znovu ukázat moje série" resets only the browser-local hide list.

## `review-state` Scope

`GET /api/review-state` covers:
- resolved merge roots
- location/correction consensus
- done groups for the location workflow
- latest active merge decisions
- aggregate counts used by the main map UI

It does not include:
- aggregated group-review vote state

That is intentional. `review-state` is for location correction plus merge
resolution. Group review has its own API and state model.

## Independent Voters

All three workflows use `voter_key` to distinguish independent voters.

`voter_key` is stored in a signed, HttpOnly, one-year anonymous cookie. It is
separate from the short Turnstile session and survives IP/session changes. An
active legacy session is preserved during rollout. The practical effect is:
- two clicks from the same effective voter do not count as two independent
  confirmations
- repeated clicks can update that voter's latest state, but they do not satisfy
  independent consensus by themselves

Core code:
- [functions/api/_security.js](../functions/api/_security.js)
- [viewer/app.py](../viewer/app.py)

## Verification and Write Protection

Write endpoints require:
- same-origin requests in production
- rate limiting through D1
- Turnstile verification or a valid signed session cookie

Relevant write endpoints:
- `POST /api/verify`
- `POST /api/corrections`
- `POST /api/merges`
- `POST /api/group-review-votes`

Local development can use `TURNSTILE_BYPASS=1` on localhost only.

## Admin / Export

Maintainer export:
- `GET /api/admin/export`

It includes:
- correction rows
- merge rows
- group-review vote rows
- derived location group state from `review-state`

Admin review screen:
- `GET /api/admin/review`
- `POST /api/admin/group-membership`

It focuses on:
- pending coordinate corrections
- unresolved flags
- merge conflicts
- recent merge decisions
- series with enough independent split votes
- atomic, audited XID moves into a new immutable series

Admin APIs require a bearer token; Cloudflare Access should also protect the
route at the edge. Public APIs never expose email, user agent, or voter
fingerprints.

## Deploy / Migration Notes

Migrations `0009`, `0010`, and `0011` add versioned membership overrides, audit
events, current merge/vote projections, the revisioned review-state snapshot,
and durable group-review resolution boundaries. Apply them before deploying
Functions. The guarded release command enforces this order:

```bash
npm run deploy:pages
```

The build also hashes the photo, orphan, similarity, and series-cluster inputs
into `/data/community-data-version.json`. Review projections and candidate
caches are accepted only for that deployed version. A missing or empty version
fails closed; `COMMUNITY_DATA_VERSION` is available only as an explicit
operator override.

## Test Coverage

Relevant tests:
- [functions/api/__tests__/review-state-consensus.test.mjs](../functions/api/__tests__/review-state-consensus.test.mjs)
- [functions/api/__tests__/routes.test.mjs](../functions/api/__tests__/routes.test.mjs)
- [functions/api/__tests__/security.test.mjs](../functions/api/__tests__/security.test.mjs)
- [functions/api/__tests__/static-grouping.test.mjs](../functions/api/__tests__/static-grouping.test.mjs)

Run:

```bash
npm run test:api
npm run test:d1
```
