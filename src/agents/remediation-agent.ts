import type { ControlPlane } from "../core/control-plane";
import { now } from "../lib/ids";
import type { Agent, Observation, Proposal } from "./types";
import { ownerAccountId } from "../lib/owner-account";
import type { DeploymentLike, RemediationResult } from "../fleet/remediation";

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Minimal remediator surface (the real one is fleet/remediation.ClaudeRemediator). */
export interface Remediator {
  remediate(input: { projectId: string; deployment: DeploymentLike }): Promise<RemediationResult>;
}

export interface RemediationAgentDeps {
  remediator: Remediator;
  /** Owner account to scan. Defaults to ownerAccountId(). */
  accountId?: string;
}

export class RemediationAgent implements Agent {
  readonly name = "remediation" as const;
  private readonly account: string;
  /** Deployment ids already remediated this process — prevents re-proposing
   *  (and re-running an expensive session) for the same failure each tick. */
  private addressed = new Set<string>();

  constructor(private deps: RemediationAgentDeps) {
    this.account = deps.accountId ?? ownerAccountId();
  }

  private async recentFailures(cp: ControlPlane): Promise<Array<{ projectId: string; projectName: string; deployment: DeploymentLike }>> {
    const projects = await cp.listProjects(this.account);
    const since = Date.now() - RECENT_WINDOW_MS;
    const out: Array<{ projectId: string; projectName: string; deployment: DeploymentLike }> = [];
    for (const project of projects) {
      const deploys = (await cp.listProjectDeployments(project.id)) as unknown as DeploymentLike[];
      const lastFailed = deploys
        .slice().reverse()
        .find((d) => d.status === "failed" && new Date(d.createdAt).getTime() >= since);
      if (lastFailed) out.push({ projectId: project.id, projectName: project.name, deployment: lastFailed });
    }
    return out;
  }

  async observe(cp: ControlPlane): Promise<Observation[]> {
    const fails = await this.recentFailures(cp);
    return fails.map((f) => ({
      at: now(),
      agent: this.name,
      kind: "deploy_failed_remediation",
      detail: `${f.projectName} · deployment ${f.deployment.id} failed — remediation candidate`,
      projectId: f.projectId,
    }));
  }

  async propose(cp: ControlPlane): Promise<Proposal[]> {
    const fails = await this.recentFailures(cp);
    const out: Proposal[] = [];
    for (const f of fails) {
      if (this.addressed.has(f.deployment.id)) continue;
      this.addressed.add(f.deployment.id);
      const deployment = f.deployment;
      const projectId = f.projectId;
      out.push({
        id: `prop_remediate_${deployment.id}`,
        at: now(),
        agent: this.name,
        kind: "claude_code_fix",
        title: `${f.projectName}: auto-diagnose + prepare a fix`,
        body: `Deployment ${deployment.id} failed. A bounded Claude Code session will diagnose the logs, fix the project workspace, and confirm it builds. The fix is prepared only — redeploying stays a separate, human-approved step.`,
        confidence: "high",
        actionClass: "safe",
        projectId,
        hints: [{ label: "Inspect", hint: `cantila troubleshoot ${projectId} ${deployment.id}` }],
        execute: async (_cp: ControlPlane) => {
          const r = await this.deps.remediator.remediate({ projectId, deployment });
          return { ok: r.ok, detail: r.detail };
        },
      });
    }
    return out;
  }
}
