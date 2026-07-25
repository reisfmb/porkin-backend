import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Typed HTTP error. Handlers/middleware/services throw this; the central
// errorHandler (registered via app.onError) turns it into the JSON response.
export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public kind: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Single place that maps thrown errors → HTTP responses. Keeps the standard
// { error: { kind, message } } shape everywhere.
export function errorHandler(err: unknown, c: Context) {
  if (err instanceof ApiError) {
    return c.json({ error: { kind: err.kind, message: err.message } }, err.status);
  }
  console.error("Unhandled error:", err);
  return c.json({ error: { kind: "internal", message: "Internal server error" } }, 500);
}
