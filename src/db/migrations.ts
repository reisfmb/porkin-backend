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
];
