/* ============================================================
   Chat-Deploy success instrumentation (plan: top-tier program #8).

   Two pure helpers over the already-persisted Deployment records — no new
   table, no migration. `classifyFailure` buckets a failed deploy by the stage
   that broke (read from the pipeline step trace); `summariseDeploys` rolls a
   set of deployments into a success rate + failure breakdown so the console
   dashboard and operators can see WHERE Chat Deploy loses users.
   ============================================================ */

import type { Deployment } from "../domain/types";

/** Coarse failure bucket derived from a deploy's ordered step trace
 *  (e.g. "build-failed:…", "verify-failed:…", "migrate-failed"). Order
 *  matters: earlier pipeline stages win so a build failure isn't mislabelled
 *  as a health failure. */
export function classifyFailure(steps: readonly string[]): string {
  const j = steps.join("\n").toLowerCase();
  if (/build-failed|image builder declined|no buildable|module not found/.test(j))
    return "build_failed";
  if (/migrat|prisma|p2021|p2022/.test(j)) return "migration_failed";
  if (/provision/.test(j)) return "provision_failed";
  if (/verify-failed|did not become healthy|health check|crash/.test(j))
    return "health_check_failed";
  if (/orphan/.test(j)) return "orphaned";
  return "unknown";
}

export interface DeploySummary {
  total: number;
  live: number;
  failed: number;
  /** Success rate over TERMINAL deploys (live+failed), 0..100, one decimal. */
  successRatePct: number;
  /** Failed deploys bucketed by `classifyFailure`. */
  byFailureReason: Record<string, number>;
  /** Per-trigger totals so we can isolate Chat-Deploy (trigger="chat") from
   *  git / api / manual deploys. */
  byTrigger: Record<string, { total: number; live: number }>;
}

export function summariseDeploys(
  deployments: ReadonlyArray<Pick<Deployment, "status" | "trigger" | "logs">>,
): DeploySummary {
  let live = 0;
  let failed = 0;
  const byFailureReason: Record<string, number> = {};
  const byTrigger: Record<string, { total: number; live: number }> = {};
  for (const d of deployments) {
    const isLive = d.status === "live";
    const isFailed = d.status === "failed";
    if (!isLive && !isFailed) continue; // ignore in-flight (queued/running)
    const trig = String(d.trigger ?? "unknown");
    (byTrigger[trig] ??= { total: 0, live: 0 }).total++;
    if (isLive) {
      live++;
      byTrigger[trig].live++;
    } else {
      failed++;
      const reason = classifyFailure(d.logs ?? []);
      byFailureReason[reason] = (byFailureReason[reason] ?? 0) + 1;
    }
  }
  const terminal = live + failed;
  return {
    total: deployments.length,
    live,
    failed,
    successRatePct: terminal === 0 ? 0 : Math.round((live / terminal) * 1000) / 10,
    byFailureReason,
    byTrigger,
  };
}
