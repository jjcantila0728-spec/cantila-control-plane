import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { OrchestratorEvent } from "../agents/project-orchestrator";
import type { GitProvider } from "../git/provider";
import type { RepoRef } from "../git/types";
import { gitProviderFor, repoRefFor } from "../git/resolve";

export interface BridgeResult {
  deployed: boolean;
  detail: string;
  repoUrl?: string;
  liveUrl?: string;
}

export interface BridgeCp {
  ensureProjectRepo(projectId: string): Promise<any | null>;
  getAccount(accountId: string): Promise<any | null>;
  deploy(projectId: string, opts: { trigger: any; source: { kind: "git"; ref?: string } }): Promise<any>;
}

export interface DeployBridgeDeps {
  cp: BridgeCp;
  providerFor?: (project: any) => GitProvider;
  repoRef?: (project: any, account: any) => RepoRef;
  walk?: (dir: string) => Promise<{ path: string; content: string }[]>;
}

async function defaultWalk(dir: string): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  async function rec(d: string) {
    let entries: any[];
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.name === ".git" || e.name === "node_modules") continue;
      if (e.isDirectory()) await rec(abs);
      else {
        const s = await stat(abs);
        if (s.size > 512 * 1024) continue;
        out.push({ path: path.relative(dir, abs).split(path.sep).join("/"), content: await readFile(abs, "utf8") });
      }
    }
  }
  await rec(dir);
  return out;
}

export class DeployBridge {
  constructor(private deps: DeployBridgeDeps) {}

  async publish(input: { projectId: string; workspaceDir: string; onEvent: (e: OrchestratorEvent) => void }): Promise<BridgeResult> {
    const { cp } = this.deps;
    const providerFor = this.deps.providerFor ?? (gitProviderFor as any);
    const repoRef = this.deps.repoRef ?? (repoRefFor as any);
    const walk = this.deps.walk ?? defaultWalk;
    try {
      const project = await cp.ensureProjectRepo(input.projectId);
      if (!project) return { deployed: false, detail: "project not found" };
      if (!project.repoUrl) return { deployed: false, detail: "git backend offline — project left repo-less; not deploying" };

      const account = await cp.getAccount(project.accountId);
      const provider = providerFor(project);
      const ref = repoRef(project, account);
      const branch = project.branch ?? "main";

      input.onEvent({ kind: "op_started", opKey: `deploy:${input.projectId}`, agent: "orchestrator", title: `Publishing to ${project.repoUrl}` });

      // Ensure the repo exists before writing (idempotent — returns existing repo if present)
      await provider.createRepo({ owner: ref.owner, name: ref.repo, private: true });

      const files = await walk(input.workspaceDir);
      for (const f of files) {
        await provider.writeFile(ref, { path: f.path, content: f.content, branch, message: "fleet build" });
      }
      await cp.deploy(input.projectId, { trigger: "git", source: { kind: "git", ref: branch } });
      const liveUrl = `https://${project.slug}.cantila.app`;
      input.onEvent({ kind: "op_finished", opKey: `deploy:${input.projectId}`, agent: "orchestrator", title: `Deployed ${files.length} file(s)`, status: "ok", detail: liveUrl });
      input.onEvent({ kind: "result", name: project.slug, url: liveUrl, stack: "git · Coolify" });
      return { deployed: true, detail: `published ${files.length} file(s) + deploy queued`, repoUrl: project.repoUrl, liveUrl };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "deploy bridge failed";
      input.onEvent({ kind: "op_finished", opKey: `deploy:${input.projectId}`, agent: "orchestrator", title: "Auto-deploy failed", status: "failed", detail });
      return { deployed: false, detail };
    }
  }
}
