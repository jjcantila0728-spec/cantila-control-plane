/* ============================================================
   Password hashing for per-user auth (plan §5.4).

   scrypt with a per-password random salt — no external dependency.
   Stored format: `scrypt$<saltHex>$<keyHex>`. Verification is
   constant-time and returns false (never throws) on a malformed
   hash, so a corrupt row degrades to "wrong password" rather than
   a 500.
   ============================================================ */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEYLEN = 64;
const PREFIX = "scrypt";

/** Hash a plaintext password for storage. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(plain, salt, KEYLEN);
  return `${PREFIX}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Constant-time verify a plaintext password against a stored hash. */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;
  try {
    const expected = Buffer.from(parts[2], "hex");
    const actual = scryptSync(
      plain,
      Buffer.from(parts[1], "hex"),
      expected.length || KEYLEN,
    );
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}
