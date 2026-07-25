import type { MiddlewareHandler } from "hono";
import { config } from "../config.js";
import { secretEquals } from "../crypto.js";
import { ApiError } from "../errors.js";

// Gates /v1/admin/*: bearer token compared against ADMIN_KEY (constant-time).
// Not a license key — it's env-only, has no `users` row, and grants nothing
// outside /v1/admin/* (see CLAUDE.md "Auth model"). Never log the key.
export const adminAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  // Same error whether the key is wrong or admin isn't configured at all.
  if (!match || !config.adminKey || !secretEquals(match[1].trim(), config.adminKey)) {
    throw new ApiError(401, "unauthorized", "Invalid admin key");
  }
  await next();
};
