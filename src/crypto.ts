import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// Constant-time secret comparison. Hashing first gives two equal-length buffers,
// so timingSafeEqual never throws and no length information leaks.
export function secretEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// URL-safe license key. Plaintext is shown to the operator once; only its
// SHA-256 hash is persisted.
export function generateLicenseKey(): string {
  return randomBytes(24).toString("base64url");
}
