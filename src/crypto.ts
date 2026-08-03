import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// URL-safe license key. Plaintext is shown to the operator once; only its
// SHA-256 hash is persisted.
export function generateLicenseKey(): string {
  return randomBytes(24).toString("base64url");
}
