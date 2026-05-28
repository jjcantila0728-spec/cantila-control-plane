/* ============================================================
   DeployAgent — surfaces failed deployments.
   Confidence is "high" but action class is left at "destructive"
   for now (we don't auto-trigger a fresh build), so the brain
   queues these for human review and the user sees them as a
   pending proposal with troubleshooting hints attached.
   ============================================================ */

import type { ControlPlane } from "../core/control-plane";
import { id as makeId, now } from "../lib/ids";
import type { Agent, Observation, Proposal } from "./types";

const ACCOUNT = "acc_demo";
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export class DeployAgent implements Agent {
  readonly name = "deploy" as const;

  async observe(cp: ControlPlane): Promise<Observation[]> {
    const projects = await cp.listProjects(ACCOUNT);
    const out: Observation[] = [];
    const since = Date.now() - RECENT_WINDOW_MS;
    for (const project of projects) {
      const deploys = await cp.listProjectDeployments(project.id);
      const recentFailures = deploys.filter(
        (d) =>
          d.status === "failed" &&
          new Date(d.createdAt).getTime() >= since,
      );
      for (const f of recentFailures) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "deploy_failed",
          detail: `${project.name} · deployment ${f.id} failed (${f.logs.slice(-1)[0] ?? "no logs"})`,
          projectId: project.id,
        });
      }
    }
    return out;
  }

  async propose(cp: ControlPlane): Promise<Proposal[]> {
    const projects = await cp.listProjects(ACCOUNT);
    const out: Proposal[] = [];
    const since = Date.now() - RECENT_WINDOW_MS;
    for (const project of projects) {
      const deploys = await cp.listProjectDeployments(project.id);
      // We surface the most recent failed deploy per project — once it's
      // rolled back or redeployed, the proposal naturally goes away on the
      // next tick because the brain rebuilds `pending` from scratch.
      const lastFailed = deploys
        .slice()
        .reverse()
        .find(
          (d) =>
            d.status === "failed" &&
            new Date(d.createdAt).getTime() >= since,
        );
      if (!lastFailed) continue;

      // If a rollback target exists, hint at it.
      const previousLive = deploys
        .slice()
        .reverse()
        .find(
          (d) => d.status === "live" && d.createdAt < lastFailed.createdAt,
        );
      const hints: Proposal["hints"] = [
        {
          label: "Inspect",
          hint: `cantila troubleshoot ${project.id} ${lastFailed.id}`,
        },
      ];
      if (previousLive) {
        hints.push({
          label: "Rollback",
          hint: `cantila rollback ${project.id} ${previousLive.id}`,
        });
      }

      out.push({
        id: `prop_${makeId("dp").slice(3)}_${lastFailed.id}`,
        at: now(),
        agent: this.name,
        kind: "failed_deploy_review",
        title: `${project.name} last deploy failed`,
        body: `Deployment ${lastFailed.id} stopped at "${lastFailed.logs.slice(-1)[0] ?? "(unknown)"}". The Uptime agent will auto-rollback when the project flips to crashed; until then this stays as a review item.`,
        confidence: "high",
        actionClass: "destructive",
        projectId: project.id,
        hints,
        // Destructive class → never auto-applied, but the brain still needs
        // an execute closure for human-confirmed flows. We use a no-op that
        // simply records the operator's choice to acknowledge.
        execute: async () => ({
          ok: true,
          detail: "Acknowledged — no auto-action taken (destructive class).",
        }),
      });
    }
    return out;
  }
}
