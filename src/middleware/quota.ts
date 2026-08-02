import type { MiddlewareHandler } from "hono";
import { sumCostBetween } from "../db/usage.js";
import { currentMonth, dayOf } from "../period.js";
import { ApiError } from "../errors.js";
import type { AppEnv } from "./auth.js";

// Monthly spend cap, enforced per paid LLM endpoint. Must run after `auth`
// (reads the user) and is cheapest after `rateLimit` (in-memory check first).
//
// This is a PRE-check against money already spent: what the call about to run
// will cost is unknowable until it returns. So a user at $0.99 of a $1.00 cap
// still gets one more call — the cap bounds the month to roughly limit + one
// call, not exactly the limit. Concurrent requests widen that to limit + N,
// bounded by the rate limiter. Accepted deliberately; the alternative is
// reserving an estimate up front, which is a lot of machinery for cents.

export const quota: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  const { startIso, endIso } = currentMonth(new Date());
  const spent = sumCostBetween(user.id, startIso, endIso);

  if (spent >= user.monthlyLimitUsd) {
    throw new ApiError(
      402,
      "quota_exceeded",
      `Monthly usage limit reached ($${user.monthlyLimitUsd.toFixed(2)}). Resets on ${dayOf(endIso)}.`,
    );
  }
  await next();
};
