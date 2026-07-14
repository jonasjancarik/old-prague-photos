export function makeRequest(
  path,
  {
    method = "POST",
    host = "example.com",
    protocol = "https:",
    headers = {},
    jsonBody,
  } = {},
) {
  const nextHeaders = new Headers(headers);
  let body;
  if (jsonBody !== undefined) {
    body = JSON.stringify(jsonBody);
    if (!nextHeaders.has("Content-Type")) {
      nextHeaders.set("Content-Type", "application/json");
    }
  }
  return new Request(`${protocol}//${host}${path}`, {
    method,
    headers: nextHeaders,
    body,
  });
}

export function makePhotosAsset(features = []) {
  return {
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const payload = path.endsWith("/community-data-version.json")
        ? { version: "test-data-v1" }
        : { type: "FeatureCollection", features };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async run() {
    return this.db.exec(this.sql, this.args) || { success: true };
  }

  async first() {
    return this.db.first(this.sql, this.args);
  }

  async all() {
    return this.db.all(this.sql, this.args);
  }
}

export class FakeD1 {
  constructor() {
    this.rateRows = new Map();
    this.corrections = [];
    this.merges = [];
    this.groupReviewVotes = [];
    this.groupMembershipOverrides = new Map();
    this.groupMembershipEvents = [];
    this.groupReviewResolutions = new Map();
    this.communityProjection = null;
    this.operationMetrics = [];
    this.projectionUpdateChanges = 1;
    this.allFailures = [];
  }

  failAllMatching(fragment, error = new Error("D1 query failed")) {
    this.allFailures.push({ fragment: String(fragment).toLowerCase(), error });
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  exec(sql, args) {
    const query = String(sql || "").toLowerCase();

    if (query.includes("update community_state_projection")) {
      return {
        success: true,
        meta: { changes: Number(this.projectionUpdateChanges) || 0 },
      };
    }

    if (query.includes("insert into api_rate_limits")) {
      const [key, bucket, windowEpoch] = args;
      const existing = this.rateRows.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        this.rateRows.set(key, {
          key,
          bucket: String(bucket || ""),
          window_epoch: Number(windowEpoch || 0),
          count: 1,
        });
      }
      return;
    }

    if (query.includes("insert into community_operation_metrics")) {
      const [metric, flow, statusCode] = args;
      const bucket = new Date();
      bucket.setUTCMinutes(0, 0, 0);
      const bucketHour = bucket.toISOString();
      const existing = this.operationMetrics.find(
        (row) =>
          row.bucket_hour === bucketHour &&
          row.metric === metric &&
          row.flow === flow &&
          Number(row.status_code) === Number(statusCode),
      );
      if (existing) existing.count += 1;
      else {
        this.operationMetrics.push({
          bucket_hour: bucketHour,
          metric,
          flow,
          status_code: Number(statusCode),
          count: 1,
        });
      }
      return;
    }

    if (query.includes("delete from api_rate_limits")) {
      const cutoff = Number(args[0] || 0);
      for (const [key, value] of this.rateRows.entries()) {
        if (value.window_epoch < cutoff) {
          this.rateRows.delete(key);
        }
      }
      return;
    }

    if (query.includes("insert into corrections")) {
      const [xid, groupId, lat, lon, hasCoordinates, voterKey, verdict] = args;
      this.corrections.push({
        id: this.corrections.length + 1,
        xid,
        group_id: groupId,
        lat,
        lon,
        has_coordinates: hasCoordinates,
        voter_key: voterKey,
        verdict,
        created_at: "2026-01-01 00:00:00",
      });
      return;
    }

    if (query.includes("insert into merge_decisions")) {
      const [groupA, groupB, verdict, voterKey, userAgent] = args;
      this.merges.push({
        id: this.merges.length + 1,
        group_id_a: groupA,
        group_id_b: groupB,
        verdict,
        voter_key: voterKey || "",
        user_agent: userAgent || "",
        created_at: "2026-01-01 00:00:00",
      });
      return;
    }

    if (query.includes("insert into group_review_votes")) {
      const [groupId, verdict, voterKey, userAgent] = args;
      this.groupReviewVotes.push({
        id: this.groupReviewVotes.length + 1,
        group_id: groupId,
        verdict,
        voter_key: voterKey || "",
        user_agent: userAgent || "",
        created_at: "2026-01-01 00:00:00",
      });
      return;
    }

    if (query.includes("insert into group_review_resolutions")) {
      const [groupId, curator] = args;
      const throughEventId = this.groupReviewVotes
        .filter((row) => row.group_id === groupId)
        .reduce((maximum, row) => Math.max(maximum, Number(row.id) || 0), 0);
      const existing = Number(this.groupReviewResolutions.get(groupId) || 0);
      this.groupReviewResolutions.set(groupId, Math.max(existing, throughEventId));
      return;
    }

    if (query.includes("delete from current_group_review_votes")) {
      return;
    }

    if (query.includes("insert into group_membership_overrides")) {
      const [xid, groupId, sourceGroupId, reason, curator] = args;
      const existing = this.groupMembershipOverrides.get(xid);
      this.groupMembershipOverrides.set(xid, {
        xid,
        group_id: groupId,
        source_group_id: sourceGroupId,
        revision: Number(existing?.revision || 0) + 1,
        reason,
        curator,
      });
      return;
    }

    if (query.includes("insert into group_membership_events")) {
      const [sourceGroupId, targetGroupId, assignmentsJson, reason, curator] = args;
      this.groupMembershipEvents.push({
        id: this.groupMembershipEvents.length + 1,
        source_group_id: sourceGroupId,
        target_group_id: targetGroupId,
        assignments_json: assignmentsJson,
        reason,
        curator,
        created_at: "2026-01-01 00:00:00",
      });
    }
  }

  async batch(statements) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ success: true }));
  }

  first(sql, args) {
    const query = String(sql || "").toLowerCase();

    if (query.includes("select count from api_rate_limits")) {
      const key = String(args[0] || "");
      const row = this.rateRows.get(key);
      return { count: row ? row.count : 0 };
    }
    if (query.includes("from community_state_projection")) {
      if (!this.communityProjection) return null;
      return {
        ...this.communityProjection,
        has_payload:
          this.communityProjection.has_payload ??
          Boolean(this.communityProjection.payload_json),
      };
    }
    if (query.includes("operations_contributor_continuity")) {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const activity = new Map();
      [...this.corrections, ...this.merges, ...this.groupReviewVotes].forEach(
        (row) => {
          const voterKey = String(row.voter_key || "");
          if (!voterKey) return;
          const timestamp = Date.parse(String(row.created_at || ""));
          const current = activity.get(voterKey) || {
            firstSeen: timestamp,
            recentEvents: 0,
          };
          current.firstSeen = Math.min(current.firstSeen, timestamp);
          if (timestamp >= cutoff) current.recentEvents += 1;
          activity.set(voterKey, current);
        },
      );
      const active = Array.from(activity.values()).filter(
        (row) => row.recentEvents > 0,
      );
      return {
        active_30d: active.length,
        new_30d: active.filter((row) => row.firstSeen >= cutoff).length,
        returning_30d: active.filter((row) => row.firstSeen < cutoff).length,
        repeat_30d: active.filter((row) => row.recentEvents >= 2).length,
      };
    }
    return null;
  }

  all(sql) {
    const query = String(sql || "").toLowerCase();
    const failure = this.allFailures.find(({ fragment }) =>
      query.includes(fragment),
    );
    if (failure) throw failure.error;

    if (query.includes("operations_submission_counts")) {
      const now = Date.now();
      const dayAgo = now - 24 * 60 * 60 * 1000;
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
      return {
        results: [
          ["location", this.corrections],
          ["duplicate", this.merges],
          ["group", this.groupReviewVotes],
        ].map(([flow, rows]) => ({
          flow,
          accepted_24h: rows.filter(
            (row) => Date.parse(String(row.created_at || "")) >= dayAgo,
          ).length,
          accepted_7d: rows.filter(
            (row) => Date.parse(String(row.created_at || "")) >= weekAgo,
          ).length,
          latest_at: rows.at(-1)?.created_at || null,
        })),
      };
    }
    if (query.includes("from community_operation_metrics")) {
      return { results: this.operationMetrics.slice() };
    }

    if (query.includes("from corrections")) {
      return { results: this.corrections.slice() };
    }
    if (query.includes("from group_membership_overrides")) {
      return { results: Array.from(this.groupMembershipOverrides.values()) };
    }
    if (query.includes("from group_membership_events")) {
      return {
        results: this.groupMembershipEvents
          .slice()
          .sort((left, right) => Number(right.id) - Number(left.id))
          .slice(0, 100),
      };
    }
    if (
      query.includes("from merge_decisions") ||
      query.includes("from current_merge_decisions")
    ) {
      return { results: this.merges.slice() };
    }
    if (
      query.includes("from group_review_votes") ||
      query.includes("from current_group_review_votes")
    ) {
      if (query.includes("from current_group_review_votes")) {
        return {
          results: this.groupReviewVotes.filter((row) =>
            Number(row.id) > Number(this.groupReviewResolutions.get(row.group_id) || 0)
          ),
        };
      }
      return { results: this.groupReviewVotes.slice() };
    }
    return { results: [] };
  }
}
