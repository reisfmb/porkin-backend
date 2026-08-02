import { db } from "./client.js";

export type User = {
  id: number;
  name: string;
  keyHash: string;
  active: number;
  /** Per-user monthly spend cap in USD — the quota middleware reads it off the authed user. */
  monthlyLimitUsd: number;
  createdAt: string;
};

type UserRow = {
  id: number;
  name: string;
  key_hash: string;
  active: number;
  monthly_limit_usd: number;
  created_at: string;
};

const findByKeyHashStmt = db.prepare(
  "SELECT id, name, key_hash, active, monthly_limit_usd, created_at FROM users WHERE key_hash = ?",
);

export function findUserByKeyHash(keyHash: string): User | undefined {
  const row = findByKeyHashStmt.get(keyHash) as UserRow | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    keyHash: row.key_hash,
    active: row.active,
    monthlyLimitUsd: row.monthly_limit_usd,
    createdAt: row.created_at,
  };
}

const insertStmt = db.prepare(
  "INSERT INTO users (name, key_hash, active, monthly_limit_usd, created_at) VALUES (?, ?, 1, ?, ?)",
);

// The limit is always written explicitly (never left to the column DEFAULT), so
// changing DEFAULT_MONTHLY_LIMIT_USD can't retroactively move an existing user.
export function insertUser(name: string, keyHash: string, monthlyLimitUsd: number): number {
  const info = insertStmt.run(name, keyHash, monthlyLimitUsd, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

// Public shape: key_hash is deliberately never selected, so it can't leak out
// through the admin API.
export type UserSummary = Omit<User, "keyHash">;

const listStmt = db.prepare(
  "SELECT id, name, active, monthly_limit_usd, created_at FROM users ORDER BY id",
);

export function listUsers(): UserSummary[] {
  const rows = listStmt.all() as Omit<UserRow, "key_hash">[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    active: row.active,
    monthlyLimitUsd: row.monthly_limit_usd,
    createdAt: row.created_at,
  }));
}

const setActiveStmt = db.prepare("UPDATE users SET active = ? WHERE id = ?");

// Returns false when no such user, so callers can 404.
export function setUserActive(id: number, active: boolean): boolean {
  return setActiveStmt.run(active ? 1 : 0, id).changes > 0;
}

const setLimitStmt = db.prepare("UPDATE users SET monthly_limit_usd = ? WHERE id = ?");

// Returns false when no such user, so callers can 404.
export function setUserLimit(id: number, monthlyLimitUsd: number): boolean {
  return setLimitStmt.run(monthlyLimitUsd, id).changes > 0;
}
