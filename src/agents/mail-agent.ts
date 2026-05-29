/* ============================================================
   MailAgent — watches Cantila Mail deliverability per sending
   domain and per IP pool (plan §4.9 — "Bounce rate, delivery
   failure spikes → rotates IPs, throttles, opens an incident").

   Reasons over the mail-event ring:
     `cp.getMailDeliverability` — per sending domain
     `cp.getMailPoolDeliverability` — per IP pool (plan §4.4)

   Observations:
     - bounce_rate_high      — bounceRatePct ≥ BOUNCE_WARN (5%)
     - bounce_rate_critical  — bounceRatePct ≥ BOUNCE_CRIT (10%)
     - complaint_rate_high   — complaintRatePct ≥ COMPLAINT_WARN (0.5%)
     - sending_silence       — known mailbox but zero recent events
     - pool_reputation_low   — a pool's reputation has dropped below
                               POOL_REPUTATION_FLOOR with ≥ MIN_SAMPLE
                               terminal events through it

   All proposals are DESTRUCTIVE — throttling or pausing a sender
   blocks legitimate mail. Per §4.9 safety nothing auto-applies in
   v1; the brain queues them for the operator. When the real MTA
   lands the execute closures grow real bodies; the observation
   shape stays the same.
   ============================================================ */

import type { ControlPlane } from "../core/control-plane";
import { id as makeId, now } from "../lib/ids";
import type { Agent, Observation, Proposal } from "./types";
import { ownerAccountId } from "../lib/owner-account";

const ACCOUNT = ownerAccountId();
const WINDOW_MS = 60 * 60 * 1000; // last hour
/** Minimum terminal events before we trust the rate (avoids "1/1 bounced
 *  → 100% bounce rate" noise on a quiet day). */
const MIN_SAMPLE = 10;
const BOUNCE_WARN_PCT = 5;
const BOUNCE_CRIT_PCT = 10;
const COMPLAINT_WARN_PCT = 0.5;
/** Pool reputation floor. The reputation column moves on every terminal
 *  send (see `cp.adjustPoolReputation`), so dropping below 50 means the
 *  pool has accumulated meaningful bounce/complaint signal in the
 *  rolling window — not a cold-start anomaly. Below 30 is the critical
 *  band where the brain stops asking and recommends a hard pause. */
const POOL_REPUTATION_WARN = 50;
const POOL_REPUTATION_CRIT = 30;

function terminal(d: {
  delivered: number;
  bounced: number;
  complained: number;
  deferred: number;
}): number {
  return d.delivered + d.bounced + d.complained + d.deferred;
}

export class MailAgent implements Agent {
  readonly name = "mail" as const;

  async observe(cp: ControlPlane): Promise<Observation[]> {
    const sinceIso = new Date(Date.now() - WINDOW_MS).toISOString();
    const domains = await cp.getMailDeliverability(ACCOUNT, { sinceIso });
    const out: Observation[] = [];

    for (const d of domains) {
      const sample = terminal(d);
      if (sample < MIN_SAMPLE) continue;
      if (d.bounceRatePct >= BOUNCE_CRIT_PCT) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "bounce_rate_critical",
          detail: `${d.sendingDomain} bounce rate ${d.bounceRatePct}% (${d.bounced}/${sample})`,
        });
      } else if (d.bounceRatePct >= BOUNCE_WARN_PCT) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "bounce_rate_high",
          detail: `${d.sendingDomain} bounce rate ${d.bounceRatePct}% (${d.bounced}/${sample})`,
        });
      }
      if (d.complaintRatePct >= COMPLAINT_WARN_PCT) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "complaint_rate_high",
          detail: `${d.sendingDomain} complaint rate ${d.complaintRatePct}% (${d.complained}/${sample})`,
        });
      }
    }

    // Sending silence — mailbox exists but nothing has gone through it in the
    // window. Informational: the operator may have switched providers.
    const fleet = await cp.listAccountMailboxes(ACCOUNT);
    for (const mb of fleet.mailboxes) {
      const hasTraffic = domains.some(
        (d) => d.sendingDomain === mb.sendingDomain && d.sent > 0,
      );
      if (!hasTraffic) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "sending_silence",
          detail: `${mb.address} sent nothing in the last ${WINDOW_MS / 60_000} min`,
          projectId: mb.projectId,
        });
      }
    }

    // Per-pool reputation — flag pools that have absorbed enough
    // bounce/complaint signal to push their reputation under the floor.
    // (Plan §4.4 — IP-pool rotation.) MailAgent reads
    // `getMailPoolDeliverability` and `cp.adjustPoolReputation` is the
    // feedback loop that moves the reputation column.
    const pools = await cp.getMailPoolDeliverability(ACCOUNT, { sinceIso });
    for (const p of pools) {
      const sample = terminal(p);
      if (sample < MIN_SAMPLE) continue;
      if (p.reputation < POOL_REPUTATION_WARN) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "pool_reputation_low",
          detail: `${p.poolName} (${p.poolKind}) reputation ${p.reputation} · ${p.bounced + p.complained}/${sample} adverse in window`,
        });
      }
    }

    return out;
  }

  async propose(cp: ControlPlane): Promise<Proposal[]> {
    const sinceIso = new Date(Date.now() - WINDOW_MS).toISOString();
    const domains = await cp.getMailDeliverability(ACCOUNT, { sinceIso });
    const out: Proposal[] = [];

    for (const d of domains) {
      const sample = terminal(d);
      if (sample < MIN_SAMPLE) continue;

      // Critical bounce rate → propose pausing the sender (high confidence).
      // High but sub-critical → propose throttling (medium).
      if (d.bounceRatePct >= BOUNCE_CRIT_PCT) {
        out.push({
          id: `prop_${makeId("mal").slice(3)}_pause_${d.sendingDomain}`,
          at: now(),
          agent: this.name,
          kind: "pause_domain",
          title: `Pause ${d.sendingDomain} — bounce rate ${d.bounceRatePct}%`,
          body: `${d.sendingDomain} is bouncing ${d.bounced} of ${sample} terminal events (${d.bounceRatePct}%) in the last ${WINDOW_MS / 60_000} min. That's far above the ${BOUNCE_CRIT_PCT}% line where mailbox providers start treating the IP as compromised. Pause sending, find the bad list segment, then warm the IP back up gradually.`,
          confidence: "high",
          actionClass: "destructive",
          hints: [
            {
              label: "Pause via CLI",
              hint: `# Cantila CLI doesn't expose mail pause yet; for now,\n# revoke per-project SMTP creds: cantila mail revoke-smtp <project>`,
            },
          ],
          execute: async () => ({
            ok: true,
            detail:
              "Acknowledged — the real MTA isn't wired yet; pause is operator-driven.",
          }),
        });
      } else if (d.bounceRatePct >= BOUNCE_WARN_PCT) {
        out.push({
          id: `prop_${makeId("mal").slice(3)}_throttle_${d.sendingDomain}`,
          at: now(),
          agent: this.name,
          kind: "throttle_domain",
          title: `Throttle ${d.sendingDomain} — bounce rate ${d.bounceRatePct}%`,
          body: `${d.sendingDomain} is at ${d.bounceRatePct}% bounces (${d.bounced}/${sample}). It's not blowing up yet but the trajectory is wrong — throttling to a lower send rate now lets reputation cool down without going dark. The IP-pool rotator (once shipped) would do this automatically.`,
          confidence: "medium",
          actionClass: "destructive",
          hints: [
            {
              label: "Audit recent bounces",
              hint: `curl /v1/mail/deliverability?sinceMinutes=60 | jq '.domains[] | select(.sendingDomain=="${d.sendingDomain}")'`,
            },
          ],
          execute: async () => ({
            ok: true,
            detail:
              "Acknowledged — throttling needs MTA rate-limit knobs; operator-driven for now.",
          }),
        });
      }

      // Complaint rate is its own line — even at low bounce rates, FBL hits
      // tank reputation fast. Always destructive, always escalates to review.
      if (d.complaintRatePct >= COMPLAINT_WARN_PCT) {
        out.push({
          id: `prop_${makeId("mal").slice(3)}_complaint_${d.sendingDomain}`,
          at: now(),
          agent: this.name,
          kind: "audit_mail_content",
          title: `Audit ${d.sendingDomain} content — complaints at ${d.complaintRatePct}%`,
          body: `${d.sendingDomain} is generating spam complaints at ${d.complaintRatePct}%. The industry watermark is 0.1% — anything above that is a deliverability cliff. The mail itself is likely unwanted: triple-check that recipients opted in, that the From: matches the friendly-name, and that List-Unsubscribe headers are landing.`,
          confidence: "medium",
          actionClass: "destructive",
          execute: async () => ({
            ok: true,
            detail: "Acknowledged — content audit is an operator decision.",
          }),
        });
      }
    }

    // Per-pool reputation — propose pausing a pool that has lost
    // reputation faster than the IP can earn it back. (Plan §4.4.) High
    // confidence below POOL_REPUTATION_CRIT (the brain doesn't think the
    // pool can recover without going dark); medium between WARN and
    // CRIT (a measured throttle / audit is the right move). Hint points
    // at the existing PATCH route — `cantila mail pools update <id>
    // --active false` flips the operator-facing knob; a future drop
    // wires the MTA to actually stop routing through the paused pool.
    const pools = await cp.getMailPoolDeliverability(ACCOUNT, { sinceIso });
    for (const p of pools) {
      const sample = terminal(p);
      if (sample < MIN_SAMPLE) continue;
      if (p.reputation >= POOL_REPUTATION_WARN) continue;
      const critical = p.reputation < POOL_REPUTATION_CRIT;
      out.push({
        id: `prop_${makeId("mal").slice(3)}_pool_${p.poolId.slice(-8)}`,
        at: now(),
        agent: this.name,
        kind: "pause_pool",
        title: critical
          ? `Pause ${p.poolName} — reputation ${p.reputation} (critical)`
          : `Throttle ${p.poolName} — reputation ${p.reputation}`,
        body: critical
          ? `${p.poolName} (${p.poolKind}) reputation has dropped to ${p.reputation} after ${p.bounced + p.complained} adverse / ${sample} terminal events in the last ${WINDOW_MS / 60_000} min. Continuing to send through this pool further damages every IP it carries. Pause it — fall back to a clean pool — and start the warmup ramp on a replacement when the bad list segment is gone.`
          : `${p.poolName} (${p.poolKind}) reputation is at ${p.reputation} (${p.bounced + p.complained} adverse / ${sample}). Not critical yet, but the trajectory is wrong — drop the send rate, isolate the bad list segment, and let the pool's reputation recover before resuming full volume.`,
        confidence: critical ? "high" : "medium",
        actionClass: "destructive",
        hints: [
          {
            label: "Pause the pool",
            hint: `cantila mail pools update ${p.poolId} --active false`,
          },
        ],
        execute: async () => ({
          ok: true,
          detail:
            "Acknowledged — pool pause is an operator decision until the MTA reads the active flag at send time.",
        }),
      });
    }

    return out;
  }
}
