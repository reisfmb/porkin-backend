import { AskError, buildMessages, runAsker, type AskLlmResult } from "../llm/asker.js";
import { assertReadOnlySql, SqlRejected } from "../llm/sqlGuard.js";
import { recordUsage } from "../db/usage.js";
import { costUsd } from "../pricing.js";
import { config } from "../config.js";
import { ApiError } from "../errors.js";
import type { AskContext, AskResponse, AskStep } from "../types.js";

// Business logic: one turn of the client-driven text-to-SQL loop. Orchestrates
// the model call, the SQL guard, and usage accounting; translates domain errors
// into HTTP-aware ApiError. Framework-agnostic (no Hono).

/**
 * How many queries the model gets per question. The client counts too, but the
 * server is what enforces it — a client could otherwise loop forever on our key.
 */
export const MAX_STEPS = 3;

// Note: MAX_STEPS and the monthly quota are independent budgets. The quota is
// checked per HTTP request, so a question can trip it mid-loop and die with a
// 402 after its earlier turns were already paid for. Chosen over exempting
// in-flight questions, which would let a client spend past the cap by always
// having one open.

type AskInput = {
  question: string;
  context: AskContext;
  steps: AskStep[];
  userId: number;
};

/** Every model call is billable, so every model call gets its own usage row. */
async function callModel(
  userId: number,
  messages: Parameters<typeof runAsker>[0],
): Promise<AskLlmResult> {
  try {
    const result = await runAsker(messages);
    recordUsage({
      userId,
      endpoint: "ask",
      model: config.model,
      fileName: null,
      fileSize: null,
      inputTokens: result.inputTokens,
      cachedInputTokens: result.cachedInputTokens,
      outputTokens: result.outputTokens,
      costUsd: costUsd(config.model, result),
      ok: true,
    });
    return result;
  } catch (err) {
    // Threw before reporting usage: real cost unknown, logs as 0 (see CLAUDE.md "Quota").
    recordUsage({
      userId,
      endpoint: "ask",
      model: config.model,
      fileName: null,
      fileSize: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      costUsd: 0,
      ok: false,
    });
    throw err;
  }
}

export async function answerQuestion({
  question,
  context,
  steps,
  userId,
}: AskInput): Promise<AskResponse> {
  // On the final allowed turn we tell the model it has no queries left, so a
  // `sql` reply there is a real failure rather than a step we could still run.
  const finalTurn = steps.length >= MAX_STEPS;

  try {
    let { output } = await callModel(userId, buildMessages(question, context, steps, finalTurn));

    if (output.status === "answer") {
      return { status: "answer", sql: "", answer: output.answer.trim() };
    }
    if (finalTurn) {
      throw new ApiError(
        422,
        "ask_failed",
        "Could not answer the question within the query budget",
      );
    }

    // Guard the SQL; a rejection is fed straight back for one correction attempt
    // rather than failing the whole question.
    try {
      return { status: "sql", sql: assertReadOnlySql(output.sql), answer: "" };
    } catch (err) {
      if (!(err instanceof SqlRejected)) throw err;

      ({ output } = await callModel(
        userId,
        buildMessages(question, context, steps, false, err.message),
      ));
      if (output.status === "answer") {
        return { status: "answer", sql: "", answer: output.answer.trim() };
      }
      try {
        return { status: "sql", sql: assertReadOnlySql(output.sql), answer: "" };
      } catch (retryErr) {
        if (!(retryErr instanceof SqlRejected)) throw retryErr;
        throw new ApiError(422, "ask_failed", `Generated an unsafe query: ${retryErr.message}`);
      }
    }
  } catch (err) {
    if (err instanceof AskError) {
      if (err.kind === "timeout") throw new ApiError(504, "timeout", err.message);
      if (err.kind === "ask") throw new ApiError(422, "ask_failed", err.message);
    }
    throw err; // ApiError passes through; anything else → errorHandler maps to 500
  }
}
