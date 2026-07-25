import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { MIGRATIONS } from "./migrations.js";

// Load .env if present so DB_PATH resolves regardless of entry point, including
// any that imports the DB without going through config.ts.
try {
  process.loadEnvFile();
} catch {
  // no .env file — fine
}

// DB_PATH read here directly (not via config.ts) so the DB layer stays usable
// without PROVIDER_API_KEY (e.g. one-off maintenance scripts).
const dbPath = process.env.DB_PATH?.trim() || "./data/porkin.db";
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

migrate();

function migrate(): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => (r as { version: number }).version),
  );
  const runOne = db.transaction((m: { version: number; sql: string }) => {
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(m.version);
  });
  for (const m of MIGRATIONS) {
    if (!applied.has(m.version)) runOne(m);
  }
}
