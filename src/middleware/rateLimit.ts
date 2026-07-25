import type { MiddlewareHandler } from "hono";
import { config } from "../config.js";
import { ApiError } from "../errors.js";
import type { AppEnv } from "./auth.js";

// In-memory per-user token bucket. Fine for a single-instance deployment
// (SQLite + one Railway container). Refills continuously at capacity/minute.
type Bucket = { tokens: number; last: number };
const buckets = new Map<number, Bucket>();

/**
 * Token-bucket rate limiter. Each user has a "bucket" holding up to `perMinute`
 * tokens; every allowed request spends one. Tokens drip back in continuously so
 * the bucket refills to full over one minute.
 *
 * Why a token bucket (vs. a fixed window / sliding window)?
 * - It caps the sustained rate (`perMinute` per minute) AND allows short bursts:
 *   a user who's been idle has a full bucket and can fire `perMinute` requests
 *   back-to-back, then is throttled to the drip rate. This is friendlier than a
 *   fixed window while still bounding cost.
 * - No timers or background sweeps: refill is computed lazily from elapsed time
 *   on each call ("lazy refill"), so it's cheap and self-correcting.
 *
 * How the math works:
 * - `refillPerMs = perMinute / 60_000` → tokens regained per millisecond.
 *   e.g. perMinute=20 → 1 token every 3s.
 * - On each call we add `(now - last) * refillPerMs` tokens for the time that
 *   passed since we last touched this bucket, capped at `perMinute` (the bucket
 *   never overflows), and update `last` to now.
 * - If at least 1 token is available, spend it and allow (return true).
 *   Otherwise deny (return false) — the caller turns this into HTTP 429.
 *
 * `tokens` is a float on purpose: partial tokens accumulate between calls, so
 * fractional refill isn't lost to rounding. A bucket is created full on first
 * sight, so a user's very first request always passes.
 *
 * Scope & limitations (important for future changes):
 * - State lives in a module-level Map in THIS process's memory. It's per-user,
 *   but only correct for a SINGLE instance. Run two replicas and each keeps its
 *   own buckets, so the effective limit doubles. For horizontal scaling, move
 *   this state to a shared store (e.g. Redis with INCR+EXPIRE or a Lua bucket).
 * - The Map grows one entry per user and is never evicted. Fine for a handful of
 *   users; for many/unbounded users add periodic cleanup of stale buckets (or an
 *   LRU) to avoid unbounded memory.
 * - Not persisted: a restart resets everyone to a full bucket.
 *
 * @param userId    key the bucket is tracked under (here, the authed user id)
 * @param perMinute bucket capacity AND the sustained requests-per-minute rate
 * @returns true if the request is allowed (a token was spent), false if limited
 */
function tryConsume(userId: number, perMinute: number): boolean {
  const now = Date.now();
  const refillPerMs = perMinute / 60_000;

  // First request from this user: start with a full bucket.
  let b = buckets.get(userId);
  if (!b) {
    b = { tokens: perMinute, last: now };
    buckets.set(userId, b);
  }

  // Lazily refill for the time elapsed since the last call, capped at capacity.
  b.tokens = Math.min(perMinute, b.tokens + (now - b.last) * refillPerMs);
  b.last = now;

  // Spend one token if we can; otherwise the request is rate-limited.
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Must run after `auth` (reads the user from context).
export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (!tryConsume(user.id, config.rateLimitPerMin)) {
    throw new ApiError(429, "rate_limited", "Too many requests, slow down");
  }
  await next();
};
