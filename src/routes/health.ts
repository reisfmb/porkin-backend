import { Hono } from "hono";

export const healthRoutes = new Hono();

// Unauthenticated healthcheck for the host.
healthRoutes.get("/health", (c) => c.json({ status: "ok" }));
