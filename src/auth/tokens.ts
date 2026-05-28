/* ============================================================
   One-shot token mint + verify (plan §5.4 — password reset,
   email verification).

   The shape mirrors the OTP module: pure helpers, no I/O. The
   control plane holds the live tokens (an in-memory TTL-pruned
   map — these are short-lived and a process restart simply means
   the user re-requests). The token itself is delivered out-of-band
   (email today, SMS for future flows); only the `sha256(<id>:<token>)`
   ever sits in memory.

   Two purposes wired today:
   • `password_reset` — bound to a user id; expires in 1h.
   • `email_verify`   — bound to a user id; expires in 24h.

   Both are single-use (consumed on success) and rate-limited to
   stop a casual enumeration loop from exhausting the issuance
   budget.
   ============================================================ */

import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/* ---------- policy ---------- */

export const TOKEN_POLICY = {
  password_reset: {
    ttlMs: 60 * 60 * 1000, // 1 hour
    /** Tokens issued per email per `rateWindowMs`. */
    maxPerWindow: 4,
    rateWindowMs: 60 * 60 * 1000,
  },
  email_verify: {
    ttlMs: 24 * 60 * 60 * 1000, // 24 hours
    maxPerWindow: 6,
    rateWindowMs: 24 * 60 * 60 * 1000,
  },
} as const;

export type TokenPurpose = "password_reset" | "email_verify";

export type TokenStatus = "pending" | "used" | "expired";

/** A live one-shot token. Internal — `tokenHash` never leaves the
 *  control plane; views never carry the raw token. */
export interface OneShotToken {
  id: string;
  purpose: TokenPurpose;
  userId: string;
  /** sha256("<id>:<token>") — the token itself is never stored. */
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  status: TokenStatus;
}

/** Public verification verdict — no token, no hash. */
export type TokenVerifyOutcome =
  | "verified"
  | "wrong_token"
  | "expired"
  | "already_used";

/* ---------- mint ---------- */

/** Mint a fresh one-shot token. Returns the id, the raw token (the
 *  *only* time the raw token exists in memory — the caller is
 *  responsible for handing it to the user via email/SMS and dropping
 *  the value), and the stored shape. */
export function mintOneShotToken(input: {
  purpose: TokenPurpose;
  userId: string;
  now?: Date;
}): {
  raw: string;
  stored: OneShotToken;
} {
  const now = input.now ?? new Date();
  const id = `tk_${randomBytes(8).toString("hex")}`;
  // 32 bytes → 256 bits. URL-safe by hex-encoding so it can ride a
  // query string without further escaping.
  const raw = randomBytes(32).toString("hex");
  const tokenHash = hashOneShotToken(id, raw);
  const policy = TOKEN_POLICY[input.purpose];
  const expiresAt = new Date(now.getTime() + policy.ttlMs).toISOString();
  return {
    raw: `${id}.${raw}`,
    stored: {
      id,
      purpose: input.purpose,
      userId: input.userId,
      tokenHash,
      createdAt: now.toISOString(),
      expiresAt,
      status: "pending",
    },
  };
}

export function hashOneShotToken(id: string, raw: string): string {
  return createHash("sha256").update(`${id}:${raw}`).digest("hex");
}

/** Split a presented token into its `<id>.<raw>` parts. Returns null
 *  on a malformed shape — caller treats that as `wrong_token`. */
export function parsePresentedToken(
  presented: string,
): { id: string; raw: string } | null {
  const dot = presented.indexOf(".");
  if (dot <= 0 || dot === presented.length - 1) return null;
  return { id: presented.slice(0, dot), raw: presented.slice(dot + 1) };
}

/* ---------- verify ---------- */

/** Constant-time hex compare. False on length mismatch / malformed. */
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Pure verification — caller persists the new status. */
export function evaluateTokenVerification(
  stored: OneShotToken,
  presented: { id: string; raw: string },
  now: Date,
): TokenVerifyOutcome {
  if (stored.status === "used") return "already_used";
  if (stored.status === "expired") return "expired";
  if (now.getTime() >= new Date(stored.expiresAt).getTime()) return "expired";
  if (stored.id !== presented.id) return "wrong_token";
  if (!hexEqual(stored.tokenHash, hashOneShotToken(presented.id, presented.raw))) {
    return "wrong_token";
  }
  return "verified";
}

/** Reads a `pending` token as `expired` once its TTL has passed,
 *  without needing a write. Symmetric to `effectiveOtpStatus`. */
export function effectiveTokenStatus(
  stored: OneShotToken,
  now: Date,
): TokenStatus {
  if (
    stored.status === "pending" &&
    now.getTime() >= new Date(stored.expiresAt).getTime()
  ) {
    return "expired";
  }
  return stored.status;
}
