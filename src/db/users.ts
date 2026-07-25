import { db } from "./client.js";

export type User = {
  id: number;
  name: string;
  keyHash: string;
  active: number;
  createdAt: string;
};

type UserRow = {
  id: number;
  name: string;
  key_hash: string;
  active: number;
  created_at: string;
};

const findByKeyHashStmt = db.prepare(
  "SELECT id, name, key_hash, active, created_at FROM users WHERE key_hash = ?",
);

export function findUserByKeyHash(keyHash: string): User | undefined {
  const row = findByKeyHashStmt.get(keyHash) as UserRow | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    keyHash: row.key_hash,
    active: row.active,
    createdAt: row.created_at,
  };
}

const insertStmt = db.prepare(
  "INSERT INTO users (name, key_hash, active, created_at) VALUES (?, ?, 1, ?)",
);

export function insertUser(name: string, keyHash: string): number {
  const info = insertStmt.run(name, keyHash, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

// Public shape: key_hash is deliberately never selected, so it can't leak out
// through the admin API.
export type UserSummary = Omit<User, "keyHash">;

const listStmt = db.prepare("SELECT id, name, active, created_at FROM users ORDER BY id");

export function listUsers(): UserSummary[] {
  const rows = listStmt.all() as Omit<UserRow, "key_hash">[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    active: row.active,
    createdAt: row.created_at,
  }));
}

const setActiveStmt = db.prepare("UPDATE users SET active = ? WHERE id = ?");

// Returns false when no such user, so callers can 404.
export function setUserActive(id: number, active: boolean): boolean {
  return setActiveStmt.run(active ? 1 : 0, id).changes > 0;
}
