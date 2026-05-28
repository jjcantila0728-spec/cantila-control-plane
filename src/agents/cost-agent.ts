/* ============================================================
   CostAgent — surfaces right-sizing recommendations.
   Wraps the existing cost-optimisation analyser. Low-confidence
   recommendations stay pending (let the user decide); only the
   safe-class clean-ups (drop empty bucket, set auto-sleep) get
   auto-applied — and even those only at "high" confidence.

   Current heuristic mapping → brain confidence:
     idle_alwayson   → high  (safe   — toggle auto-sleep)
     unused_bucket   → medium (safe  — drop empty bucket; review-only)
     oversized_ram   → medium (destructive — wait for human)
     oversized_cpu   → medium (destructive)
     oversized_disk  → low    (destructive)
     stale_project   → low    (destructive — never auto)
     unused_domain   → low    (destructive)
   ============================================================ */

import type { ControlPlane } from "../core/control-plane";
import { id as makeId, now } from "../lib/ids";
import type { Agent, ActionClass, Confidence, Observation, Proposal } from "./types";

const ACCOUNT = "acc_demo";

const KIND_POLICY: Record<
  string,
  { confidence: Confidence; actionClass: ActionClass }
> = {
  idle_alwayson: { confidence: "high", actionClass: "safe" },
  unused_bucket: { confidence: "medium", actionClass: "safe" },
  oversized_ram: { confidence: "medium", actionClass: "destructive" },
  oversized_cpu: { confidence: "medium", actionClass: "destructive" },
  oversized_disk: { confidence: "low", actionClass: "destructive" },
  stale_project: { confidence: "low", actionClass: "destructive" },
  unused_domain: { confidence: "low", actionClass: "destructive" },
};

export class CostAgent implements Agent {
  readonly name = "cost" as const;

  async observe(cp: ControlPlane): Promise<Observation[]> {
    const report = await cp.getCostOptimisation(ACCOUNT);
    return report.recommendations.map((r) => ({
      at: now(),
      agent: this.name,
      kind: r.kind,
      detail: r.title,
      projectId: r.projectId,
    }));
  }

  async propose(cp: ControlPlane): Promise<Proposal[]> {
    const report = await cp.getCostOptimisation(ACCOUNT);
    const out: Proposal[] = [];
    for (const r of report.recommendations) {
      const policy =
        KIND_POLICY[r.kind] ??
        ({ confidence: "low", actionClass: "destructive" } as const);

      // Build the execute closure based on the recommendation kind. Only
      // the two safe kinds carry a real action.
      let execute: Proposal["execute"];
      // Optional post-check — populated for the safe auto-apply kinds so
      // the learning loop sees a real "did the change hold" signal, not
      // just "the API call returned ok" (plan §4.9 — post-checks).
      let verify: Proposal["verify"] | undefined;
      let verifyDelayMs: number | undefined;
      if (r.kind === "idle_alwayson" && r.projectId) {
        const pid = r.projectId;
        execute = async (controlPlane) => {
          const result = await controlPlane.scale(pid, { alwaysOn: false });
          if (!result) return { ok: false, detail: "project not found" };
          if ("error" in result) return { ok: false, detail: result.error };
          return { ok: true, detail: `${result.slug}: alwaysOn → false` };
        };
        // 5s is enough to catch a fast revert (a concurrent deploy flipping
        // alwaysOn back on, an external config sync overwriting it). The
        // verifier asks: is this project STILL the way I left it?
        verifyDelayMs = 5_000;
        verify = async (controlPlane) => {
          const project = await controlPlane.getProject(pid);
          if (!project) {
            return { verified: false, detail: "project no longer exists" };
          }
          if (!project.alwaysOn) {
            return {
              verified: true,
              detail: `${project.slug} alwaysOn held at false`,
            };
          }
          return {
            verified: false,
            detail: `${project.slug} alwaysOn reverted to true within 5s`,
          };
        };
      } else if (r.kind === "unused_bucket") {
        // Bucket id is encoded in the recommendation's id as `bucket_<id>`.
        const bucketId = r.id.replace(/^bucket_/, "");
        execute = async (controlPlane) => {
          const ok = await controlPlane.deleteBucket(bucketId);
          return ok
            ? { ok: true, detail: `Dropped empty bucket ${bucketId}` }
            : { ok: false, detail: `Bucket ${bucketId} could not be removed` };
        };
      } else {
        execute = async () => ({
          ok: true,
          detail: "Acknowledged — destructive action requires confirmation.",
        });
      }

      out.push({
        id: `prop_${makeId("co").slice(3)}_${r.id}`,
        at: now(),
        agent: this.name,
        // The recommendation kind (e.g. `idle_alwayson`, `unused_bucket`,
        // `oversized_ram`) IS the proposal kind — every right-sizing
        // suggestion of the same shape shares a learning bucket.
        kind: r.kind,
        title: r.title,
        body: `${r.body} Est. savings ~$${(r.savingsCentsPerMonth / 100).toFixed(2)} / month.`,
        confidence: policy.confidence,
        actionClass: policy.actionClass,
        projectId: r.projectId,
        hints: r.actions?.map((a) => ({ label: a.label, hint: a.hint })),
        execute,
        verify,
        verifyDelayMs,
      });
    }
    return out;
  }
}
