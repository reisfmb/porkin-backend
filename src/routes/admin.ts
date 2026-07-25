import { Hono, type Context } from "hono";
import { ApiError } from "../errors.js";
import { adminAuth } from "../middleware/admin.js";
import { createUser, listUsers, setUserActive } from "../services/users.js";

export const adminRoutes = new Hono();

adminRoutes.use("/v1/admin/*", adminAuth);

// Thin handlers: parse/validate the HTTP request, delegate to the service, respond.
async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, "bad_request", "Malformed JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "bad_request", "Body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

// Issue a license key. The plaintext `key` is shown only in this response.
adminRoutes.post("/v1/admin/users", async (c) => {
  const body = await jsonBody(c);
  return c.json(createUser(body["name"]), 201);
});

adminRoutes.get("/v1/admin/users", (c) => c.json({ users: listUsers() }));

// Activate / deactivate a key. A deactivated user's next request gets 403.
adminRoutes.patch("/v1/admin/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, "bad_request", "`id` must be a positive integer");
  }
  const body = await jsonBody(c);
  const active = body["active"];
  if (typeof active !== "boolean") {
    throw new ApiError(400, "bad_request", "`active` must be a boolean");
  }
  setUserActive(id, active);
  return c.json({ id, active });
});
