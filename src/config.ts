// Env parsing, done once at startup. Fail fast on missing/invalid required vars
// so we never boot half-configured (and never accidentally serve without a key).

// Load .env into process.env if present (local dev). No-op when the file is
// absent — in prod (Railway) vars come from the platform, not a file.
try {
  process.loadEnvFile();
} catch {
  // no .env file — fine
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid env var ${name}: expected positive number, got "${raw}"`);
  }
  return n;
}

const MIN_ADMIN_KEY_LEN = 24;

// Optional: gates /v1/admin/*. Unset → the admin routes are inert (always 401).
// A short admin key is worse than none, so reject weak ones at boot.
function adminKeyEnv(): string | undefined {
  const v = process.env.ADMIN_KEY?.trim();
  if (!v) return undefined;
  if (v.length < MIN_ADMIN_KEY_LEN) {
    throw new Error(`Invalid env var ADMIN_KEY: must be at least ${MIN_ADMIN_KEY_LEN} chars`);
  }
  return v;
}

export const config = {
  // Railway injects PORT; default for local dev.
  port: intEnv("PORT", 8787),
  dbPath: process.env.DB_PATH?.trim() || "./data/porkin.db",
  provider: process.env.PROVIDER?.trim() || "openai",
  model: process.env.MODEL?.trim() || "gpt-5.1",
  providerApiKey: required("PROVIDER_API_KEY"),
  adminKey: adminKeyEnv(),
  maxUploadMb: intEnv("MAX_UPLOAD_MB", 15),
  rateLimitPerMin: intEnv("RATE_LIMIT_PER_MIN", 20),
} as const;

export const maxUploadBytes = config.maxUploadMb * 1024 * 1024;
