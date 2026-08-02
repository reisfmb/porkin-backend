// The quota period, in one place. Both the enforcing middleware and the
// reporting endpoint call this, so "a month" can never mean two things.
//
// UTC calendar month, deliberately: it resets on a date the user can be told
// ("resets on the 1st") and needs no per-user timezone. Someone in UTC-3 gets
// their reset a few hours early; that is the whole cost of the choice.

export type Period = {
  /** Inclusive start, full ISO timestamp — comparable to `usage.created_at` as a string. */
  startIso: string;
  /** Exclusive end. Also the date the allowance resets. */
  endIso: string;
};

export function currentMonth(now: Date): Period {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    startIso: new Date(Date.UTC(y, m, 1)).toISOString(),
    endIso: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
  };
}

/** YYYY-MM-DD slice of an ISO timestamp, for display. */
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}
