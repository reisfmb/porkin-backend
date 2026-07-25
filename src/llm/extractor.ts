import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { config } from "../config.js";
import type { ExtractedTransaction } from "../types.js";

// Ported verbatim from porkin-app/src/lib/llm.ts, minus the two Tauri couplings:
// no `fetch: tauriFetch` (default fetch) and no neverthrow (plain throw). The
// API key comes from PROVIDER_API_KEY env instead of client-supplied settings.
//
// Infrastructure layer: HTTP-agnostic. Throws domain-level ExtractError; the
// service translates those into HTTP-aware ApiError.

// Flat, all-required schema — OpenAI strict structured outputs reject optionals/unions.
const extractionSchema = z.object({
  transactions: z.array(
    z.object({
      date: z.string().describe("Transaction date in ISO 8601 (YYYY-MM-DD)"),
      description: z.string().describe("Merchant/description as printed, trimmed"),
      amount: z
        .number()
        .describe("Signed amount: debits/expenses NEGATIVE, credits/income POSITIVE"),
      currency: z.string().describe("ISO 4217 code, e.g. BRL, EUR, USD"),
    }),
  ),
});

const SYSTEM_PROMPT = `You extract transactions from bank statement PDFs (any bank, any language — statements may be in Portuguese or English). Return every transaction row.

Rules:
- Dates in ISO 8601 (YYYY-MM-DD). Resolve ambiguous formats using the statement's locale: Brazilian/European statements use DD/MM/YYYY.
- Amounts are signed numbers: debits/withdrawals/purchases NEGATIVE, credits/deposits/refunds POSITIVE. Infer the sign from D/C markers, minus signs, or column position.
- Handle decimal-comma formats like "1.234,56" correctly.
- Currency from the statement; default BRL if truly absent.
- Skip non-transaction lines: opening/closing balances, subtotals, "saldo", page headers/footers.
- Keep descriptions verbatim, trimmed.`;

// Provider factory. Single provider (openai) for now; branch here to add others.
const openai = createOpenAI({ apiKey: config.providerApiKey });
const model = openai(config.model);

export type ExtractErrorKind = "extraction" | "timeout" | "internal";

export class ExtractError extends Error {
  constructor(
    public kind: ExtractErrorKind,
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "ExtractError";
  }
}

export type ExtractResult = {
  transactions: ExtractedTransaction[];
  inputTokens: number | null;
  outputTokens: number | null;
};

export async function runExtractor(
  pdfBytes: Uint8Array,
  filename: string,
): Promise<ExtractResult> {
  let result;
  try {
    result = await generateObject({
      model,
      schema: extractionSchema,
      system: SYSTEM_PROMPT,
      // Cap the provider call so a hung request never pins the worker.
      abortSignal: AbortSignal.timeout(60_000),
      messages: [
        {
          role: "user",
          content: [
            // filename is required for OpenAI PDF inputs.
            { type: "file", data: pdfBytes, mediaType: "application/pdf", filename },
            { type: "text", text: "Extract all transactions from this bank statement." },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new ExtractError("timeout", "Extraction timed out", err);
    }
    // NoObjectGeneratedError, schema mismatch, provider 4xx, etc. → treat as
    // an extraction failure (client's PDF / model output problem), not a bug.
    throw new ExtractError(
      "extraction",
      err instanceof Error ? err.message : "Extraction failed",
      err,
    );
  }

  const usage = result.usage as { inputTokens?: number; outputTokens?: number } | undefined;
  const transactions: ExtractedTransaction[] = result.object.transactions.map((t) => ({
    date: t.date,
    rawName: t.description,
    amount: t.amount,
    currency: t.currency,
    sourceFile: filename,
  }));

  return {
    transactions,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
  };
}
