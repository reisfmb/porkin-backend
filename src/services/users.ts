import { generateLicenseKey, sha256Hex } from "../crypto.js";
import {
  insertUser,
  listUsers as listUserRows,
  setUserActive as setUserActiveRow,
  type UserSummary,
} from "../db/users.js";
import { ApiError } from "../errors.js";

// Business logic for user/license-key administration. Framework-agnostic (no Hono).

const MAX_NAME_LEN = 100;

export type CreatedUser = { id: number; name: string; key: string };

// The plaintext key is returned ONCE (never stored — only its SHA-256 hash).
export function createUser(rawName: unknown): CreatedUser {
  if (typeof rawName !== "string") {
    throw new ApiError(400, "bad_request", "`name` must be a string");
  }
  const name = rawName.trim();
  if (!name) {
    throw new ApiError(400, "bad_request", "`name` must not be empty");
  }
  if (name.length > MAX_NAME_LEN) {
    throw new ApiError(400, "bad_request", `\`name\` must be at most ${MAX_NAME_LEN} chars`);
  }

  const key = generateLicenseKey();
  const id = insertUser(name, sha256Hex(key));
  return { id, name, key };
}

export function listUsers(): UserSummary[] {
  return listUserRows();
}

export function setUserActive(id: number, active: boolean): void {
  if (!setUserActiveRow(id, active)) {
    throw new ApiError(404, "not_found", `No user with id ${id}`);
  }
}
