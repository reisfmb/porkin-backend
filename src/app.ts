import { Hono } from "hono";
import { errorHandler } from "./errors.js";
import { healthRoutes } from "./routes/health.js";
import { licenseRoutes } from "./routes/license.js";
import { usageRoutes } from "./routes/usage.js";
import { extractRoutes } from "./routes/extract.js";
import { askRoutes } from "./routes/ask.js";
import type { AppEnv } from "./middleware/auth.js";

// Assemble the app (no listen) so it can be constructed in tests too.
export function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route("/", healthRoutes);
  app.route("/", licenseRoutes);
  app.route("/", usageRoutes);
  app.route("/", extractRoutes);
  app.route("/", askRoutes);
  return app;
}
