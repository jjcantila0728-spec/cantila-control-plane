/* ============================================================
   UptimeAgent — keeps the fleet alive.
   Watches for crashed projects and auto-rolls back to the most
   recent live deployment when one exists. Confidence is "high"
   and the action class is "safe", so the brain will auto-apply.
   ============================================================ */

import type { ControlPlane } from "../core/control-plane";
import { id as makeId, now } from "../lib/ids";
import type { Agent, Observation, Proposal } from "./types";
import { ownerAccountId } from "../lib/owner-account";

const ACCOUNT = ownerAccountId();

export class UptimeAgent implements Agent {
  readonly name = "uptime" as const;

  async observe(cp: ControlPlane): Promise<Observation[]> {
    const projects = await cp.listProjects(ACCOUNT);
    return projects
      .filter((p) => p.status === "crashed" || p.status === "paused")
      .map((p) => ({
        at: now(),
        agent: this.name,
        kind: p.status === "crashed" ? "project_crashed" : "project_paused",
        detail: `${p.name} is ${p.status}`,
        projectId: p.id,
      }));
  }

  async propose(cp: ControlPlane): Promise<Proposal[]> {
    const projects = await cp.listProjects(ACCOUNT);
    const out: Proposal[] = [];
    for (const project of projects) {
      if (project.status !== "crashed") continue;
      const deploys = await cp.listProjectDeployments(project.id);
      // Pick the most recent successful deployment to roll back to.
      const previousLive = deploys
        .slice()
        .reverse()
        .find((d) => d.status === "live");
      if (!previousLive) continue;
      out.push({
        id: `prop_${makeId("rb").slice(3)}_${project.id}`,
        at: now(),
        agent: this.name,
        kind: "auto_rollback",
        title: `Auto-rollback ${project.name} → ${previousLive.id}`,
        body: `Project is crashed; the previous live deployment is one click away. The brain will reuse its image — no rebuild needed.`,
        confidence: "high",
        actionClass: "safe",
        projectId: project.id,
        hints: [
          {
            label: "Manual",
            hint: `cantila rollback ${project.id} ${previousLive.id}`,
          },
        ],
        execute: async (controlPlane) => {
          const result = await controlPlane.rollback(
            project.id,
            previousLive.id,
          );
          if ("error" in result) {
            return { ok: false, detail: result.error };
          }
          return {
            ok: true,
            detail: `Rolled back to ${previousLive.id} (new deployment ${result.id})`,
          };
        },
        // Post-check: 30s after the rollback runs, confirm the project is
        // actually back to `live`. A rollback can return ok (API call
        // succeeded, container started) but the rolled-back deployment
        // may also crash — that's the case the learning loop needs to
        // catch and count as a real failure.
        verifyDelayMs: 30_000,
        verify: async (controlPlane) => {
          const detail = await controlPlane.getProjectDetail(project.id);
          if (!detail) {
            return { verified: false, detail: "project no longer exists" };
          }
          const status = detail.project.status;
          if (status === "live") {
            return {
              verified: true,
              detail: `Project returned to live within 30s of rollback`,
            };
          }
          return {
            verified: false,
            detail: `Project still ${status} 30s after rollback`,
          };
        },
      });
    }
    return out;
  }
}
