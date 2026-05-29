/* PKCE (RFC 7636) helpers — S256 challenge derivation. Google supports
 * PKCE; GitHub OAuth Apps do not, so the GitHub provider ignores the
 * challenge and relies on the client secret + state cookie. */
import { createHash, randomBytes } from "node:crypto";

/** A high-entropy code verifier (43-128 chars, base64url). */
export function generatePkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** code_challenge = BASE64URL(SHA256(verifier)). */
export function derivePkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
