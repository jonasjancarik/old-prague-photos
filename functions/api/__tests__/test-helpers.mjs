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
    fetch: async () =>
      new Response(
        JSON.stringify({
          type: "FeatureCollection",
          features,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
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
    this.db.exec(this.sql, this.args);
    return { success: true };
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
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  exec(sql, args) {
    const query = String(sql || "").toLowerCase();

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
    }
  }

  first(sql, args) {
    const query = String(sql || "").toLowerCase();

    if (query.includes("select count from api_rate_limits")) {
      const key = String(args[0] || "");
      const row = this.rateRows.get(key);
      return { count: row ? row.count : 0 };
    }
    return null;
  }

  all(sql) {
    const query = String(sql || "").toLowerCase();

    if (query.includes("from corrections")) {
      return { results: this.corrections.slice() };
    }
    if (query.includes("from merge_decisions")) {
      return { results: this.merges.slice() };
    }
    if (query.includes("from group_review_votes")) {
      return { results: this.groupReviewVotes.slice() };
    }
    return { results: [] };
  }
}
