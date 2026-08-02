// Append-only, integer-versioned migrations applied in order at startup and
// tracked in schema_migrations. Mirrors porkin-app's Tauri migration pattern.
// NEVER mutate an applied migration — add a new one with the next version.
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,   -- SHA-256 hex of the license key
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL          -- ISO 8601
      );
      CREATE TABLE usage (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        file_name TEXT,
        file_size INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        ok INTEGER NOT NULL              -- 1 success, 0 failure
      );
      CREATE INDEX idx_usage_user ON usage(user_id, created_at);
    `,
  },
  {
    version: 2,
    // `usage` was extract-shaped (file_name/file_size). Generalize it so every
    // billable LLM call is logged, whichever endpoint made it. The DEFAULT
    // back-fills existing rows correctly — they were all extractions.
    sql: `
      ALTER TABLE usage ADD COLUMN endpoint TEXT NOT NULL DEFAULT 'extract';
      ALTER TABLE usage ADD COLUMN model TEXT;
    `,
  },
  {
    version: 3,
    // Cost-based monthly quota. `cost_usd` is priced at insert time (see
    // pricing.ts) so the quota check is one indexed SUM and a future price
    // change can't rewrite history.
    //
    // `monthly_limit_usd`'s DEFAULT exists only to back-fill the rows that
    // already exist — new users get their limit written explicitly from
    // config.defaultMonthlyLimitUsd, so moving that env var never silently
    // changes anyone's allowance.
    //
    // The back-fill prices historic rows at literal gpt-5.1 rates rather than
    // importing pricing.ts: an applied migration must never change meaning
    // because a constant elsewhere moved.
    sql: `
      ALTER TABLE users ADD COLUMN monthly_limit_usd REAL NOT NULL DEFAULT 1.0;
      ALTER TABLE usage ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
      ALTER TABLE usage ADD COLUMN cached_input_tokens INTEGER;
      UPDATE usage
         SET cost_usd = (COALESCE(input_tokens, 0) * 1.25 + COALESCE(output_tokens, 0) * 10.0) / 1000000.0;
    `,
  },
];
