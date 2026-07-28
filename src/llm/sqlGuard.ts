// The model's SQL is untrusted output. This guard is the backend half of a
// deliberate duplication: porkin-app re-checks with the same rules before it
// executes anything (it is the side holding a writable DB handle). Neither half
// is allowed to rely on the other.

const MAX_SQL_LENGTH = 4000;

// Whole-word match so a column named e.g. `created_at` or a merchant string
// containing "update" inside quotes isn't what trips this — see stripLiterals.
const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|begin|commit|rollback|savepoint)\b/i;

/** Blanks out single/double-quoted literals so a merchant name can't trip the keyword scan. */
function stripLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

export class SqlRejected extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SqlRejected";
  }
}

/**
 * Validates that `sql` is a single read-only statement.
 * @returns the normalized SQL (trimmed, no trailing semicolon)
 * @throws SqlRejected with a reason the model can be shown so it can retry
 */
export function assertReadOnlySql(sql: string): string {
  const normalized = sql.trim().replace(/;\s*$/, "").trim();

  if (!normalized) throw new SqlRejected("Query is empty");
  if (normalized.length > MAX_SQL_LENGTH) {
    throw new SqlRejected(`Query exceeds ${MAX_SQL_LENGTH} characters`);
  }
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new SqlRejected("Query must start with SELECT or WITH");
  }

  const bare = stripLiterals(normalized);
  if (bare.includes(";")) throw new SqlRejected("Only a single statement is allowed");
  if (bare.includes("--") || bare.includes("/*")) {
    throw new SqlRejected("SQL comments are not allowed");
  }
  const forbidden = FORBIDDEN.exec(bare);
  if (forbidden) throw new SqlRejected(`Query must be read-only (found "${forbidden[0]}")`);

  return normalized;
}
