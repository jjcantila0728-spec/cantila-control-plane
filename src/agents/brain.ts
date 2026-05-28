/* ============================================================
   AgentBrain — the single decision-maker behind every agent.
   See plan §4.9. Holds the world snapshot, append-only memory,
   pending proposals and an action journal. Ticks on a timer
   when `start()` is called.
   ============================================================ */

import type { ControlPlane } from "../core/control-plane";
import { now } from "../lib/ids";
import type {
  Agent,
  AgentName,
  ActionRecord,
  BrainSnapshot,
  Confidence,
  LearningRecord,
  Observation,
  Proposal,
} from "./types";

const OBSERVATION_BUFFER = 200;
const ACTION_BUFFER = 100;
/** Don't trust the learning signal until the brain has tried a kind this
 *  many times. Below this, all proposals run at their proposed confidence. */
const MIN_LEARNING_ATTEMPTS = 3;
/** Success-rate threshold under which the brain stops auto-applying a kind.
 *  Below this, the kind's effective confidence is bumped down one notch
 *  (high → medium, medium → low) — which lifts it out of the auto-apply
 *  band so it queues for human review instead. */
const LEARNING_DOWNGRADE_BELOW = 50;
/** Default delay between an action's execute and its verify (plan §4.9 —
 *  post-checks). A proposal can override per-kind via `verifyDelayMs`. */
const DEFAULT_VERIFY_DELAY_MS = 30_000;

/** Walk the kind down one step. The auto-apply policy is `high + safe`, so
 *  knocking a failing kind out of `high` is what actually stops the brain
 *  from re-applying a broken action over and over. */
function downgradeConfidence(c: Confidence): Confidence {
  if (c === "high") return "medium";
  if (c === "medium") return "low";
  return "low";
}

export class AgentBrain {
  private observations: Observation[] = [];
  private pending: Proposal[] = [];
  private actions: ActionRecord[] = [];
  private paused = false;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private agents: Agent[];
  /** Scheduled post-check timers, keyed by `proposalId`. Cleared on `stop()`
   *  so a teardown doesn't leave verifier callbacks running. */
  private verifyTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private cp: ControlPlane,
    agents: Agent[],
  ) {
    this.agents = agents;
  }

  /** Begin ticking. Safe to call twice — second call is a no-op. Also
   *  loads the durable action journal from the store so the learning
   *  loop survives a process restart (plan §4.9). */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    // First, rehydrate from the durable journal. Best-effort — if the
    // store fails we keep going on a fresh in-memory ring rather than
    // refusing to boot the brain.
    void this.loadDurable();
    // Then start ticking. First tick happens on the next event-loop turn
    // so callers can finish wiring before the brain wakes up.
    setImmediate(() => void this.tick());
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  private async loadDurable(): Promise<void> {
    try {
      const persisted = await this.cp.listAgentActionsDurable({
        limit: ACTION_BUFFER,
      });
      if (persisted.length === 0) return;
      // The store returns oldest-first; merge in front of any in-memory
      // actions that may have been pushed before start() (rare, but the
      // _injectAction test seam can do this).
      this.actions = [
        ...persisted.map(
          (a) =>
            ({
              at: a.at,
              proposalId: a.proposalId,
              agent: a.agent as AgentName,
              kind: a.kind,
              title: a.title,
              outcome: a.outcome,
              detail: a.detail,
              verified: a.verified,
              verifiedAt: a.verifiedAt,
              verifyDetail: a.verifyDetail,
              resultProjectId: a.resultProjectId,
            }) satisfies ActionRecord,
        ),
        ...this.actions,
      ];
      if (this.actions.length > ACTION_BUFFER) {
        this.actions = this.actions.slice(-ACTION_BUFFER);
      }
    } catch {
      // swallow — durable journal is best-effort
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Pending verifiers — clear them so we don't keep firing after teardown.
    for (const t of this.verifyTimers.values()) clearTimeout(t);
    this.verifyTimers.clear();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Test seam — push a synthetic action into the journal so the learning
   *  loop can be exercised end-to-end without contriving real failures.
   *  Used by the dev-only `POST /v1/agents/_test/inject-action` route; not
   *  reachable from the standard transports. Also persists to the
   *  durable store so the smoke test for restart-survival works. */
  _injectAction(record: ActionRecord): void {
    this.actions.push(record);
    if (this.actions.length > ACTION_BUFFER) {
      this.actions = this.actions.slice(-ACTION_BUFFER);
    }
    void this.cp.recordAgentActionDurable(record).catch(() => {});
  }

  /** Test seam — simulate a process restart by wiping the in-memory
   *  journal and rehydrating from the durable store. The learning loop's
   *  numbers should be identical before and after when the store is
   *  intact. Wired to `POST /v1/agents/_test/reload`. */
  async _reloadFromDurable(): Promise<void> {
    this.actions = [];
    await this.loadDurable();
  }

  /** Schedule a proposal's `verify` closure to run after its delay. The
   *  result transitions the matching action's `verified` field out of
   *  "pending". If the action has fallen off the ring buffer by then,
   *  the result is silently discarded — the journal is in-memory and
   *  bounded by design. */
  private scheduleVerify(p: Proposal): void {
    if (!p.verify) return;
    const delayMs = p.verifyDelayMs ?? DEFAULT_VERIFY_DELAY_MS;
    const timer = setTimeout(() => {
      this.verifyTimers.delete(p.id);
      void this.runVerify(p);
    }, delayMs);
    timer.unref?.();
    this.verifyTimers.set(p.id, timer);
  }

  private async runVerify(p: Proposal): Promise<void> {
    if (!p.verify) return;
    let outcome: { verified: boolean; detail: string };
    try {
      outcome = await p.verify(this.cp);
    } catch (err) {
      outcome = {
        verified: false,
        detail: err instanceof Error ? err.message : "verifier threw",
      };
    }
    const verifiedAt = now();
    const verified = outcome.verified ? "ok" : "failed";
    // Find the action by proposalId; the journal is small enough that a
    // linear scan from the tail is fine and avoids a separate index.
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const a = this.actions[i];
      if (a.proposalId !== p.id) continue;
      a.verified = verified;
      a.verifiedAt = verifiedAt;
      a.verifyDetail = outcome.detail;
      break;
    }
    // Persist the verification result too — best-effort.
    void this.cp
      .updateAgentActionVerificationDurable(p.id, {
        verified,
        verifiedAt,
        verifyDetail: outcome.detail,
      })
      .catch(() => {});
  }

  /** Force one synchronous tick — used by HTTP `?fresh=1` and by tests. */
  async tick(): Promise<void> {
    if (this.paused || this.ticking) return;
    this.ticking = true;
    try {
      // 1 — each agent observes
      for (const agent of this.agents) {
        try {
          const next = await agent.observe(this.cp);
          this.observations.push(...next);
        } catch {
          // an agent failing must never crash the brain
        }
      }
      // 2 — each agent proposes
      const newProposals: Proposal[] = [];
      for (const agent of this.agents) {
        try {
          const next = await agent.propose(this.cp);
          newProposals.push(...next);
        } catch {
          // ditto
        }
      }
      // 3 — replace pending with this tick's set (proposals are derived
      // from current state, so stale ones from prior ticks should be
      // dropped if the underlying condition is gone).
      this.pending = newProposals;

      // 4 — the brain decides which proposals to act on. Policy:
      //     effective_confidence(proposed, learnings) === "high"
      //     AND actionClass === "safe"
      //     → auto-apply. Everything else stays pending for human review.
      //
      //  The learning loop (plan §4.9 — continuous learning) computes
      //  per-(agent, kind) success rates from the action journal and
      //  downgrades the effective confidence on kinds that have failed
      //  repeatedly. That breaks the loop where a broken auto-action
      //  keeps re-firing on every tick.
      const learnings = this.buildLearnings();
      const willAct = this.pending.filter((p) => {
        const eff = this.effectiveConfidence(p, learnings);
        return eff === "high" && p.actionClass === "safe";
      });
      for (const p of willAct) {
        let record: ActionRecord;
        try {
          const result = await p.execute(this.cp);
          const ok = result.ok;
          // Post-check (plan §4.9): if execute succeeded AND the proposal
          // carries a verify closure, mark the action `pending` and
          // schedule the verifier. If execute failed, there is nothing
          // to verify — leave it `n/a`.
          const verified: ActionRecord["verified"] =
            ok && p.verify ? "pending" : "n/a";
          record = {
            at: now(),
            proposalId: p.id,
            agent: p.agent,
            kind: p.kind,
            title: p.title,
            outcome: ok ? "ok" : "failed",
            detail: result.detail,
            verified,
            resultProjectId: p.projectId,
          };
          this.actions.push(record);
          if (verified === "pending") this.scheduleVerify(p);
        } catch (err) {
          record = {
            at: now(),
            proposalId: p.id,
            agent: p.agent,
            kind: p.kind,
            title: p.title,
            outcome: "failed",
            detail: err instanceof Error ? err.message : "agent action failed",
            verified: "n/a",
            resultProjectId: p.projectId,
          };
          this.actions.push(record);
        }
        // Persist the action. Best-effort — a store failure mustn't
        // wedge the brain. ActionRecord and StoredAgentAction are
        // structurally compatible (the latter widens `agent` to string).
        void this.cp.recordAgentActionDurable(record).catch(() => {});
      }
      // Auto-applied proposals are removed from `pending` so the snapshot
      // only shows what still needs human review.
      const actedIds = new Set(willAct.map((p) => p.id));
      this.pending = this.pending.filter((p) => !actedIds.has(p.id));

      // 5 — trim buffers
      if (this.observations.length > OBSERVATION_BUFFER) {
        this.observations = this.observations.slice(-OBSERVATION_BUFFER);
      }
      if (this.actions.length > ACTION_BUFFER) {
        this.actions = this.actions.slice(-ACTION_BUFFER);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Roll the action journal up into per-(agent, kind) records. Pure —
   *  used both by the decision policy each tick and by the snapshot. */
  private buildLearnings(): LearningRecord[] {
    type Bucket = {
      agent: AgentName;
      kind: string;
      attempts: number;
      successes: number;
      failures: number;
      lastOutcome: "ok" | "failed";
      lastAt: string;
    };
    const map = new Map<string, Bucket>();
    for (const a of this.actions) {
      const key = `${a.agent}:${a.kind}`;
      const b = map.get(key) ?? {
        agent: a.agent,
        kind: a.kind,
        attempts: 0,
        successes: 0,
        failures: 0,
        lastOutcome: a.outcome,
        lastAt: a.at,
      };
      b.attempts += 1;
      // Effective outcome: the execute closure said ok AND (no verifier ran
      // or verifier confirmed). A `verified: "failed"` overrides
      // `outcome: "ok"` — that's the whole point of post-checks. A
      // `verified: "pending"` is treated as a tentative success (the
      // verifier hasn't run yet); the next snapshot after verify runs
      // will reflect the real result.
      const effectiveOk =
        a.outcome === "ok" && a.verified !== "failed";
      if (effectiveOk) b.successes += 1;
      else b.failures += 1;
      // `actions` is append-only oldest-first, so the last write wins.
      b.lastOutcome = effectiveOk ? "ok" : "failed";
      b.lastAt = a.at;
      map.set(key, b);
    }
    return [...map.values()]
      .map((b) => {
        const successRatePct =
          b.attempts === 0
            ? 0
            : Math.round((b.successes / b.attempts) * 1000) / 10;
        const downgrading =
          b.attempts >= MIN_LEARNING_ATTEMPTS &&
          successRatePct < LEARNING_DOWNGRADE_BELOW;
        return { ...b, successRatePct, downgrading };
      })
      .sort((a, b) => b.attempts - a.attempts);
  }

  /** Apply the learning loop to one proposal's confidence. If the
   *  brain has tried this (agent, kind) at least MIN_LEARNING_ATTEMPTS
   *  times and the success rate is under LEARNING_DOWNGRADE_BELOW, walk
   *  the proposed confidence down one notch — that's what makes the
   *  brain stop re-firing a broken action. */
  private effectiveConfidence(
    p: Proposal,
    learnings: LearningRecord[],
  ): Confidence {
    const learning = learnings.find(
      (l) => l.agent === p.agent && l.kind === p.kind,
    );
    if (!learning || !learning.downgrading) return p.confidence;
    return downgradeConfidence(p.confidence);
  }

  /** Serialisable snapshot — what `GET /v1/agents/status` returns. */
  snapshot(): BrainSnapshot {
    const stats: Record<AgentName, { observations: number; actions: number }> =
      {
        uptime: { observations: 0, actions: 0 },
        deploy: { observations: 0, actions: 0 },
        cost: { observations: 0, actions: 0 },
        scale: { observations: 0, actions: 0 },
        security: { observations: 0, actions: 0 },
        capacity: { observations: 0, actions: 0 },
        mail: { observations: 0, actions: 0 },
        sms: { observations: 0, actions: 0 },
        automation: { observations: 0, actions: 0 },
      };
    for (const o of this.observations) stats[o.agent].observations++;
    for (const a of this.actions) stats[a.agent].actions++;

    const stripExecute = (p: Proposal): Omit<Proposal, "execute"> => ({
      id: p.id,
      at: p.at,
      agent: p.agent,
      kind: p.kind,
      title: p.title,
      body: p.body,
      confidence: p.confidence,
      actionClass: p.actionClass,
      projectId: p.projectId,
      hints: p.hints,
    });

    return {
      at: now(),
      paused: this.paused,
      observations: this.observations.slice().reverse(),
      pendingProposals: this.pending.map(stripExecute),
      recentActions: this.actions.slice().reverse(),
      agentStats: stats,
      learnings: this.buildLearnings(),
    };
  }
}
