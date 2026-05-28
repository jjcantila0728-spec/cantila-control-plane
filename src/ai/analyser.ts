/* ============================================================
   AI analyser port (plan §5.6, §15.2 — "AI v2: LLM swap-in").

   The control plane talks to `AiAnalyser` and never to an LLM SDK
   directly. The bundled `RuleBasedAiAnalyser` carries the existing
   pattern-matching logic that shipped behind `troubleshootDeploy`
   and `getCostOptimisation`; a future `ClaudeAiAnalyser` (gated on
   `ANTHROPIC_API_KEY`) implements the same interface with real
   model calls. Same swap-shape as `StripeAdapter`.

   Inputs are pre-gathered facts: the CP already knows how to read
   projects, deployments, buckets and registrations. The analyser
   takes those as input and returns the structured `Suggestion` /
   `Recommendation` types the Console already renders. Outputs flow
   back through the existing `TroubleshootResult` /
   `CostOptimisationReport` shapes unchanged.
   ============================================================ */

import type {
  CostRecommendation,
  TroubleshootSuggestion,
} from "../core/control-plane";
import type {
  Deployment,
  DomainRegistration,
  Project,
  StorageBucket,
} from "../domain/types";

/* ---------- inputs ---------- */

export interface AnalyseDeployInput {
  project: Project;
  /** The deployment being troubleshot. */
  deployment: Deployment;
  /** Sibling deployments on the same project — used to find a viable
   *  rollback target. */
  allDeployments: Deployment[];
}

export interface AnalyseCostInput {
  accountId: string;
  projects: Project[];
  /** Every deployment for every project in `projects`. */
  allDeployments: Deployment[];
  buckets: StorageBucket[];
  registrations: DomainRegistration[];
}

/* ---------- port ---------- */

export interface AiAnalyser {
  /** Display label — `"rule-based"` for the bundled stub, `"Claude"`
   *  for the future LLM adapter. Surfaced on `GET /v1/ai/info`. */
  readonly label: string;
  /** Whether the adapter actually calls an LLM. `false` for the
   *  rule-based analyser. */
  readonly live: boolean;

  analyseDeploy(input: AnalyseDeployInput): Promise<TroubleshootSuggestion[]>;
  analyseCost(input: AnalyseCostInput): Promise<CostRecommendation[]>;
}

/* ---------- the rule-based default ---------- */

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export class RuleBasedAiAnalyser implements AiAnalyser {
  readonly label = "rule-based";
  readonly live = false;

  async analyseDeploy(
    input: AnalyseDeployInput,
  ): Promise<TroubleshootSuggestion[]> {
    const { project, deployment, allDeployments } = input;
    const failed = deployment.status === "failed";
    const lastStep = deployment.logs[deployment.logs.length - 1];
    const has = (needle: string) =>
      deployment.logs.some((l) => l.includes(needle));
    const suggestions: TroubleshootSuggestion[] = [];

    if (failed) {
      if (lastStep === "verify-failed") {
        suggestions.push({
          confidence: "high",
          title: "Health check timed out",
          body: `The container started but didn't return a healthy response within the verify window. The most common cause is the app not binding to the port Cantila injects as $PORT — apps should bind to 0.0.0.0:$PORT.`,
          actions: [
            { label: "Bind to PORT", hint: "app.listen(process.env.PORT || 3000, '0.0.0.0')" },
            { label: "Roll back", hint: `cantila rollback ${project.id} <previous-deployment-id>` },
            { label: "Check logs", hint: `cantila logs ${project.id}` },
          ],
        });
      } else if (lastStep && lastStep.startsWith("scheduled:")) {
        suggestions.push({
          confidence: "high",
          title: "Container failed to start",
          body: `Cantila scheduled the build onto ${lastStep.slice("scheduled:".length)} but the container exited before it could route traffic. Usually a missing dependency, a bad entrypoint, or an environment variable referenced at boot that isn't set.`,
          actions: [
            { label: "Inspect the build", hint: `cantila logs ${project.id}` },
            { label: "Check env", hint: `cantila env ${project.id}` },
          ],
        });
      } else if (lastStep === "image-built") {
        suggestions.push({
          confidence: "medium",
          title: "Build succeeded but scheduling stalled",
          body: `Image push completed but no node was available to schedule onto. The fleet may be saturated for the region.`,
          actions: [
            { label: "Try another region", hint: `cantila scale ${project.id} --region hel1` },
          ],
        });
      } else if (lastStep && lastStep.startsWith("stack-detected:")) {
        suggestions.push({
          confidence: "high",
          title: "Build failed during stack analysis",
          body: `Cantila detected the runtime as ${lastStep.slice("stack-detected:".length)} but the build couldn't proceed — likely a missing Dockerfile / lockfile, or a syntax error in the build config.`,
        });
      } else {
        suggestions.push({
          confidence: "medium",
          title: "Deploy did not complete",
          body: `Pipeline stopped after ${lastStep ?? "an unknown step"}. Review the full step trace below for the failing operation.`,
        });
      }

      const previousLive = allDeployments
        .filter((d) => d.id !== deployment.id && d.status === "live")
        .pop();
      if (previousLive) {
        suggestions.push({
          confidence: "high",
          title: "Roll back while you investigate",
          body: `Previous successful deployment ${previousLive.id} is one click away. Rollback reuses the prior image — no rebuild needed.`,
          actions: [
            { label: "Roll back", hint: `cantila rollback ${project.id} ${previousLive.id}` },
          ],
        });
      }
    } else {
      if (has("services-provisioned:0-env-injected")) {
        suggestions.push({
          confidence: "low",
          title: "Services already wired — no fresh env injected",
          body: "This was a redeploy of an existing project; the database, mailbox and SMS number from the first deploy were re-used.",
        });
      }
      if (deployment.logs.some((l) => l.startsWith("rollback-to:"))) {
        const ref = deployment.logs
          .find((l) => l.startsWith("rollback-to:"))
          ?.slice("rollback-to:".length);
        suggestions.push({
          confidence: "low",
          title: "This deployment is a rollback",
          body: `It replays a prior deployment (${ref}) — no rebuild was performed.`,
        });
      }
      if (suggestions.length === 0) {
        suggestions.push({
          confidence: "low",
          title: "Deploy looks healthy",
          body: "No anomalies detected in the pipeline trace.",
        });
      }
    }
    return suggestions;
  }

  async analyseCost(input: AnalyseCostInput): Promise<CostRecommendation[]> {
    const { projects, allDeployments, buckets, registrations } = input;
    const recommendations: CostRecommendation[] = [];
    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    for (const p of projects) {
      const projectDeploys = allDeployments.filter((d) => d.projectId === p.id);
      const lastDeployAt = projectDeploys.reduce(
        (latest, d) => (d.createdAt > latest ? d.createdAt : latest),
        "",
      );
      const lastDeployMs = lastDeployAt
        ? new Date(lastDeployAt).getTime()
        : new Date(p.createdAt).getTime();
      const daysSinceDeploy = Math.floor((nowMs - lastDeployMs) / dayMs);

      if (p.alwaysOn && daysSinceDeploy >= 14) {
        recommendations.push({
          id: `idle_always_${p.id}`,
          kind: "idle_alwayson",
          projectId: p.id,
          projectName: p.name,
          confidence: "high",
          title: `${p.name} is pinned always-on but idle for ${daysSinceDeploy}d`,
          body: `No deploys in two weeks. Switching to auto-sleep frees the slot when nobody's calling it — Cantila wakes it on the next request.`,
          savingsCentsPerMonth: 1500,
          actions: [
            { label: "Auto-sleep", hint: `cantila scale ${p.id} --auto-sleep` },
          ],
        });
      }

      if (p.memoryMb >= 2048 && projects.length <= 1) {
        recommendations.push({
          id: `ram_${p.id}`,
          kind: "oversized_ram",
          projectId: p.id,
          projectName: p.name,
          confidence: "medium",
          title: `${p.name} has ${p.memoryMb} MB RAM`,
          body: `Solo projects of this scale rarely use more than 1 GB. Step down to 1024 MB and resize if the request rate ever pushes back.`,
          savingsCentsPerMonth: 600,
          actions: [
            { label: "Resize", hint: `cantila scale ${p.id} --memory 1024` },
          ],
        });
      }

      if (p.vcpu > 2 && daysSinceDeploy >= 14) {
        recommendations.push({
          id: `cpu_${p.id}`,
          kind: "oversized_cpu",
          projectId: p.id,
          projectName: p.name,
          confidence: "medium",
          title: `${p.name} has ${p.vcpu} vCPUs but is quiet`,
          body: `Step down to 1 vCPU; resize when traffic returns.`,
          savingsCentsPerMonth: 900,
          actions: [{ label: "Resize", hint: `cantila scale ${p.id} --vcpu 1` }],
        });
      }

      const projectBuckets = buckets.filter((b) => b.projectId === p.id);
      if (p.diskGb > 5 && projectBuckets.length === 0) {
        recommendations.push({
          id: `disk_${p.id}`,
          kind: "oversized_disk",
          projectId: p.id,
          projectName: p.name,
          confidence: "low",
          title: `${p.name} has ${p.diskGb} GB disk and no storage buckets`,
          body: `Disk usage tends to grow into storage buckets first. Step down to 5 GB and rely on a bucket if persistent state is needed.`,
          savingsCentsPerMonth: 200,
          actions: [{ label: "Resize", hint: `cantila scale ${p.id} --disk 5` }],
        });
      }

      if (daysSinceDeploy >= 30) {
        recommendations.push({
          id: `stale_${p.id}`,
          kind: "stale_project",
          projectId: p.id,
          projectName: p.name,
          confidence: "low",
          title: `${p.name} has had no deploys for ${daysSinceDeploy}d`,
          body: `Archive candidate — keep the data but free the slot and the auto-wired services.`,
          savingsCentsPerMonth: 800,
        });
      }
    }

    for (const b of buckets) {
      if (b.objects === 0 && b.sizeGb === 0) {
        recommendations.push({
          id: `bucket_${b.id}`,
          kind: "unused_bucket",
          confidence: "medium",
          title: `Bucket "${b.name}" is empty`,
          body: `Zero objects and zero bytes — drop the bucket if it's not in use yet.`,
          savingsCentsPerMonth: 100,
          actions: [{ label: "Drop", hint: `cantila storage delete ${b.id}` }],
        });
      }
    }

    for (const r of registrations) {
      if (!r.attachedProjectId) {
        recommendations.push({
          id: `domain_${r.id}`,
          kind: "unused_domain",
          confidence: "low",
          title: `${r.hostname} not attached to a project`,
          body: `You're paying ${formatUsd(r.pricePerYearCents)} / year for this domain — attach it to a project or release it on the renewal date (${r.expiresAt.slice(0, 10)}).`,
          savingsCentsPerMonth: Math.round(r.pricePerYearCents / 12),
        });
      }
    }

    return recommendations;
  }
}
