import { db } from "./client.js";

/** Which paid endpoint spent the call. One row per LLM call, not per user request. */
export type UsageEndpoint = "extract" | "ask";

export type UsageRow = {
  userId: number;
  endpoint: UsageEndpoint;
  model: string | null;
  // Extract-only; null for endpoints that take no file.
  fileName: string | null;
  fileSize: number | null;
  inputTokens: number | null;
  /** Subset of inputTokens served from the provider's prompt cache — billed cheaper. */
  cachedInputTokens: number | null;
  outputTokens: number | null;
  /** USD, priced at insert time by pricing.ts. This column is what the quota sums. */
  costUsd: number;
  ok: boolean;
};

const insertStmt = db.prepare(
  `INSERT INTO usage (user_id, created_at, endpoint, model, file_name, file_size,
                      input_tokens, cached_input_tokens, output_tokens, cost_usd, ok)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

export function insertUsage(row: UsageRow): void {
  insertStmt.run(
    row.userId,
    new Date().toISOString(),
    row.endpoint,
    row.model,
    row.fileName,
    row.fileSize,
    row.inputTokens,
    row.cachedInputTokens,
    row.outputTokens,
    row.costUsd,
    row.ok ? 1 : 0,
  );
}

// Best-effort: never let a usage-logging failure break a request. The trade is
// that a dropped insert undercounts the month — accepted, see CLAUDE.md "Quota".
export function recordUsage(row: UsageRow): void {
  try {
    insertUsage(row);
  } catch (err) {
    console.error("Failed to record usage row:", err instanceof Error ? err.message : err);
  }
}

// ---- Quota + reporting reads ----
// created_at is written as new Date().toISOString(), so ISO string comparison is
// chronological; every query below rides idx_usage_user(user_id, created_at).

const sumCostStmt = db.prepare(
  `SELECT COALESCE(SUM(cost_usd), 0) AS usd
     FROM usage
    WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
);

/** What this user has spent inside [fromIso, toIso). The quota check. */
export function sumCostBetween(userId: number, fromIso: string, toIso: string): number {
  return (sumCostStmt.get(userId, fromIso, toIso) as { usd: number }).usd;
}

const totalsStmt = db.prepare(
  `SELECT COALESCE(SUM(cost_usd), 0)      AS usd,
          COALESCE(SUM(input_tokens), 0)  AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens
     FROM usage
    WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
);

const byEndpointStmt = db.prepare(
  `SELECT endpoint,
          COUNT(*)                   AS calls,
          COALESCE(SUM(cost_usd), 0) AS usd
     FROM usage
    WHERE user_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY endpoint
    ORDER BY endpoint`,
);

const dailyStmt = db.prepare(
  `SELECT substr(created_at, 1, 10)  AS date,
          COALESCE(SUM(cost_usd), 0) AS usd
     FROM usage
    WHERE user_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY date
    ORDER BY date`,
);

export type UsageBreakdown = {
  spentUsd: number;
  inputTokens: number;
  outputTokens: number;
  byEndpoint: { endpoint: string; calls: number; usd: number }[];
  daily: { date: string; usd: number }[];
};

/** Everything GET /v1/usage reports, for one user over one period. */
export function breakdownBetween(userId: number, fromIso: string, toIso: string): UsageBreakdown {
  const totals = totalsStmt.get(userId, fromIso, toIso) as {
    usd: number;
    input_tokens: number;
    output_tokens: number;
  };
  return {
    spentUsd: totals.usd,
    inputTokens: totals.input_tokens,
    outputTokens: totals.output_tokens,
    byEndpoint: byEndpointStmt.all(userId, fromIso, toIso) as UsageBreakdown["byEndpoint"],
    daily: dailyStmt.all(userId, fromIso, toIso) as UsageBreakdown["daily"],
  };
}

const spendByUserStmt = db.prepare(
  `SELECT user_id, COALESCE(SUM(cost_usd), 0) AS usd
     FROM usage
    WHERE created_at >= ? AND created_at < ?
    GROUP BY user_id`,
);

/** Spend per user over a period, keyed by id — so `admin.js list` can show it. */
export function spendByUserBetween(fromIso: string, toIso: string): Map<number, number> {
  const rows = spendByUserStmt.all(fromIso, toIso) as { user_id: number; usd: number }[];
  return new Map(rows.map((r) => [r.user_id, r.usd]));
}
