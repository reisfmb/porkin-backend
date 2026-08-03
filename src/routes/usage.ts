import { Hono } from "hono";
import { auth, type AppEnv } from "../middleware/auth.js";
import { usageSummary } from "../services/usage.js";

export const usageRoutes = new Hono<AppEnv>();

// Path pattern must stay specific to this route: sub-app middleware is merged into
// the parent by `app.route("/", …)`, so a broad "/v1/*" here would also gate every
// other /v1 route — including any future one that isn't license-key authed.
//
// No `rateLimit` and no `quota`, same reasoning as /v1/license: a free read must
// never be starved by — or blocked by — the paid budget it reports on. Checking
// how much is left has to work precisely when nothing is left.
usageRoutes.use("/v1/usage", auth);

usageRoutes.get("/v1/usage", (c) => {
  const user = c.get("user");
  return c.json(usageSummary(user.id, user.monthlyLimitUsd), 200);
});
