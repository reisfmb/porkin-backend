import { runExtractor, ExtractError } from "../llm/extractor.js";
import { recordUsage } from "../db/usage.js";
import { costUsd } from "../pricing.js";
import { config } from "../config.js";
import { ApiError } from "../errors.js";
import type { ExtractedTransaction } from "../types.js";

// Business logic: orchestrate the LLM extraction and usage accounting, and
// translate domain errors into HTTP-aware ApiError. Framework-agnostic (no Hono).

type ExtractInput = {
  pdfBytes: Uint8Array;
  filename: string;
  fileSize: number;
  userId: number;
};

export async function extractStatement({
  pdfBytes,
  filename,
  fileSize,
  userId,
}: ExtractInput): Promise<ExtractedTransaction[]> {
  try {
    const { transactions, inputTokens, cachedInputTokens, outputTokens } = await runExtractor(
      pdfBytes,
      filename,
    );
    recordUsage({
      userId,
      endpoint: "extract",
      model: config.model,
      fileName: filename,
      fileSize,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      costUsd: costUsd(config.model, { inputTokens, cachedInputTokens, outputTokens }),
      ok: true,
    });
    return transactions;
  } catch (err) {
    // The call threw before reporting usage, so its real cost is unknown and
    // logs as 0 — a known undercount against the quota (see CLAUDE.md "Quota").
    recordUsage({
      userId,
      endpoint: "extract",
      model: config.model,
      fileName: filename,
      fileSize,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      costUsd: 0,
      ok: false,
    });
    if (err instanceof ExtractError) {
      if (err.kind === "timeout") throw new ApiError(504, "timeout", err.message);
      if (err.kind === "extraction") throw new ApiError(422, "extraction", err.message);
    }
    throw err; // unexpected → errorHandler maps to 500
  }
}
