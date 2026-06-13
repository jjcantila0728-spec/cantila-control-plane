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

// Hard ceiling to guard against OOM on a pathological file — NOT a normal-source
// limit. The old 512KB cap silently dropped lockfiles and bundled source, which
// is exactly how a tree ships incomplete and the build dies with "Module not found".
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export async function defaultWalk(dir: string): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  const oversized: string[] = [];
  const binary: string[] = [];
  async function rec(d: string) {
    let entries: any[];
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.name === ".git" || e.name === "node_modules") continue;
      const rel = path.relative(dir, abs).split(path.sep).join("/");
      if (e.isDirectory()) { await rec(abs); continue; }
      const s = await stat(abs);
      if (s.size > MAX_FILE_BYTES) { oversized.push(`${rel} (${Math.round(s.size / 1024 / 1024)}MB)`); continue; }
      const buf = await readFile(abs);
      // The GitProvider.writeFile contract is UTF-8 only (the adapter base64-encodes
      // a utf-8 string), so a binary blob would be silently corrupted. Detect via a
      // NUL byte in the head and skip-with-record rather than mangle it.
      if (buf.subarray(0, 8192).includes(0)) { binary.push(rel); continue; }
      out.push({ path: rel, content: buf.toString("utf8") });
    }
  }
  await rec(dir);
  // Fail loud — never silently ship an incomplete tree.
  if (oversized.length) {
    throw new Error(
      `refusing to deploy: ${oversized.length} file(s) exceed ${MAX_FILE_BYTES / 1024 / 1024}MB and would be dropped: ${oversized.join(", ")}`,
    );
  }
  if (binary.length) {
    console.warn(
      `[deploy-bridge] skipped ${binary.length} binary file(s) (utf-8 push only): ${binary.slice(0, 10).join(", ")}${binary.length > 10 ? "…" : ""}`,
    );
  }
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
      if (files.length === 0) {
        throw new Error("workspace produced no files to publish — refusing to deploy an empty tree");
      }
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
