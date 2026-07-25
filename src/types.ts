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
