/* ============================================================
   SMS OTP / 2FA engine (plan §4.5 / §15.2 — phone verification).

   A one-time passcode flow: generate a numeric code, store only its
   salted hash with a short TTL, deliver it over the existing SMS path,
   then verify it with a bounded number of attempts.

   This module is PURE: no control-plane, no store, no I/O. It owns the
   policy, code generation/hashing, the SMS copy, and the verification
   verdict. The control plane holds the live challenges (an in-memory,
   TTL-pruned map — OTP codes are ephemeral, so a process restart simply
   means a customer re-requests) and applies the verdicts.

   Security notes:
   • The code is never stored — only `sha256("<challengeId>:<code>")`.
     Salting by the random challenge id stops the small 6-digit space
     from being directly rainbow-table-able if a hash ever leaked.
   • Verification is constant-time and attempt-capped, so the code
     cannot be brute-forced online.
   ============================================================ */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/* ---------- policy ---------- */

/** Tunable OTP policy. */
export const OTP_POLICY = {
  /** Digits in a code. */
  codeLength: 6,
  /** How long a code stays valid. */
  ttlMs: 5 * 60 * 1000,
  /** Wrong guesses tolerated before the code is burned. */
  maxVerifyAttempts: 5,
  /** Minimum gap between codes issued to one number. */
  resendCooldownMs: 30 * 1000,
  /** Codes issued to one number per `rateWindowMs`. */
  maxPerWindow: 5,
  /** The issuance rate-limit window. */
  rateWindowMs: 60 * 60 * 1000,
} as const;

/* ---------- shapes ---------- */

/** What an OTP is being used for — shapes the SMS copy. */
export type OtpPurpose = "login" | "two_factor" | "phone_verification";

/** Lifecycle state of a challenge. */
export type OtpStatus = "pending" | "verified" | "expired" | "failed";

/** A live OTP challenge. Internal — `codeHash` never leaves the control
 *  plane; surfaces get the `OtpChallengeView` instead. */
export interface OtpChallenge {
  id: string;
  projectId: string;
  accountId: string;
  /** Destination phone (E.164). Internal — views carry the masked form. */
  phone: string;
  phoneMasked: string;
  purpose: OtpPurpose;
  /** sha256("<id>:<code>") — the code itself is never stored. */
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  /** Wrong-code guesses so far. */
  attempts: number;
  status: OtpStatus;
}

/** Safe public projection of a challenge — no code, no hash. */
export interface OtpChallengeView {
  id: string;
  projectId: string;
  phoneMasked: string;
  purpose: OtpPurpose;
  status: OtpStatus;
  createdAt: string;
  expiresAt: string;
  attemptsRemaining: number;
}

/** The result of one verification attempt. */
export type OtpVerifyOutcome =
  | "verified"
  | "wrong_code"
  | "expired"
  | "too_many_attempts"
  | "already_used";

/** A verification verdict — the control plane persists the new attempt
 *  count and status onto the challenge. */
export interface OtpVerifyVerdict {
  outcome: OtpVerifyOutcome;
  /** Attempt count after this verification. */
  attemptsUsed: number;
  /** Guesses still allowed (0 once verified, burned or expired). */
  attemptsRemaining: number;
  /** The status the challenge should move to. */
  nextStatus: OtpStatus;
}

/* ---------- code generation & hashing ---------- */

/** Generate a numeric OTP code, zero-padded to the policy length. Uses
 *  `crypto.randomInt` — a CSPRNG, not `Math.random`. */
export function generateOtpCode(): string {
  const max = 10 ** OTP_POLICY.codeLength;
  return String(randomInt(0, max)).padStart(OTP_POLICY.codeLength, "0");
}

/** Hash a code for storage, salted by the challenge id. */
export function hashOtpCode(challengeId: string, code: string): string {
  return createHash("sha256").update(`${challengeId}:${code}`).digest("hex");
}

/** Constant-time hex-string compare — false (never throws) on a length
 *  mismatch or malformed input. */
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/* ---------- message copy ---------- */

/** The SMS body for a code. */
export function renderOtpMessage(purpose: OtpPurpose, code: string): string {
  const noun =
    purpose === "login"
      ? "login code"
      : purpose === "two_factor"
        ? "verification code"
        : "phone verification code";
  const mins = Math.round(OTP_POLICY.ttlMs / 60000);
  return `Your Cantila ${noun} is ${code}. It expires in ${mins} minutes. Don't share it with anyone.`;
}

/* ---------- verification ---------- */

/** The status a challenge effectively has right now — a `pending`
 *  challenge past its TTL reads as `expired` without needing a write. */
export function effectiveOtpStatus(
  challenge: OtpChallenge,
  now: Date,
): OtpStatus {
  if (
    challenge.status === "pending" &&
    now.getTime() >= new Date(challenge.expiresAt).getTime()
  ) {
    return "expired";
  }
  return challenge.status;
}

/** Pure verification verdict for one code attempt. Does not mutate the
 *  challenge — the control plane applies `attemptsUsed` / `nextStatus`. */
export function evaluateOtpVerification(
  challenge: OtpChallenge,
  code: string,
  now: Date,
): OtpVerifyVerdict {
  const { maxVerifyAttempts } = OTP_POLICY;

  if (challenge.status === "verified") {
    return {
      outcome: "already_used",
      attemptsUsed: challenge.attempts,
      attemptsRemaining: 0,
      nextStatus: "verified",
    };
  }
  if (challenge.status === "failed") {
    return {
      outcome: "too_many_attempts",
      attemptsUsed: challenge.attempts,
      attemptsRemaining: 0,
      nextStatus: "failed",
    };
  }
  if (now.getTime() >= new Date(challenge.expiresAt).getTime()) {
    return {
      outcome: "expired",
      attemptsUsed: challenge.attempts,
      attemptsRemaining: 0,
      nextStatus: "expired",
    };
  }

  const attemptsUsed = challenge.attempts + 1;
  const matches = hexEqual(
    challenge.codeHash,
    hashOtpCode(challenge.id, code),
  );
  if (matches) {
    return {
      outcome: "verified",
      attemptsUsed,
      attemptsRemaining: maxVerifyAttempts - attemptsUsed,
      nextStatus: "verified",
    };
  }
  if (attemptsUsed >= maxVerifyAttempts) {
    // Out of guesses — burn the code.
    return {
      outcome: "too_many_attempts",
      attemptsUsed,
      attemptsRemaining: 0,
      nextStatus: "failed",
    };
  }
  return {
    outcome: "wrong_code",
    attemptsUsed,
    attemptsRemaining: maxVerifyAttempts - attemptsUsed,
    nextStatus: "pending",
  };
}

/** Project the safe public view of a challenge as of `now`. */
export function toOtpChallengeView(
  challenge: OtpChallenge,
  now: Date,
): OtpChallengeView {
  return {
    id: challenge.id,
    projectId: challenge.projectId,
    phoneMasked: challenge.phoneMasked,
    purpose: challenge.purpose,
    status: effectiveOtpStatus(challenge, now),
    createdAt: challenge.createdAt,
    expiresAt: challenge.expiresAt,
    attemptsRemaining: Math.max(
      0,
      OTP_POLICY.maxVerifyAttempts - challenge.attempts,
    ),
  };
}
