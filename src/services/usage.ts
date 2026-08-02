import { breakdownBetween } from "../db/usage.js";
import { currentMonth, dayOf } from "../period.js";
import type { UsageSummary } from "../types.js";

// Business logic for GET /v1/usage: the same period the quota middleware
// enforces, reported back so the desktop app can show it. Framework-agnostic.

export function usageSummary(userId: number, monthlyLimitUsd: number): UsageSummary {
  const { startIso, endIso } = currentMonth(new Date());
  const b = breakdownBetween(userId, startIso, endIso);

  return {
    periodStart: dayOf(startIso),
    periodEnd: dayOf(endIso),
    limitUsd: monthlyLimitUsd,
    spentUsd: b.spentUsd,
    // A pre-checked quota can overshoot, so this would otherwise go negative.
    remainingUsd: Math.max(0, monthlyLimitUsd - b.spentUsd),
    byEndpoint: b.byEndpoint,
    daily: b.daily,
    tokens: { input: b.inputTokens, output: b.outputTokens },
  };
}
