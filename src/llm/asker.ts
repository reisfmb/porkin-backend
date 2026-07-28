import { generateObject, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { config } from "../config.js";
import type { AskContext, AskStep } from "../types.js";

// Text-to-SQL over the user's LOCAL database. We never see the DB — the app
// runs each query and posts the rows back, so this module is one turn of a
// stateless loop the client drives. Same infrastructure-layer contract as
// extractor.ts: HTTP-agnostic, throws a domain error for the service to map.

// Flat + all-required, like extractionSchema — OpenAI strict structured outputs
// reject optionals and unions, so the discriminator is a plain enum and the
// unused field comes back as "".
const askSchema = z.object({
  status: z
    .enum(["sql", "answer"])
    .describe("`sql` to run another query, `answer` when you can answer the question"),
  sql: z.string().describe("The SQLite query to run when status is `sql`, otherwise \"\""),
  answer: z
    .string()
    .describe("The natural-language answer when status is `answer`, otherwise \"\""),
});

export type AskOutput = z.infer<typeof askSchema>;

// Semantics the raw DDL can't express. Kept in sync with porkin-app's schema
// notes in its CLAUDE.md — if the app's migrations change meaning (not just
// shape), this prompt has to change with them.
const SYSTEM_PROMPT = `You answer questions about a user's personal finances by querying their local SQLite database.

You cannot see the database. Each turn you either emit ONE query to run, or the final answer.
- status "sql": put a single SQLite SELECT in \`sql\`, leave \`answer\` empty. The user's app runs it and sends you the rows.
- status "answer": put the answer in \`answer\`, leave \`sql\` empty.

Query rules:
- SQLite dialect. Exactly ONE statement, starting with SELECT or WITH. No semicolons, no SQL comments.
- STRICTLY READ-ONLY. Never INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/PRAGMA/ATTACH.
- Prefer aggregates (SUM, COUNT, AVG, GROUP BY) over returning raw rows — the result travels over the network, so keep it small. Always LIMIT queries that return individual transactions.
- Dates are TEXT in 'YYYY-MM-DD' format, so plain string comparison and strftime() both work.

Data semantics:
- transactions.amount is SIGNED: NEGATIVE = money out (expense), POSITIVE = money in (income). "How much did I spend" means SUM of negative amounts — report it as a positive figure.
- transactions.raw_name is the immutable original description from the bank. transactions.name is an optional user override. The display name is COALESCE(name, raw_name).
- For fuzzy merchant matching search BOTH: (raw_name LIKE '%term%' OR name LIKE '%term%'). LIKE is already case-insensitive for ASCII in SQLite.
- transactions.source_file IS NULL means the row was entered by hand rather than imported.
- Categories are many-to-many through the transaction_categories pivot. A transaction may have zero or several.
- transactions.account_id is nullable — an account can be deleted while its transactions remain.
- There is ONE app-wide currency (given below). There is no per-row currency column.

Answering:
- Resolve relative dates ("last week", "last month", "this year") against the given today's date.
- Write the answer in the user's language and format money with the given currency.
- Ground every number in the query results. If the data is empty or doesn't cover the question, say so plainly — never estimate or invent a figure.
- Be brief: a sentence or two. No markdown tables, no restating the SQL.`;

// Provider factory. Single provider (openai) for now; branch here to add others.
const openai = createOpenAI({ apiKey: config.providerApiKey });
const model = openai(config.model);

export type AskErrorKind = "ask" | "timeout" | "internal";

export class AskError extends Error {
  constructor(
    public kind: AskErrorKind,
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "AskError";
  }
}

export type AskLlmResult = {
  output: AskOutput;
  inputTokens: number | null;
  outputTokens: number | null;
};

function contextBlock(question: string, context: AskContext): string {
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "(none)");
  return `Today's date: ${context.today}
Currency: ${context.currency}
Answer in: ${context.locale === "pt" ? "Portuguese" : "English"}

Database schema:
${context.schema}

Existing category names: ${list(context.categories)}
Existing account names: ${list(context.accounts)}

Question: ${question}`;
}

/**
 * Replays the loop so far as plain messages. Rebuilding from `steps` on every
 * request is what keeps the endpoint stateless — no server-side session.
 */
export function buildMessages(
  question: string,
  context: AskContext,
  steps: AskStep[],
  finalTurn: boolean,
  retryReason?: string,
): ModelMessage[] {
  const messages: ModelMessage[] = [
    { role: "user", content: contextBlock(question, context) },
  ];

  for (const [i, step] of steps.entries()) {
    messages.push({
      role: "assistant",
      content: JSON.stringify({ status: "sql", sql: step.sql, answer: "" }),
    });
    const label = `Result of query ${i + 1}`;
    if (step.error) {
      messages.push({
        role: "user",
        content: `${label}: the query FAILED with: ${step.error}\nFix the query and try again, or answer if you already have enough information.`,
      });
    } else {
      const note = step.truncated ? " (truncated — only the first rows are shown)" : "";
      messages.push({
        role: "user",
        content: `${label}${note}:\n${JSON.stringify(step.rows)}`,
      });
    }
  }

  if (retryReason) {
    messages.push({
      role: "user",
      content: `That query was rejected before it ran: ${retryReason}. Emit a corrected read-only query, or answer with what you have.`,
    });
  }
  if (finalTurn) {
    messages.push({
      role: "user",
      content:
        "This is your last turn — no more queries will be run. Answer the question now with the data you already have. If it isn't enough, say what you couldn't determine.",
    });
  }

  return messages;
}

export async function runAsker(messages: ModelMessage[]): Promise<AskLlmResult> {
  let result;
  try {
    result = await generateObject({
      model,
      schema: askSchema,
      system: SYSTEM_PROMPT,
      // Cap the provider call so a hung request never pins the worker.
      abortSignal: AbortSignal.timeout(60_000),
      messages,
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new AskError("timeout", "The question timed out", err);
    }
    throw new AskError("ask", err instanceof Error ? err.message : "Could not answer", err);
  }

  const usage = result.usage as { inputTokens?: number; outputTokens?: number } | undefined;
  return {
    output: result.object,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
  };
}
