import { Hono } from "hono";
import { config, maxUploadBytes } from "../config.js";
import { ApiError } from "../errors.js";
import { extractStatement } from "../services/extraction.js";
import { auth, type AppEnv } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const extractRoutes = new Hono<AppEnv>();

// Path pattern must stay specific to this route: sub-app middleware is merged into
// the parent by `app.route("/", …)`, so a broad "/v1/*" here would also gate
// /v1/admin/* (which uses ADMIN_KEY, not license keys).
extractRoutes.use("/v1/extract", auth, rateLimit);

// Thin handler: validate the HTTP request, delegate to the service, respond.
extractRoutes.post("/v1/extract", async (c) => {
  const user = c.get("user");

  // Cheap pre-read guard: reject oversized bodies before buffering them.
  const contentLength = Number(c.req.header("Content-Length") ?? 0);
  if (contentLength > maxUploadBytes) {
    throw new ApiError(413, "too_large", `File exceeds ${config.maxUploadMb} MB limit`);
  }

  let file: File | undefined;
  try {
    const body = await c.req.parseBody();
    const f = body["file"];
    if (f instanceof File) file = f;
  } catch {
    throw new ApiError(400, "bad_request", "Malformed multipart body");
  }
  if (!file) {
    throw new ApiError(400, "bad_request", "Missing `file` field");
  }

  const filename = file.name || "upload.pdf";
  const isPdf = file.type === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    throw new ApiError(400, "bad_request", "Only application/pdf is accepted");
  }
  if (file.size > maxUploadBytes) {
    throw new ApiError(413, "too_large", `File exceeds ${config.maxUploadMb} MB limit`);
  }

  const pdfBytes = new Uint8Array(await file.arrayBuffer());
  const transactions = await extractStatement({
    pdfBytes,
    filename,
    fileSize: file.size,
    userId: user.id,
  });

  return c.json({ transactions }, 200);
});
