/* ============================================================
   AutomationAgent — watches Cantila Automations health (plan §4.9
   + §4.10).

   Reads `cp.getAutomationHealth(account)` — one row per automation
   Project plus the workflow summaries the engine adapter
   (`N8nEngineAdapter` / `OpenClawEngineAdapter` / stub) reports —
   and flags the cases an operator should look at:

     - workflow_failure_high   — a workflow's last run is failed (or
                                 a streak of failures); proposes the
                                 operator open the canvas to debug.
     - automation_unreachable  — the engine adapter cannot list
                                 workflows; signals a connectivity
                                 problem between the control plane
                                 and the engine container.
     - workflow_silence        — an automation Project exists but
                                 has zero workflows (the operator
                                 spun up an instance and never
                                 wired anything).

   Proposals are destructive and ack-only today (the brain doesn't
   yet auto-pause a workflow on its own); they queue for human
   review the same way MailAgent's content-audit proposals do. The
   pattern matches §4.9's safety contract: anything that touches
   third-party data (running or pausing a customer workflow) stays
   operator-driven until the brain's track record on the kind earns
   high confidence.
   ============================================================ */

import type { ControlPlane } from "../core/control-plane";
import { id as makeId, now } from "../lib/ids";
import type { Agent, Observation, Proposal } from "./types";
import { ownerAccountId } from "../lib/owner-account";

const ACCOUNT = ownerAccountId();

export class AutomationAgent implements Agent {
  readonly name = "automation" as const;

  async observe(cp: ControlPlane): Promise<Observation[]> {
    const rows = await cp.getAutomationHealth(ACCOUNT);
    const out: Observation[] = [];
    for (const row of rows) {
      const a = row.automation;
      if (!row.reachable) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "automation_unreachable",
          detail: `${a.automationKind} · ${a.name} (${a.id}) — engine adapter could not list workflows`,
          projectId: a.id,
        });
        continue;
      }
      if (row.workflows.length === 0) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "workflow_silence",
          detail: `${a.automationKind} · ${a.name} (${a.id}) — instance exists but no workflows yet`,
          projectId: a.id,
        });
        continue;
      }
      const failed = row.workflows.filter(
        (w) => w.lastRunStatus === "failed",
      );
      if (failed.length > 0) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "workflow_failure_high",
          detail: `${a.name} (${a.id}) — ${failed.length}/${row.workflows.length} workflow(s) last-ran failed`,
          projectId: a.id,
        });
      }
    }
    return out;
  }

  async propose(cp: ControlPlane): Promise<Proposal[]> {
    const rows = await cp.getAutomationHealth(ACCOUNT);
    const out: Proposal[] = [];
    for (const row of rows) {
      const a = row.automation;
      if (!row.reachable) {
        out.push({
          id: `prop_${makeId("aut").slice(3)}_unreachable_${a.id.slice(-8)}`,
          at: now(),
          agent: this.name,
          kind: "investigate_engine",
          title: `Reach ${a.automationKind ?? "automation"} engine on ${a.name}`,
          body: `The control plane can't list workflows from ${a.name} (${a.id}). Either the engine container hasn't been started yet, or its REST endpoint isn't reachable from here. Confirm the container is running and (for the live adapter) that ${a.automationKind === "n8n" ? "N8N_BASE_URL" : "OPENCLAW_BASE_URL"} points to it.`,
          confidence: "medium",
          actionClass: "destructive",
          hints: [
            {
              label: "Check the engine adapter wiring",
              hint: `curl /v1/automations/info  # shows which adapter is wired per kind`,
            },
          ],
          execute: async () => ({
            ok: true,
            detail:
              "Acknowledged — engine connectivity is operator-driven.",
          }),
        });
        continue;
      }
      const failed = row.workflows.filter((w) => w.lastRunStatus === "failed");
      if (failed.length > 0) {
        out.push({
          id: `prop_${makeId("aut").slice(3)}_failures_${a.id.slice(-8)}`,
          at: now(),
          agent: this.name,
          kind: "audit_workflow",
          title: `Audit ${a.name} — ${failed.length} workflow(s) failing`,
          body: `${a.name} (${a.automationKind}, id ${a.id}) has ${failed.length} workflow(s) whose last run failed: ${failed.map((w) => w.name).join(", ")}. Open the canvas to see which node tripped; the most common causes are an expired connection, a missing required parameter, or a downstream API that started returning 4xx.`,
          confidence: "medium",
          actionClass: "destructive",
          hints: [
            {
              label: "Open the canvas",
              hint: `# Console route\n/automations/${a.id}`,
            },
          ],
          execute: async () => ({
            ok: true,
            detail:
              "Acknowledged — workflow debugging stays in the operator's hands.",
          }),
        });
      }
    }
    return out;
  }
}
