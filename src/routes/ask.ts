import { Hono, type Context } from "hono";
import { maxAskBytes } from "../config.js";
import { ApiError } from "../errors.js";
import { answerQuestion, MAX_STEPS } from "../services/ask.js";
import { auth, type AppEnv } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import type { AskContext, AskStep } from "../types.js";

export const askRoutes = new Hono<AppEnv>();

// Path pattern must stay specific to this route: sub-app middleware is merged
// into the parent by `app.route("/", …)`, so a broad "/v1/*" here would also
// gate /v1/admin/* (which uses ADMIN_KEY, not license keys).
askRoutes.use("/v1/ask", auth, rateLimit);

const MAX_QUESTION_LENGTH = 500;
const MAX_SCHEMA_LENGTH = 20_000;
const MAX_NAMES = 500;

function bad(message: string): never {
  throw new ApiError(400, "bad_request", message);
}

function strField(obj: Record<string, unknown>, key: string, max: number): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") bad(`\`context.${key}\` must be a non-empty string`);
  if ((v as string).length > max) bad(`\`context.${key}\` exceeds ${max} characters`);
  return v as string;
}

function nameList(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) bad(`\`context.${key}\` must be an array`);
  if (v.length > MAX_NAMES) bad(`\`context.${key}\` exceeds ${MAX_NAMES} entries`);
  return v.slice(0, MAX_NAMES).map((n) => String(n));
}

function parseContext(raw: unknown): AskContext {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    bad("`context` must be an object");
  }
  const o = raw as Record<string, unknown>;
  return {
    schema: strField(o, "schema", MAX_SCHEMA_LENGTH),
    today: strField(o, "today", 10),
    currency: strField(o, "currency", 8),
    locale: strField(o, "locale", 8),
    categories: nameList(o, "categories"),
    accounts: nameList(o, "accounts"),
  };
}

function parseSteps(raw: unknown): AskStep[] {
  if (!Array.isArray(raw)) bad("`steps` must be an array");
  // The server owns the budget — a client can't buy extra turns by padding this.
  if (raw.length > MAX_STEPS) bad(`\`steps\` exceeds the ${MAX_STEPS}-query budget`);
  return raw.map((s) => {
    if (typeof s !== "object" || s === null) bad("each step must be an object");
    const o = s as Record<string, unknown>;
    if (typeof o["sql"] !== "string") bad("each step needs a `sql` string");
    if (!Array.isArray(o["rows"])) bad("each step needs a `rows` array");
    return {
      sql: o["sql"] as string,
      rows: o["rows"] as unknown[],
      truncated: o["truncated"] === true,
      ...(typeof o["error"] === "string" ? { error: o["error"] } : {}),
    };
  });
}

// Thin handler: validate the HTTP request, delegate to the service, respond.
askRoutes.post("/v1/ask", async (c: Context<AppEnv>) => {
  const user = c.get("user");

  // Cheap pre-read guard: step rows make this body unbounded otherwise.
  const contentLength = Number(c.req.header("Content-Length") ?? 0);
  if (contentLength > maxAskBytes) {
    throw new ApiError(413, "too_large", "Request body too large");
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    bad("Malformed JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    bad("Body must be a JSON object");
  }
  const o = body as Record<string, unknown>;

  const question = o["question"];
  if (typeof question !== "string" || question.trim() === "") {
    bad("`question` must be a non-empty string");
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    bad(`\`question\` exceeds ${MAX_QUESTION_LENGTH} characters`);
  }

  const result = await answerQuestion({
    question: question.trim(),
    context: parseContext(o["context"]),
    steps: parseSteps(o["steps"] ?? []),
    userId: user.id,
  });

  return c.json(result, 200);
});
