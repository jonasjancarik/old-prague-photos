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
    features,
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
    this.communityProjection = {
      current_revision: 0,
      computed_revision: -1,
      data_version: "test-data-v1",
      payload_json: null,
    };
    this.catalogMetadata = { data_version: "test-data-v1", row_count: 2 };
    this.catalogPhotos = new Map();
    this.operationMetrics = [];
    this.projectionUpdateChanges = 1;
    this.allFailures = [];
    this.beforeMergeInsert = null;
    this.beforeGroupVoteInsert = null;
    this.beforeCorrectionInsert = null;
    this.mergeAuditColumnsMissing = false;
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
      const projection = this.communityProjection;
      let changes = Number(this.projectionUpdateChanges) || 0;
      if (query.includes("set computed_revision = ?") && query.includes("and current_revision = ?")) {
        const [marker, expectedRevision, expectedComputed, catalogVersion] = args;
        changes = Number(Boolean(
          projection &&
          projection.current_revision === Number(expectedRevision) &&
          projection.computed_revision === Number(expectedComputed) &&
          this.catalogMetadata?.data_version === catalogVersion,
        ));
        if (changes) projection.computed_revision = Number(marker);
      } else if (query.includes("set computed_revision = ?") && query.includes("and computed_revision = ?")) {
        const [computedRevision, marker] = args;
        changes = Number(Boolean(projection && projection.computed_revision === Number(marker)));
        if (changes) projection.computed_revision = Number(computedRevision);
      } else if (query.includes("set payload_json")) {
        const [payloadJson, computedRevision, dataVersion, expectedRevision] = args;
        changes = Number(Boolean(
          changes && projection && projection.current_revision === Number(expectedRevision),
        ));
        if (changes) {
          projection.payload_json = payloadJson;
          projection.computed_revision = Number(computedRevision);
          projection.data_version = dataVersion;
        }
      }
      return { success: true, meta: { changes } };
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
      if (typeof this.beforeCorrectionInsert === "function") {
        const callback = this.beforeCorrectionInsert;
        this.beforeCorrectionInsert = null;
        callback(this);
      }
      if (query.includes("from community_state_projection")) {
        const currentRevision = Number(this.communityProjection?.current_revision || 0);
        const expectedRevision = Number(args[12]);
        const xidForGuard = String(args[13] || "");
        const groupForGuard = String(args[14] || "");
        const feature = this.catalogPhotos.get(xidForGuard);
        const currentGroup = this.groupMembershipOverrides.get(xidForGuard)?.group_id ||
          feature?.properties?.group_id || "";
        if (expectedRevision !== currentRevision || currentGroup !== groupForGuard) {
          return { success: true, meta: { changes: 0 } };
        }
      }
      const [
        xid,
        groupId,
        lat,
        lon,
        hasCoordinates,
        voterKey,
        verdict,
        locationRevision,
        proposalId,
      ] = args;
      this.corrections.push({
        id: this.corrections.length + 1,
        xid,
        group_id: groupId,
        lat,
        lon,
        has_coordinates: hasCoordinates,
        voter_key: voterKey,
        verdict,
        location_revision: locationRevision || null,
        proposal_id: proposalId || null,
        created_at: "2026-01-01 00:00:00",
      });
      if (this.communityProjection) {
        this.communityProjection.current_revision += 1;
      }
      return { success: true, meta: { changes: 1 } };
    }

    if (query.includes("insert into merge_decisions")) {
      const hasAuditColumns = query.includes("voter_key");
      if (hasAuditColumns && this.mergeAuditColumnsMissing) {
        throw new Error(
          "table merge_decisions has no column named voter_key",
        );
      }
      if (typeof this.beforeMergeInsert === "function") {
        const callback = this.beforeMergeInsert;
        this.beforeMergeInsert = null;
        callback(this);
      }
      const hasRevisionGuard = query.includes(
        "from community_state_projection",
      );
      const expectedRevision = hasRevisionGuard
        ? Number(args[hasAuditColumns ? 5 : 3])
        : null;
      const currentRevision = Number(
        this.communityProjection?.current_revision || 0,
      );
      if (hasRevisionGuard && expectedRevision !== currentRevision) {
        return { success: true, meta: { changes: 0 } };
      }
      const [groupA, groupB, verdict] = args;
      const voterKey = hasAuditColumns ? args[3] : "";
      const userAgent = hasAuditColumns ? args[4] : "";
      this.merges.push({
        id: this.merges.length + 1,
        group_id_a: groupA,
        group_id_b: groupB,
        verdict,
        voter_key: voterKey || "",
        user_agent: userAgent || "",
        created_at: "2026-01-01 00:00:00",
      });
      if (hasRevisionGuard && this.communityProjection) {
        this.communityProjection.current_revision = currentRevision + 1;
      }
      return { success: true, meta: { changes: 1 } };
    }

    if (query.includes("insert into group_review_votes")) {
      if (typeof this.beforeGroupVoteInsert === "function") {
        const callback = this.beforeGroupVoteInsert;
        this.beforeGroupVoteInsert = null;
        callback(this);
      }
      if (
        query.includes("from community_state_projection") &&
        Number(args[4]) !== Number(this.communityProjection?.current_revision || 0)
      ) {
        return { success: true, meta: { changes: 0 } };
      }
      const [groupId, verdict, voterKey, userAgent] = args;
      this.groupReviewVotes.push({
        id: this.groupReviewVotes.length + 1,
        group_id: groupId,
        verdict,
        voter_key: voterKey || "",
        user_agent: userAgent || "",
        created_at: "2026-01-01 00:00:00",
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (query.includes("insert into group_review_resolutions")) {
      const [groupId, curator] = args;
      if (query.includes("from community_state_projection")) {
        const [, , , expectedRevision, marker, catalogVersion] = args;
        if (
          this.communityProjection?.current_revision !== Number(expectedRevision) ||
          this.communityProjection?.computed_revision !== Number(marker) ||
          this.catalogMetadata?.data_version !== catalogVersion
        ) return { success: true, meta: { changes: 0 } };
      }
      const throughEventId = this.groupReviewVotes
        .filter((row) => row.group_id === groupId)
        .reduce((maximum, row) => Math.max(maximum, Number(row.id) || 0), 0);
      const existing = Number(this.groupReviewResolutions.get(groupId) || 0);
      this.groupReviewResolutions.set(groupId, Math.max(existing, throughEventId));
      return { success: true, meta: { changes: 1 } };
    }

    if (query.includes("delete from current_group_review_votes")) {
      return { success: true, meta: { changes: 0 } };
    }

    if (query.includes("with requested(xid)") && query.includes("insert into group_membership_overrides")) {
      const [xidsJson, groupId, sourceGroupId, reason, curator,
        expectedRevision, marker, catalogVersion, aliasesJson] = args;
      const xids = JSON.parse(xidsJson);
      const sourceAliases = new Set(JSON.parse(aliasesJson));
      const projection = this.communityProjection;
      const allowed = Boolean(
        projection?.current_revision === Number(expectedRevision) &&
        projection?.computed_revision === Number(marker) &&
        this.catalogMetadata?.data_version === catalogVersion &&
        xids.every((xid) => {
          const feature = this.catalogPhotos.get(xid);
          const currentGroup = this.groupMembershipOverrides.get(xid)?.group_id ||
            feature?.properties?.group_id || "";
          return Boolean(feature) && sourceAliases.has(currentGroup);
        }),
      );
      if (!allowed) return { success: true, meta: { changes: 0 } };
      xids.forEach((xid) => {
        const existing = this.groupMembershipOverrides.get(xid);
        this.groupMembershipOverrides.set(xid, {
          xid,
          group_id: groupId,
          source_group_id: sourceGroupId,
          revision: Number(existing?.revision || 0) + 1,
          reason,
          curator,
        });
      });
      projection.current_revision += xids.length;
      return { success: true, meta: { changes: xids.length } };
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
      if (query.includes("from community_state_projection")) {
        const [, , , , , expectedRevision, marker, catalogVersion] = args;
        if (
          this.communityProjection?.current_revision !== Number(expectedRevision) ||
          this.communityProjection?.computed_revision !== Number(marker) ||
          this.catalogMetadata?.data_version !== catalogVersion
        ) return { success: true, meta: { changes: 0 } };
      }
      this.groupMembershipEvents.push({
        id: this.groupMembershipEvents.length + 1,
        source_group_id: sourceGroupId,
        target_group_id: targetGroupId,
        assignments_json: assignmentsJson,
        reason,
        curator,
        created_at: "2026-01-01 00:00:00",
      });
      return { success: true, meta: { changes: 1 } };
    }
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }

  first(sql, args) {
    const query = String(sql || "").toLowerCase();

    if (query.includes("count(*) as member_count") && query.includes("from catalog_photos as photos")) {
      const aliases = new Set(JSON.parse(String(args[0] || "[]")));
      let memberCount = 0;
      this.catalogPhotos.forEach((feature, xid) => {
        const currentGroup = this.groupMembershipOverrides.get(xid)?.group_id ||
          feature.properties?.group_id || xid;
        if (aliases.has(currentGroup)) memberCount += 1;
      });
      return { member_count: memberCount };
    }

    if (query.includes("from catalog_metadata")) {
      return this.catalogMetadata;
    }
    if (query.includes("from catalog_photos as p") && query.includes("where p.xid = ?")) {
      const xid = String(args[0] || "");
      const feature = this.catalogPhotos.get(xid);
      if (!feature) return null;
      const baseGroupId = String(feature.properties?.group_id || xid);
      return {
        xid,
        base_group_id: baseGroupId,
        current_group_id: this.groupMembershipOverrides.get(xid)?.group_id || baseGroupId,
        source_lon: feature.geometry?.coordinates?.[0] ?? 14.4,
        source_lat: feature.geometry?.coordinates?.[1] ?? 50.1,
        feature_json: JSON.stringify(feature.properties || {}),
      };
    }
    if (query.includes("from catalog_photos as p") && query.includes("p.base_group_id = ?")) {
      const groupId = String(args[0] || "");
      const known = Array.from(this.catalogPhotos.entries()).some(
        ([xid, feature]) =>
          String(feature.properties?.group_id || "") === groupId &&
          !this.groupMembershipOverrides.has(xid),
      );
      const moved = Array.from(this.groupMembershipOverrides.values()).some(
        (row) => String(row.group_id || "") === groupId,
      );
      return known || moved ? { found: 1 } : null;
    }

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

  all(sql, args = []) {
    const query = String(sql || "").toLowerCase();
    const failure = this.allFailures.find(({ fragment }) =>
      query.includes(fragment),
    );
    if (failure) throw failure.error;

    if (query.includes("select photos.xid") && query.includes("json_each(?)")) {
      const requested = new Set(JSON.parse(String(args[0] || "[]")));
      const aliases = new Set(JSON.parse(String(args[1] || "[]")));
      return {
        results: Array.from(this.catalogPhotos.entries())
          .filter(([xid, feature]) => requested.has(xid) && aliases.has(
            this.groupMembershipOverrides.get(xid)?.group_id ||
              feature.properties?.group_id || xid,
          ))
          .map(([xid]) => ({ xid })),
      };
    }

    if (query.includes("from catalog_photos where xid in")) {
      const ids = new Set(args.map(String));
      return {
        results: Array.from(this.catalogPhotos.entries())
          .filter(([xid]) => ids.has(xid))
          .map(([xid, feature]) => ({
            xid,
            base_group_id: String(feature.properties?.group_id || xid),
          })),
      };
    }
    if (query.includes("from catalog_photos as photos") && query.includes("group by")) {
      const term = String(args[0] || "").replaceAll("%", "").replaceAll("\\", "").toLowerCase();
      const groups = new Map();
      this.catalogPhotos.forEach((feature, xid) => {
        const groupId = this.groupMembershipOverrides.get(xid)?.group_id ||
          String(feature.properties?.group_id || xid);
        const props = feature.properties || {};
        const item = groups.get(groupId) || {
          group_id: groupId,
          member_count: 0,
          sample_xid: "",
          feature_json: "{}",
        };
        item.member_count += 1;
        const haystack = [groupId, xid, props.description, props.signature, props.author, props.date_label]
          .join(" ").toLowerCase();
        if (haystack.includes(term) && !item.sample_xid) {
          item.sample_xid = xid;
          item.feature_json = JSON.stringify(props);
        }
        groups.set(groupId, item);
      });
      return {
        results: Array.from(groups.values())
          .filter((item) => item.sample_xid)
          .sort((a, b) =>
            Number(b.group_id.toLowerCase().startsWith(term)) -
              Number(a.group_id.toLowerCase().startsWith(term)) ||
            a.group_id.localeCompare(b.group_id),
          )
          .slice(0, 20),
      };
    }
    if (query.includes("from catalog_photos as photos")) {
      const ids = new Set(args.map(String));
      return {
        results: Array.from(this.catalogPhotos.entries())
          .filter(([xid, feature]) => ids.has(
            this.groupMembershipOverrides.get(xid)?.group_id ||
              String(feature.properties?.group_id || xid),
          ))
          .map(([xid, feature]) => ({
            xid,
            base_group_id: String(feature.properties?.group_id || xid),
            current_group_id: this.groupMembershipOverrides.get(xid)?.group_id ||
              String(feature.properties?.group_id || xid),
            source_lon: feature.geometry?.coordinates?.[0] ?? 14.4,
            source_lat: feature.geometry?.coordinates?.[1] ?? 50.1,
            feature_json: JSON.stringify(feature.properties || {}),
          })),
      };
    }

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
