import { Hono } from "hono";
import { errorHandler } from "./errors.js";
import { healthRoutes } from "./routes/health.js";
import { extractRoutes } from "./routes/extract.js";
import { adminRoutes } from "./routes/admin.js";
import type { AppEnv } from "./middleware/auth.js";

// Assemble the app (no listen) so it can be constructed in tests too.
export function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route("/", healthRoutes);
  app.route("/", extractRoutes);
  app.route("/", adminRoutes);
  return app;
}
