/* ============================================================
   Dunning state machine (plan §8 / §15.2 — failed-payment handling).

   When a subscription charge fails, Stripe does not cancel immediately
   — it retries on a schedule ("Smart Retries"). Cantila reacts to each
   `invoice.payment_failed` / `invoice.paid` webhook Stripe sends and
   walks the owning Account through a small billing-health state machine:

       active ──payment_failed──▶ past_due ──exhausted/grace──▶ suspended
         ▲                          │                              │
         └──────── payment_paid ────┴──────── payment_paid ─────────┘

   and, when Stripe finally gives up and deletes the subscription, an
   account already in dunning lands in `canceled`.

   This module is PURE: no control-plane, no store, no I/O. Each
   transition function takes the current account state + a clock and
   returns a `DunningTransition` — a patch to persist plus a list of
   side effects (activity events, dunning emails) for the control plane
   to run. That keeps the escalation logic trivially testable and means
   the same machine drives both the webhook path and the time-based
   grace-expiry sweep.

   Backward-compatible: `billingStatus` is absent on legacy Account rows
   and `normaliseStatus` reads `undefined` as `active`, so an account
   that has never had a payment fail behaves exactly as before.
   ============================================================ */

import type { AccountBillingStatus } from "../domain/types";

/* ---------- policy ---------- */

/** Tunable dunning policy. The defaults mirror Stripe's Smart Retries:
 *  four retry attempts spread across roughly three weeks. */
export const DUNNING_POLICY = {
  /** Failed-payment attempts tolerated before `past_due` → `suspended`. */
  maxAttempts: 4,
  /** Grace window from the first failed payment to suspension. The
   *  attempt-based and clock-based escalations are tuned to land close
   *  together so neither one alone is a surprise. */
  graceWindowMs: 21 * 24 * 60 * 60 * 1000,
} as const;

/** The grace window in whole days — for display surfaces (CLI, Console). */
export const DUNNING_GRACE_DAYS = Math.round(
  DUNNING_POLICY.graceWindowMs / (24 * 60 * 60 * 1000),
);

/* ---------- shapes ---------- */

/** Which dunning email a transition rendered. */
export type DunningEmailTemplate =
  | "payment_failed_first"
  | "payment_failed_retry"
  | "account_suspended"
  | "account_restored";

/** The slice of an Account the dunning machine reads. The full domain
 *  `Account` satisfies this, so the control plane passes one straight in. */
export interface DunningSubject {
  /** Account display name — used in rendered emails. */
  name: string;
  billingStatus?: AccountBillingStatus;
  dunningAttempts?: number;
  dunningFailedAt?: string;
  dunningGraceEndsAt?: string;
}

/** A patch the control plane persists via `store.updateAccount`. Only
 *  ever SETS fields — the machine never clears `dunningFailedAt` /
 *  `dunningGraceEndsAt`, because every reader gates on `billingStatus`
 *  and a stale clock on a healthy account is harmless. This sidesteps
 *  the null-vs-undefined clearing footgun across the two stores. */
export interface DunningPatch {
  billingStatus?: AccountBillingStatus;
  dunningAttempts?: number;
  dunningFailedAt?: string;
  dunningGraceEndsAt?: string;
}

/** A side effect for the control plane to run after persisting the patch. */
export type DunningEffect =
  | {
      kind: "email";
      template: DunningEmailTemplate;
      subject: string;
      body: string;
    }
  | { kind: "activity"; title: string; detail: string };

/** The result of one transition. */
export interface DunningTransition {
  /** Account fields to persist. Empty `{}` when nothing changed. */
  patch: DunningPatch;
  /** Effects to run after the patch lands. */
  effects: DunningEffect[];
  /** True when `billingStatus` moved to a new value. */
  statusChanged: boolean;
}

/** The do-nothing transition. */
const NO_OP: DunningTransition = { patch: {}, effects: [], statusChanged: false };

/* ---------- helpers ---------- */

/** Read an account's billing status, treating `undefined` (legacy rows)
 *  as `active`. */
export function normaliseStatus(a: DunningSubject): AccountBillingStatus {
  return a.billingStatus ?? "active";
}

/** True when an account's billing health should block new deploys. */
export function isDeployBlocked(a: DunningSubject): boolean {
  const s = normaliseStatus(a);
  return s === "suspended" || s === "canceled";
}

/** ISO timestamp → `YYYY-MM-DD` for human-facing copy. */
function shortDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/* ---------- email rendering ---------- */

/** Render a dunning email. Plain text — the platform MTA (not yet real,
 *  plan §15.2) will wrap it; until then the control plane records the
 *  rendered notice in a ring so it is inspectable. */
export function renderDunningEmail(
  template: DunningEmailTemplate,
  ctx: { name: string; attempts?: number; graceEndsAt?: string },
): { subject: string; body: string } {
  const max = DUNNING_POLICY.maxAttempts;
  switch (template) {
    case "payment_failed_first":
      return {
        subject: "Your Cantila payment didn't go through",
        body:
          `Hi ${ctx.name},\n\n` +
          `We tried to charge your card for your Cantila subscription and ` +
          `it didn't go through. No need to worry — your account and ` +
          `everything you've deployed are still fully active.\n\n` +
          `We'll automatically retry over the next ${DUNNING_GRACE_DAYS} ` +
          `days. To fix it now, update your payment method from the ` +
          `billing page.\n\n` +
          (ctx.graceEndsAt
            ? `If payment hasn't recovered by ${shortDate(ctx.graceEndsAt)}, ` +
              `the account will be suspended.\n\n`
            : "") +
          `— The Cantila team`,
      };
    case "payment_failed_retry":
      return {
        subject: `Payment retry failed — attempt ${ctx.attempts ?? 0} of ${max}`,
        body:
          `Hi ${ctx.name},\n\n` +
          `We retried the charge for your Cantila subscription and it ` +
          `failed again (attempt ${ctx.attempts ?? 0} of ${max}). Your ` +
          `account is still active, but please update your payment ` +
          `method soon to avoid an interruption.\n\n` +
          `— The Cantila team`,
      };
    case "account_suspended":
      return {
        subject: "Your Cantila account has been suspended",
        body:
          `Hi ${ctx.name},\n\n` +
          `We weren't able to collect payment for your Cantila ` +
          `subscription, so the account has been suspended. Your ` +
          `existing deployments stay online, but new deploys are paused ` +
          `until billing is resolved.\n\n` +
          `Update your payment method on the billing page and the ` +
          `account will be restored automatically as soon as a charge ` +
          `succeeds.\n\n` +
          `— The Cantila team`,
      };
    case "account_restored":
      return {
        subject: "Your Cantila account is active again",
        body:
          `Hi ${ctx.name},\n\n` +
          `Thanks — your payment came through and your Cantila account ` +
          `is fully active again. Deploys are re-enabled and there's ` +
          `nothing else you need to do.\n\n` +
          `— The Cantila team`,
      };
  }
}

/** Build an `email` effect for a template + context. */
function emailEffect(
  template: DunningEmailTemplate,
  ctx: { name: string; attempts?: number; graceEndsAt?: string },
): DunningEffect {
  const { subject, body } = renderDunningEmail(template, ctx);
  return { kind: "email", template, subject, body };
}

/* ---------- transitions ---------- */

/** A subscription charge failed (`invoice.payment_failed`). Opens a
 *  dunning cycle on the first failure, escalates retries, and suspends
 *  once `maxAttempts` is reached. */
export function onPaymentFailed(
  account: DunningSubject,
  now: Date,
): DunningTransition {
  const status = normaliseStatus(account);
  if (status === "canceled") return NO_OP; // nothing left to dun

  const attempts = (account.dunningAttempts ?? 0) + 1;
  const failedAt = now.toISOString();

  if (status === "active") {
    // First failure — open the cycle and start the grace clock.
    const graceEndsAt = new Date(
      now.getTime() + DUNNING_POLICY.graceWindowMs,
    ).toISOString();
    return {
      patch: {
        billingStatus: "past_due",
        dunningAttempts: attempts,
        dunningFailedAt: failedAt,
        dunningGraceEndsAt: graceEndsAt,
      },
      effects: [
        {
          kind: "activity",
          title: "Payment failed — account past due",
          detail: `attempt ${attempts}/${DUNNING_POLICY.maxAttempts} · grace period ends ${shortDate(graceEndsAt)}`,
        },
        emailEffect("payment_failed_first", {
          name: account.name,
          attempts,
          graceEndsAt,
        }),
      ],
      statusChanged: true,
    };
  }

  if (status === "past_due") {
    if (attempts >= DUNNING_POLICY.maxAttempts) {
      // Retries exhausted — suspend now without waiting for the clock.
      return {
        patch: {
          billingStatus: "suspended",
          dunningAttempts: attempts,
          dunningFailedAt: failedAt,
        },
        effects: [
          {
            kind: "activity",
            title: "Account suspended — payment retries exhausted",
            detail: `${attempts}/${DUNNING_POLICY.maxAttempts} attempts failed`,
          },
          emailEffect("account_suspended", { name: account.name, attempts }),
        ],
        statusChanged: true,
      };
    }
    // Another retry failed, still inside the grace window.
    return {
      patch: { dunningAttempts: attempts, dunningFailedAt: failedAt },
      effects: [
        {
          kind: "activity",
          title: "Payment retry failed",
          detail: `attempt ${attempts}/${DUNNING_POLICY.maxAttempts}`,
        },
        emailEffect("payment_failed_retry", { name: account.name, attempts }),
      ],
      statusChanged: false,
    };
  }

  // status === "suspended" — already suspended. Keep counting attempts
  // for the audit trail, but don't email an already-suspended owner and
  // don't escalate further (the next step is Stripe deleting the sub).
  return {
    patch: { dunningAttempts: attempts, dunningFailedAt: failedAt },
    effects: [
      {
        kind: "activity",
        title: "Payment failed while suspended",
        detail: `attempt ${attempts}`,
      },
    ],
    statusChanged: false,
  };
}

/** A subscription charge succeeded (`invoice.paid`). For an account in
 *  dunning this is recovery — it returns to `active` and the attempt
 *  counter resets. For a healthy account it is a no-op. */
export function onPaymentSucceeded(account: DunningSubject): DunningTransition {
  const status = normaliseStatus(account);
  if (status === "active" || status === "canceled") return NO_OP;

  const wasSuspended = status === "suspended";
  return {
    // billingStatus → active + attempts → 0. The stale dunningFailedAt /
    // dunningGraceEndsAt are intentionally left as-is (harmless once the
    // status is active; see the DunningPatch doc comment).
    patch: { billingStatus: "active", dunningAttempts: 0 },
    effects: [
      {
        kind: "activity",
        title: "Payment recovered — account restored",
        detail: wasSuspended
          ? "deploys re-enabled"
          : "exited the grace period",
      },
      emailEffect("account_restored", { name: account.name }),
    ],
    statusChanged: true,
  };
}

/** The grace clock elapsed. Run by the dunning sweep against every
 *  `past_due` account — escalates to `suspended` even if no further
 *  `invoice.payment_failed` webhook ever arrives. */
export function onGraceExpiry(
  account: DunningSubject,
  now: Date,
): DunningTransition {
  if (normaliseStatus(account) !== "past_due") return NO_OP;
  if (!account.dunningGraceEndsAt) return NO_OP;
  if (now.getTime() < new Date(account.dunningGraceEndsAt).getTime()) {
    return NO_OP;
  }
  return {
    patch: { billingStatus: "suspended" },
    effects: [
      {
        kind: "activity",
        title: "Account suspended — grace period elapsed",
        detail: `grace period ended ${shortDate(account.dunningGraceEndsAt)}`,
      },
      emailEffect("account_suspended", {
        name: account.name,
        attempts: account.dunningAttempts ?? 0,
      }),
    ],
    statusChanged: true,
  };
}

/** Stripe deleted the subscription (`customer.subscription.deleted`).
 *  For an account already in dunning this is a non-payment cancellation
 *  → `canceled`. For a healthy account it is a voluntary downgrade and
 *  the dunning machine stays out of it (returns a no-op). */
export function onSubscriptionDeleted(
  account: DunningSubject,
): DunningTransition {
  const status = normaliseStatus(account);
  if (status === "past_due" || status === "suspended") {
    return {
      patch: { billingStatus: "canceled" },
      effects: [
        {
          kind: "activity",
          title: "Account canceled — subscription ended for non-payment",
          detail: "Stripe exhausted every retry",
        },
      ],
      statusChanged: true,
    };
  }
  return NO_OP;
}
