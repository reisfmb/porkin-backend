import { runExtractor, ExtractError } from "../llm/extractor.js";
import { recordUsage } from "../db/usage.js";
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
    const { transactions, inputTokens, outputTokens } = await runExtractor(pdfBytes, filename);
    recordUsage({ userId, fileName: filename, fileSize, inputTokens, outputTokens, ok: true });
    return transactions;
  } catch (err) {
    recordUsage({
      userId,
      fileName: filename,
      fileSize,
      inputTokens: null,
      outputTokens: null,
      ok: false,
    });
    if (err instanceof ExtractError) {
      if (err.kind === "timeout") throw new ApiError(504, "timeout", err.message);
      if (err.kind === "extraction") throw new ApiError(422, "extraction", err.message);
    }
    throw err; // unexpected → errorHandler maps to 500
  }
}
