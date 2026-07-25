import type { MiddlewareHandler } from "hono";
import { findUserByKeyHash, type User } from "../db/users.js";
import { sha256Hex } from "../crypto.js";
import { ApiError } from "../errors.js";

// Hono env: the authed user is attached for downstream handlers + usage logging.
export type AppEnv = { Variables: { user: User } };

// Bearer-key auth. Apply to /v1/*. Leaves /health open.
export const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new ApiError(401, "unauthorized", "Missing or malformed Authorization header");
  }
  const user = findUserByKeyHash(sha256Hex(match[1].trim()));
  if (!user) {
    throw new ApiError(401, "unauthorized", "Invalid license key");
  }
  if (user.active !== 1) {
    throw new ApiError(403, "inactive", "License key is inactive");
  }
  c.set("user", user);
  await next();
};
