import { Hono } from "hono";
import { auth, type AppEnv } from "../middleware/auth.js";
import type { LicenseStatus } from "../types.js";

export const licenseRoutes = new Hono<AppEnv>();

// Path pattern must stay specific to this route: sub-app middleware is merged into
// the parent by `app.route("/", …)`, so a broad "/v1/*" here would also gate every
// other /v1 route — including any future one that isn't license-key authed.
//
// No `rateLimit`: it shares one per-user bucket with /v1/extract and /v1/ask, and a
// free DB lookup shouldn't be able to starve paid calls. An unmetered hit costs one
// SHA-256 plus one indexed SELECT, and keys are 24 random bytes — nothing to guess.
licenseRoutes.use("/v1/license", auth);

// Getting past `auth` IS the validation: an unknown key 401s and a revoked one 403s
// before we ever reach here, so there is nothing left to check.
licenseRoutes.get("/v1/license", (c) => {
  // Field by field, not a spread: the User carries `keyHash`.
  const status: LicenseStatus = { valid: true, name: c.get("user").name };
  return c.json(status, 200);
});
