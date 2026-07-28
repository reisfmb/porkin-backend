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
  outputTokens: number | null;
  ok: boolean;
};

const insertStmt = db.prepare(
  `INSERT INTO usage (user_id, created_at, endpoint, model, file_name, file_size, input_tokens, output_tokens, ok)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    row.outputTokens,
    row.ok ? 1 : 0,
  );
}

// Best-effort: never let a usage-logging failure break a request.
export function recordUsage(row: UsageRow): void {
  try {
    insertUsage(row);
  } catch (err) {
    console.error("Failed to record usage row:", err instanceof Error ? err.message : err);
  }
}
