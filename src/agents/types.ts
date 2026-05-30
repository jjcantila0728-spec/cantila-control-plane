/* ============================================================
   Cantila Agents — types (plan §4.9).
   The brain holds these; each agent emits them.
   ============================================================ */

import type { ControlPlane } from "../core/control-plane";

export type AgentName =
  | "uptime"
  | "deploy"
  | "cost"
  | "scale"
  | "security"
  | "capacity"
  | "mail"
  | "sms"
  | "automation"
  | "seo"
  | "remediation";

export type ActionClass = "safe" | "destructive";
export type Confidence = "high" | "medium" | "low";

/** A signal an agent observed about the world. Append-only — the brain's
 *  long-term memory is built out of these. */
export interface Observation {
  at: string;
  agent: AgentName;
  kind: string;
  detail: string;
  projectId?: string;
}

/** An action an agent thinks the brain should take. Carries an `execute`
 *  closure the brain runs when it decides to act. The closure is dropped
 *  before the snapshot is serialised. */
export interface Proposal {
  id: string;
  at: string;
  agent: AgentName;
  /** Short slug naming the *shape* of this proposal — every UptimeAgent
   *  rollback shares kind `auto_rollback`, every Cost idle-alwayson shares
   *  `idle_alwayson`, etc. The brain groups outcomes by `(agent, kind)`
   *  so the learning loop can spot a class of action that keeps failing
   *  and downgrade its effective confidence (plan §4.9 — continuous
   *  learning). Distinct from `id`, which is unique per proposal. */
  kind: string;
  title: string;
  body: string;
  confidence: Confidence;
  actionClass: ActionClass;
  projectId?: string;
  /** Optional CLI commands a human could run instead of waiting for the brain. */
  hints?: { label: string; hint: string }[];
  /** Run by the brain when the proposal is auto-applied. */
  execute: (cp: ControlPlane) => Promise<{ ok: boolean; detail: string }>;
  /** Optional post-check (plan §4.9 — "Populated by post-checks"). After
   *  `execute` returns ok, the brain schedules `verify` after
   *  `verifyDelayMs` (default 30s) and updates the action's `verified`
   *  field with the result. The learning loop then counts a `verified:
   *  "failed"` as a failure even though the execute closure said ok —
   *  this is what catches "the API call succeeded but the world reverted"
   *  cases (e.g. rollback ran but the project crashed again). */
  verify?: (cp: ControlPlane) => Promise<{ verified: boolean; detail: string }>;
  /** Milliseconds to wait between execute and verify. Defaults to 30_000
   *  when omitted. Short for quick config-revert checks, long for "did
   *  the system actually heal" checks. */
  verifyDelayMs?: number;
}

/** Whether the brain has confirmed an action's intended effect held.
 *  - "n/a"     — the proposal carried no `verify` closure; trust outcome.
 *  - "pending" — execute succeeded; verify is scheduled but hasn't run.
 *  - "ok"      — verify ran and confirmed the world changed as intended.
 *  - "failed"  — verify ran and the change did not hold. This overrides
 *                `outcome: "ok"` for the learning loop's success math. */
export type ActionVerified = "n/a" | "pending" | "ok" | "failed";

/** Every action the brain has actually taken, success or failure. */
export interface ActionRecord {
  at: string;
  proposalId: string;
  agent: AgentName;
  /** Mirrors the proposal's kind so the action journal can be grouped
   *  the same way the learnings map is. */
  kind: string;
  title: string;
  outcome: "ok" | "failed";
  detail: string;
  /** Post-check state for this action (plan §4.9). The learning loop
   *  treats `verified: "failed"` as a failure even when `outcome: "ok"`. */
  verified: ActionVerified;
  /** When `verified` last transitioned out of "pending". Absent until
   *  the verifier runs. */
  verifiedAt?: string;
  /** Human-readable note from the verifier — e.g. "project was live
   *  for 28s after rollback" or "project crashed again 4s after rollback". */
  verifyDetail?: string;
  /** Track what the action did so the brain can learn — e.g. "rolled-back
   *  to dpl_X, project returned to live in 12s". Populated by post-checks. */
  resultProjectId?: string;
}

/** Per (agent, kind) rollup of what the brain has tried and how it went.
 *  Built from the action journal on each snapshot; used by the decision
 *  policy to downgrade confidence on a kind that's failed repeatedly. */
export interface LearningRecord {
  agent: AgentName;
  kind: string;
  attempts: number;
  successes: number;
  failures: number;
  /** 0–100, rounded to 1 decimal place. */
  successRatePct: number;
  /** Last action's outcome — gives the Console a small "last result" hint
   *  without serialising the whole journal. */
  lastOutcome: "ok" | "failed";
  lastAt: string;
  /** Whether the policy is currently downgrading auto-apply decisions for
   *  this kind. True when `attempts ≥ MIN_LEARNING_ATTEMPTS` and
   *  `successRatePct < LEARNING_DOWNGRADE_BELOW`. */
  downgrading: boolean;
}

/** The serialisable view exposed via `/v1/agents/status`. */
export interface BrainSnapshot {
  at: string;
  paused: boolean;
  /** Most recent observations, newest first. */
  observations: Observation[];
  /** Proposals the brain has not acted on yet (or chose not to auto-apply). */
  pendingProposals: Array<Omit<Proposal, "execute">>;
  /** Actions the brain has taken, newest first. */
  recentActions: ActionRecord[];
  /** Coarse stats — agent-by-agent. */
  agentStats: Record<AgentName, { observations: number; actions: number }>;
  /** What the brain has learned from action outcomes. Sorted by `attempts`
   *  descending so the kinds it knows most about are at the top. */
  learnings: LearningRecord[];
}

/** What every agent implements. */
export interface Agent {
  name: AgentName;
  observe(cp: ControlPlane): Promise<Observation[]>;
  propose(cp: ControlPlane): Promise<Proposal[]>;
}
