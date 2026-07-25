import { db } from "./client.js";

export type UsageRow = {
  userId: number;
  fileName: string | null;
  fileSize: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  ok: boolean;
};

const insertStmt = db.prepare(
  `INSERT INTO usage (user_id, created_at, file_name, file_size, input_tokens, output_tokens, ok)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

export function insertUsage(row: UsageRow): void {
  insertStmt.run(
    row.userId,
    new Date().toISOString(),
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
