import { config } from "../config.js";
import { generateLicenseKey, sha256Hex } from "../crypto.js";
import {
  insertUser,
  listUsers as listUserRows,
  setUserActive as setUserActiveRow,
  setUserLimit as setUserLimitRow,
  type UserSummary,
} from "../db/users.js";
import { spendByUserBetween } from "../db/usage.js";
import { currentMonth } from "../period.js";
import { ApiError } from "../errors.js";

// Business logic for user/license-key administration. Framework-agnostic (no Hono).

const MAX_NAME_LEN = 100;
/** Sanity ceiling on a per-user monthly cap — a typo shouldn't authorise $10k of spend. */
const MAX_MONTHLY_LIMIT_USD = 1000;

export type CreatedUser = { id: number; name: string; key: string; monthlyLimitUsd: number };

/** Shared by create and update so both reject the same values. */
function parseLimit(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new ApiError(400, "bad_request", "`monthlyLimitUsd` must be a number");
  }
  if (raw <= 0 || raw > MAX_MONTHLY_LIMIT_USD) {
    throw new ApiError(
      400,
      "bad_request",
      `\`monthlyLimitUsd\` must be greater than 0 and at most ${MAX_MONTHLY_LIMIT_USD}`,
    );
  }
  return raw;
}

// The plaintext key is returned ONCE (never stored — only its SHA-256 hash).
export function createUser(rawName: unknown, rawLimit: unknown): CreatedUser {
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
  // Omitted → the configured default. Users are expected to differ, so the limit
  // is written onto the row rather than left to the column DEFAULT.
  const monthlyLimitUsd =
    rawLimit === undefined ? config.defaultMonthlyLimitUsd : parseLimit(rawLimit);

  const key = generateLicenseKey();
  const id = insertUser(name, sha256Hex(key), monthlyLimitUsd);
  return { id, name, key, monthlyLimitUsd };
}

/** Admin view: the row plus what it spent this month, so changing a limit is an informed call. */
export type UserWithSpend = UserSummary & { spentUsd: number };

export function listUsers(): UserWithSpend[] {
  const { startIso, endIso } = currentMonth(new Date());
  const spend = spendByUserBetween(startIso, endIso);
  return listUserRows().map((u) => ({ ...u, spentUsd: spend.get(u.id) ?? 0 }));
}

export function setUserActive(id: number, active: boolean): void {
  if (!setUserActiveRow(id, active)) {
    throw new ApiError(404, "not_found", `No user with id ${id}`);
  }
}

/** Returns the applied limit so the route can echo the validated number back. */
export function setUserLimit(id: number, rawLimit: unknown): number {
  const limit = parseLimit(rawLimit);
  if (!setUserLimitRow(id, limit)) {
    throw new ApiError(404, "not_found", `No user with id ${id}`);
  }
  return limit;
}
