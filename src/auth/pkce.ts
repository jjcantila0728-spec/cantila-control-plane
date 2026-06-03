/* PKCE (RFC 7636) helpers — S256 challenge derivation. Google supports
 * PKCE; GitHub OAuth Apps do not, so the GitHub provider ignores the
 * challenge and relies on the client secret + state cookie. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A high-entropy code verifier (43-128 chars, base64url). */
export function generatePkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** code_challenge = BASE64URL(SHA256(verifier)). */
export function derivePkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** RFC 7636 §4.6 — the S256 check a token endpoint runs: does
 *  BASE64URL(SHA256(verifier)) equal the stored challenge? Constant-time
 *  compare on equal-length buffers; unequal length is a plain `false`
 *  (never throws). Used by the MCP OAuth connector's token exchange. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const a = Buffer.from(derivePkceChallenge(verifier));
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
