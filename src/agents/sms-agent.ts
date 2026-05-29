/* ============================================================
   SmsAgent — watches Cantila SMS deliverability per number
   (plan §4.9 — "Bounce rate, delivery failure spikes → rotates
   IPs, throttles, opens an incident", SMS half).

   Reasons over the SMS-event ring (`cp.getSmsDeliverability`):
     - failure_rate_high      — failureRatePct ≥ FAILURE_WARN (5%)
     - failure_rate_critical  — failureRatePct ≥ FAILURE_CRIT (15%)
     - opt_out_rate_high      — optOutRatePct  ≥ OPT_OUT_WARN  (3%)
     - number_silence         — known number, zero traffic in window

   SMS has no FBL; the equivalent reputation signal is the opt-out
   rate (recipients texting back STOP). A high opt-out rate is the
   "your content isn't wanted" indicator and tanks carrier trust
   the same way email complaints tank deliverability.

   All proposals are DESTRUCTIVE — pausing or throttling a number
   blocks legitimate alerts. Per §4.9 safety nothing auto-applies;
   the brain queues them.
   ============================================================ */

import type { ControlPlane } from "../core/control-plane";
import { id as makeId, now } from "../lib/ids";
import type { Agent, Observation, Proposal } from "./types";
import { ownerAccountId } from "../lib/owner-account";

const ACCOUNT = ownerAccountId();
const WINDOW_MS = 60 * 60 * 1000; // last hour
const MIN_SAMPLE = 10;
const FAILURE_WARN_PCT = 5;
const FAILURE_CRIT_PCT = 15;
const OPT_OUT_WARN_PCT = 3;

function terminal(d: {
  delivered: number;
  failed: number;
  undelivered: number;
}): number {
  return d.delivered + d.failed + d.undelivered;
}

export class SmsAgent implements Agent {
  readonly name = "sms" as const;

  async observe(cp: ControlPlane): Promise<Observation[]> {
    const sinceIso = new Date(Date.now() - WINDOW_MS).toISOString();
    const numbers = await cp.getSmsDeliverability(ACCOUNT, { sinceIso });
    const out: Observation[] = [];

    for (const n of numbers) {
      const sample = terminal(n);
      if (sample < MIN_SAMPLE) continue;
      if (n.failureRatePct >= FAILURE_CRIT_PCT) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "failure_rate_critical",
          detail: `${n.fromE164} failure rate ${n.failureRatePct}% (${n.failed + n.undelivered}/${sample})`,
        });
      } else if (n.failureRatePct >= FAILURE_WARN_PCT) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "failure_rate_high",
          detail: `${n.fromE164} failure rate ${n.failureRatePct}% (${n.failed + n.undelivered}/${sample})`,
        });
      }
      if (n.sent >= MIN_SAMPLE && n.optOutRatePct >= OPT_OUT_WARN_PCT) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "opt_out_rate_high",
          detail: `${n.fromE164} opt-out rate ${n.optOutRatePct}% (${n.optOut}/${n.sent})`,
        });
      }
    }

    const fleet = await cp.listAccountPhoneNumbers(ACCOUNT);
    for (const num of fleet) {
      const hasTraffic = numbers.some(
        (n) => n.fromE164 === num.e164 && n.sent > 0,
      );
      if (!hasTraffic) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "number_silence",
          detail: `${num.e164} sent nothing in the last ${WINDOW_MS / 60_000} min`,
          projectId: num.projectId,
        });
      }
    }

    return out;
  }

  async propose(cp: ControlPlane): Promise<Proposal[]> {
    const sinceIso = new Date(Date.now() - WINDOW_MS).toISOString();
    const numbers = await cp.getSmsDeliverability(ACCOUNT, { sinceIso });
    const out: Proposal[] = [];

    for (const n of numbers) {
      const sample = terminal(n);
      if (sample < MIN_SAMPLE) continue;

      if (n.failureRatePct >= FAILURE_CRIT_PCT) {
        out.push({
          id: `prop_${makeId("sms").slice(3)}_pause_${n.fromE164}`,
          at: now(),
          agent: this.name,
          kind: "pause_number",
          title: `Pause ${n.fromE164} — failure rate ${n.failureRatePct}%`,
          body: `${n.fromE164} is failing ${n.failed + n.undelivered} of ${sample} terminal events (${n.failureRatePct}%) in the last ${WINDOW_MS / 60_000} min. That's far above the ${FAILURE_CRIT_PCT}% line carriers use to flag a number for abuse review. Pause sending, check that the destination list isn't all invalid numbers, and confirm the originating route is still registered.`,
          confidence: "high",
          actionClass: "destructive",
          hints: [
            {
              label: "Pause via CLI",
              hint: `# Cantila CLI doesn't expose sms pause yet; for now,\n# revoke the per-project SMS api key: cantila sms revoke-key <project>`,
            },
          ],
          execute: async () => ({
            ok: true,
            detail:
              "Acknowledged — the real SMSC isn't wired yet; pause is operator-driven.",
          }),
        });
      } else if (n.failureRatePct >= FAILURE_WARN_PCT) {
        out.push({
          id: `prop_${makeId("sms").slice(3)}_throttle_${n.fromE164}`,
          at: now(),
          agent: this.name,
          kind: "throttle_number",
          title: `Throttle ${n.fromE164} — failure rate ${n.failureRatePct}%`,
          body: `${n.fromE164} is at ${n.failureRatePct}% failures (${n.failed + n.undelivered}/${sample}). It's not in carrier-flag territory yet but the curve is wrong — throttling the per-second send rate now buys time to investigate.`,
          confidence: "medium",
          actionClass: "destructive",
          hints: [
            {
              label: "Audit recent failures",
              hint: `curl /v1/sms/deliverability?sinceMinutes=60 | jq '.numbers[] | select(.fromE164=="${n.fromE164}")'`,
            },
          ],
          execute: async () => ({
            ok: true,
            detail:
              "Acknowledged — throttling needs SMSC rate-limit knobs; operator-driven for now.",
          }),
        });
      }

      if (n.sent >= MIN_SAMPLE && n.optOutRatePct >= OPT_OUT_WARN_PCT) {
        out.push({
          id: `prop_${makeId("sms").slice(3)}_optout_${n.fromE164}`,
          at: now(),
          agent: this.name,
          kind: "audit_sms_content",
          title: `Audit ${n.fromE164} content — opt-outs at ${n.optOutRatePct}%`,
          body: `${n.fromE164} is generating STOP replies at ${n.optOutRatePct}% (${n.optOut}/${n.sent}). Carriers track this — sustained opt-out rates above 2-3% cause shortcode reviews and can get a long-code blocked. Confirm recipients opted in, that the From friendly-name is recognised, and that every message respects the documented send schedule.`,
          confidence: "medium",
          actionClass: "destructive",
          execute: async () => ({
            ok: true,
            detail: "Acknowledged — content audit is an operator decision.",
          }),
        });
      }
    }

    return out;
  }
}
