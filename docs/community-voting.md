# Community Help Workflows

Read this when:
- you need to understand what the community help pages are asking users to decide
- you need to debug why a group is or is not marked reviewed, merged, corrected, or done
- you are changing `/pomoc.html`, `/dup-review.html`, `/group-review.html`, `review-state`, or any community vote API
- you are changing private photo feedback or correction receipt behavior

This is the maintainer-facing reference. For user-facing Czech instructions, see
[Komunitní pomoc](./komunitni-pomoc.md).

The app has three separate community workflows. They share visual patterns and
verification/session logic, but they answer different questions and write to
different storage.

## Quick Model

- `/pomoc.html`
  asks: "Is the map location correct?"
- `/dup-review.html`
  asks: "Do these two groups belong together?" (the same photograph, or
  different takes from the same shoot)
- `/group-review.html`
  asks: "Does this one metadata-based group look internally coherent?"

Keep those questions separate. A group-review "looks good" vote is not a
location confirmation, and a location `ok` vote is not a duplicate/merge
decision.

## Workflow 1: Location Review

The detail's **Poslat připomínku** is a separate private workflow. Its
`photo_feedback` rows attach to an XID and never enter `corrections`, votes,
location projections, or consensus. Admins work through the paginated
`/api/admin/feedback` inbox, independently of the location review queues.

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
- `location_revision` and `proposal_id` on new `ok` events

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
- A successful `wrong` response includes `correction_id`. The UI remembers
  only the photo XID and this ID for the browser session. When the current
  `proposed_id` matches, the author sees a waiting message and cannot confirm
  the same proposal in the review UI. Other browsers and later proposals are
  treated normally; the server rule above remains authoritative.
- Every new `ok` submission names the exact `location_revision` shown to the
  voter and, for a coordinate proposal, its immutable `proposal_id`. The API
  rejects a stale or mismatched target with `409`.
- The target is stored with the append-only event. Projection counts that vote
  only for the named group/anchor, so a proposal created between validation and
  insertion cannot inherit the earlier vote. Historical untargeted `ok` rows
  keep their legacy behavior.

Frontend behavior:
- `review-state` exposes only approved coordinates through `has_coordinates`,
  `lat`, and `lon`. A pending correction never replaces the public/applied
  location.
- The latest coordinate proposal remains inspectable through
  `proposed_has_coordinates`, `proposed_id`, `proposed_lat`, and `proposed_lon`.
  `anchor_id` and `location_revision` identify the exact state being reviewed.
  The contribution UI renders the proposal as a separate labeled point and
  never treats it as the public map pin.
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
  This voter believes the two groups should collapse into one resolved group.
  It does not merge the groups until another independent active voter agrees.
- `different`
  The two groups should stay separate.
- `undo`
  Clears this voter's latest active decision for that pair.

Storage:
- Cloudflare Pages/D1: `merge_decisions`
- FastAPI local dev: `viewer/data/merges.jsonl`

API:
- `POST /api/merges`
- `GET /api/merges`
- `GET /api/review-state`

`GET /api/merges` returns the same anonymous aggregate pair projection as
`review-state`, including consensus counts.

Important fields:
- `group_id_a`
- `group_id_b`
- `verdict`
- `candidate_revision` for `same` and `different`
- `voter_key`

The browser submits the integer candidate revision returned with the displayed
page. The API rejects stale `same` and `different` evidence with `409` before
resolving either submitted ID to a newer root. Exact-pair `undo` intentionally
does not require a candidate revision.

Candidate sources:
- groups with matching coordinates
- visual similarity pairs from `viewer/static/data/similarity_candidates.json`

Consensus model:
- The latest event per `(canonical pair, voter identity)` is active. Earlier
  events remain append-only history but no longer count for that voter.
- A pair feeds the union-find resolver only after at least two independent
  active voters agree `same`.
- One active `same` vote is projected as `pending`; the groups stay separate and
  the pair remains available so another voter can review it.
- Repeated `same` events from one voter still count as one vote.
- A later `different` or `undo` from a voter replaces or removes only that
  voter's active `same` decision. If this drops the pair below two active `same`
  voters, the union is removed on the next projection rebuild.
- A pair with active `different` votes and no active `same` vote remains
  `different`, suppressing that candidate pair without changing map
  correctness. A mixed pair below the `same` threshold remains `pending`.
- Legacy events without `voter_key` share one conservative legacy identity per
  pair. They cannot establish independent consensus by repetition, and a later
  legacy `undo` still clears the legacy state.
- An `undo` remains attached to the exact submitted historical pair even when a
  later merge has changed one member's current resolved root.
- After consensus has temporarily resolved both members to one root,
  `different` is still accepted for that exact historical pair. It replaces
  only the submitting voter's active decision and can therefore remove the
  union without losing append-only history.

Public pair projections expose `same_votes`, `different_votes`, and
`required_same_votes` without exposing voter keys or user agents.

Runtime behavior:
- After a merge decision is saved, the duplicate-review UI reloads the bounded
  candidate page against the new revision before showing another pair.
- If that reload fails, the saved exact pair remains available through the
  `Zpět` action even though new decisions stay disabled.

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

## Browser-level regression coverage

Run `npm run test:e2e` to exercise all three workflows through Chromium against
an isolated local Pages + D1 runtime. The suite also verifies duplicate undo,
curator reassignment after two independent split votes, stale-cursor rejection,
control recovery after a delayed failed request, and keyboard focus/Escape
behavior in the correction dialog.

## Shared State vs Local Browser State

Shared, server-backed state:
- location corrections
- merge decisions
- group-review votes

The three contribution pages load the published photo, version-cluster, and
similarity files in the browser. They combine them with the compact,
revisioned `/api/review-state` snapshot before showing candidates. Original
coordinates remain available after a correction, split, or merge undo. Large
exact-coordinate duplicate buckets use a limited neighbor graph, and the
browser keeps only group IDs in the duplicate queue until it shows a pair.
Pagination cursors carry the static data version and community revision, so a
write between pages restarts the list. Every submitted XID, group, and revision
is checked again against indexed D1 data on the server.

Local browser-only state:
- `/group-review.html` keeps a hide list in local storage after the current user
  votes ("Skupina je správně" or "Skupina míchá různé fotografie").
- This only helps the current browser move forward through the queue.
- Clearing the list does not delete backend votes.

Current UI wording:
- "Zobrazit znovu prošlé" (at the bottom of the page) resets only the
  browser-local hide list.

Shared UI conventions across the three pages:
- The question and the photo caption come first, then the evidence.
- Decisions sit in a sticky answer bar; on desktop `A` / `N` / `→` / `←` map to
  yes / no / next / previous.
- The header shows "Vaše kontroly", a per-visit count of saved decisions, not
  the size of the backlog. Internal group IDs appear only in a small reference
  line (`#current-xid`, `#current-group`), which the browser tests also use as a
  readiness signal.
- The group page shows a contact sheet of every member; the details panel
  omits the location-scope line and version pills there.

## `review-state` Scope

`GET /api/review-state` covers:
- resolved merge roots
- location/correction consensus
- done groups for the location workflow
- aggregate active merge-pair state and consensus counts
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
- `POST /api/admin/session`
- `POST /api/admin/group-membership`

It focuses on:
- pending coordinate corrections
- unresolved flags
- merge conflicts
- recent merge decisions
- series with enough independent split votes
- atomic, audited XID moves into a new immutable series
- public-state freshness, queue age, submission/request failures, and aggregate
  contributor continuity

The curator page exchanges `ADMIN_API_TOKEN` for a signed, short-lived HttpOnly
cookie and clears the token field. Bearer authentication remains available for
release tooling. Cloudflare Access should also protect the route at the edge.
Public APIs and operational aggregates never expose email, user agent, or voter
fingerprints.

## Deploy / Migration Notes

Migrations `0009` through `0015` add versioned membership overrides, audit
events, current merge/vote projections, the revisioned review-state snapshot,
durable group-review resolution boundaries, and bounded hourly operational
counters. Migration `0013` persists the proposal target carried by new
location confirmations. Migration `0014` adds an indexed photo catalog, and
`0015` records its source digest; the
guarded release imports the catalog in checked chunks before deploying
Functions. Apply them before deploying Functions. The guarded
release command enforces this order:

```bash
npm run deploy:pages
```

The build also hashes the photo, orphan, similarity, and series-cluster inputs
into `/data/community-data-version.json`. Review projections and candidate
caches are accepted only for that deployed version. A missing or empty version
fails closed; `COMMUNITY_DATA_VERSION` is available only as an explicit
operator override.

The materialized payload also carries `reviewStateSchemaVersion`. A deployment
that changes projection semantics rejects an older payload even when its D1
revision and static-data version still match, then rebuilds it from the
append-only event tables. Edge-cache keys include both the static-data version
and this schema version, so the old one-vote merge projection cannot survive a
code-only deployment.

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
