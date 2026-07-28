// JSON contract shared with porkin-app. Keep in sync with
// porkin-app/src/lib/transactions/types.ts — this is the wire format the
// desktop client depends on.
export type ExtractedTransaction = {
  date: string; // ISO YYYY-MM-DD
  rawName: string;
  amount: number; // signed: debit negative, credit positive
  currency: string;
  sourceFile: string;
};

// ---- /v1/license ----
// Duplicated in porkin-app (src/lib/settings/types.ts). Keep both copies identical.

/** Only ever returned on success — an invalid key is a 401/403, not `valid: false`. */
export type LicenseStatus = {
  valid: true;
  name: string;
};

// ---- /v1/ask ----
// Also duplicated in porkin-app (src/lib/ask/types.ts). Same reasoning as
// above: a small stable JSON shape isn't worth a shared workspace.

/** Everything about the user's DB the model needs, supplied fresh by the client each turn. */
export type AskContext = {
  schema: string; // live DDL, read from the client's sqlite_master
  today: string; // client-local date, YYYY-MM-DD
  currency: string; // ISO 4217 — one per app
  locale: string; // "en" | "pt"
  categories: string[]; // names only
  accounts: string[]; // names only
};

/** One completed round-trip: a query we asked for, and what running it locally produced. */
export type AskStep = {
  sql: string;
  rows: unknown[];
  truncated: boolean;
  /** Set when the query failed on the client — fed back so the model can correct itself. */
  error?: string;
};

export type AskRequest = {
  question: string;
  context: AskContext;
  steps: AskStep[];
};

/** `sql` ⇒ the client runs it and calls again with a new step; `answer` ⇒ done. */
export type AskResponse = {
  status: "sql" | "answer";
  sql: string;
  answer: string;
};
