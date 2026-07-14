import { loadCommunityDataVersion } from "./_data_version.js";
import { logDatabaseError } from "./_db.js";

const ALLOWED_METRICS = new Set(["candidate_page", "submission"]);
const ALLOWED_FLOWS = new Set(["location", "group", "duplicate"]);

function normalizeMetric(value, allowed, fallback = "") {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

export function recordOperation(context, { metric, flow, status }) {
  const normalizedMetric = normalizeMetric(metric, ALLOWED_METRICS);
  const normalizedFlow = normalizeMetric(flow, ALLOWED_FLOWS);
  const statusCode = Number(status) || 0;
  if (
    !normalizedMetric ||
    !normalizedFlow ||
    !context?.env?.CORRECTIONS_DB ||
    typeof context.waitUntil !== "function"
  ) {
    return;
  }

  const promise = context.env.CORRECTIONS_DB.prepare(
    `
      INSERT INTO community_operation_metrics (
        bucket_hour, metric, flow, status_code, count, updated_at
      ) VALUES (
        strftime('%Y-%m-%dT%H:00:00Z', 'now'), ?, ?, ?, 1, datetime('now')
      )
      ON CONFLICT(bucket_hour, metric, flow, status_code) DO UPDATE SET
        count = count + 1,
        updated_at = datetime('now')
    `,
  )
    .bind(normalizedMetric, normalizedFlow, statusCode)
    .run()
    .catch((error) => {
      logDatabaseError("/api/operations", "record hourly metric", error);
    });
  context.waitUntil(promise);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function aggregateMetricRows(rows) {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const totals = {
    candidatePages24h: 0,
    candidateFailures24h: 0,
    staleCursors24h: 0,
    rejectedSubmissions24h: 0,
    serverErrors24h: 0,
    measuredSince: null,
  };
  (rows || []).forEach((row) => {
    const bucketTime = Date.parse(String(row.bucket_hour || ""));
    if (!Number.isFinite(bucketTime) || bucketTime < weekAgo) return;
    const count = number(row.count);
    const status = number(row.status_code);
    if (!totals.measuredSince || bucketTime < Date.parse(totals.measuredSince)) {
      totals.measuredSince = new Date(bucketTime).toISOString();
    }
    if (bucketTime < dayAgo) return;
    if (row.metric === "candidate_page") {
      totals.candidatePages24h += count;
      if (status >= 400) totals.candidateFailures24h += count;
      if (status === 409) totals.staleCursors24h += count;
    }
    if (row.metric === "submission" && status >= 400) {
      totals.rejectedSubmissions24h += count;
    }
    if (status >= 500) totals.serverErrors24h += count;
  });
  return totals;
}

export async function loadOperationalDiagnostics(request, env) {
  const expectedDataVersion = await loadCommunityDataVersion(request, env);
  const [projection, submissionResult, contributorResult, metricResult] =
    await Promise.all([
      env.CORRECTIONS_DB.prepare(
        `
          SELECT current_revision, computed_revision, data_version,
                 updated_at, payload_json IS NOT NULL AS has_payload
          FROM community_state_projection
          WHERE id = 1
        `,
      ).first(),
      env.CORRECTIONS_DB.prepare(
        `
          /* operations_submission_counts */
          SELECT
            'location' AS flow,
            SUM(CASE WHEN julianday(created_at) >= julianday('now', '-24 hours') THEN 1 ELSE 0 END) AS accepted_24h,
            SUM(CASE WHEN julianday(created_at) >= julianday('now', '-7 days') THEN 1 ELSE 0 END) AS accepted_7d,
            MAX(created_at) AS latest_at
          FROM corrections
          UNION ALL
          SELECT
            'duplicate' AS flow,
            SUM(CASE WHEN julianday(created_at) >= julianday('now', '-24 hours') THEN 1 ELSE 0 END) AS accepted_24h,
            SUM(CASE WHEN julianday(created_at) >= julianday('now', '-7 days') THEN 1 ELSE 0 END) AS accepted_7d,
            MAX(created_at) AS latest_at
          FROM merge_decisions
          UNION ALL
          SELECT
            'group' AS flow,
            SUM(CASE WHEN julianday(created_at) >= julianday('now', '-24 hours') THEN 1 ELSE 0 END) AS accepted_24h,
            SUM(CASE WHEN julianday(created_at) >= julianday('now', '-7 days') THEN 1 ELSE 0 END) AS accepted_7d,
            MAX(created_at) AS latest_at
          FROM group_review_votes
        `,
      ).all(),
      env.CORRECTIONS_DB.prepare(
        `
          /* operations_contributor_continuity */
          WITH events AS (
            SELECT NULLIF(voter_key, '') AS voter_key, created_at FROM corrections
            UNION ALL
            SELECT NULLIF(voter_key, '') AS voter_key, created_at FROM merge_decisions
            UNION ALL
            SELECT NULLIF(voter_key, '') AS voter_key, created_at FROM group_review_votes
          ), contributor_activity AS (
            SELECT
              voter_key,
              MIN(created_at) AS first_seen_at,
              SUM(CASE WHEN julianday(created_at) >= julianday('now', '-30 days') THEN 1 ELSE 0 END) AS recent_events
            FROM events
            WHERE voter_key IS NOT NULL
            GROUP BY voter_key
          )
          SELECT
            SUM(CASE WHEN recent_events > 0 THEN 1 ELSE 0 END) AS active_30d,
            SUM(CASE WHEN recent_events > 0 AND julianday(first_seen_at) >= julianday('now', '-30 days') THEN 1 ELSE 0 END) AS new_30d,
            SUM(CASE WHEN recent_events > 0 AND julianday(first_seen_at) < julianday('now', '-30 days') THEN 1 ELSE 0 END) AS returning_30d,
            SUM(CASE WHEN recent_events >= 2 THEN 1 ELSE 0 END) AS repeat_30d
          FROM contributor_activity
        `,
      ).first(),
      env.CORRECTIONS_DB.prepare(
        `
          SELECT bucket_hour, metric, flow, status_code, count
          FROM community_operation_metrics
          WHERE julianday(bucket_hour) >= julianday('now', '-7 days')
          ORDER BY bucket_hour ASC
        `,
      ).all(),
    ]);

  const currentRevision = number(projection?.current_revision);
  const computedRevision = number(projection?.computed_revision);
  const projectedDataVersion = String(projection?.data_version || "");
  const projectionCurrent = Boolean(
    projection?.has_payload &&
      currentRevision === computedRevision &&
      projectedDataVersion === expectedDataVersion,
  );
  const submissionsByFlow = (submissionResult?.results || []).map((row) => ({
    flow: String(row.flow || ""),
    accepted24h: number(row.accepted_24h),
    accepted7d: number(row.accepted_7d),
    latestAt: row.latest_at || null,
  }));
  const accepted24h = submissionsByFlow.reduce(
    (total, row) => total + row.accepted24h,
    0,
  );
  const accepted7d = submissionsByFlow.reduce(
    (total, row) => total + row.accepted7d,
    0,
  );
  const activity = aggregateMetricRows(metricResult?.results || []);
  const active30d = number(contributorResult?.active_30d);
  const returning30d = number(contributorResult?.returning_30d);

  return {
    projection: {
      current: projectionCurrent,
      hasPayload: Boolean(projection?.has_payload),
      currentRevision,
      computedRevision,
      pendingRevisions: Math.max(0, currentRevision - computedRevision),
      expectedDataVersion,
      projectedDataVersion,
      updatedAt: projection?.updated_at || null,
    },
    submissions: {
      accepted24h,
      accepted7d,
      rejected24h: activity.rejectedSubmissions24h,
      byFlow: submissionsByFlow,
    },
    candidateRequests: {
      pages24h: activity.candidatePages24h,
      failures24h: activity.candidateFailures24h,
      staleCursors24h: activity.staleCursors24h,
      measuredSince: activity.measuredSince,
    },
    contributors: {
      active30d,
      new30d: number(contributorResult?.new_30d),
      returning30d,
      repeat30d: number(contributorResult?.repeat_30d),
      returningShare: active30d > 0 ? returning30d / active30d : 0,
    },
    serverErrors24h: activity.serverErrors24h,
  };
}
