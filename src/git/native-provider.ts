/* ============================================================
   NativeGitProvider — Cantila's own git backend (plan §22, "drop the
   Gitea bundle"). One bare repo per project on box 1, operated with git
   plumbing — no working tree, no Gitea application. Implements the same
   `GitProvider` port as the Gitea and GitHub adapters, so it is invisible
   above the seam and runs side-by-side with GitHub (repoHost dispatch).

   All git/filesystem I/O lives behind injected seams (`GitExec`,
   `NativeGitFs`) so the provider is pure orchestration + fully unit
   testable with no real git binary and no disk. The concrete seams
   (child_process + node:fs) are the untested I/O edge at the bottom.

   Write model (no checkout, concurrency-safe): hash-object → build a tree
   in a throwaway index (GIT_INDEX_FILE) → commit-tree → update-ref with
   the old commit as a compare-and-swap guard. A stale `sha` on the target
   file is rejected 409 before any write, matching the Gitea adapter.
   ============================================================ */

import { join } from "node:path";
import type { GitProvider } from "./provider";
import type { RepoRef, FileNode, FileContent, WriteInput, DeleteInput } from "./types";
import { GitError } from "./types";

/** Run a git subcommand. Returns stdout as raw bytes (text callers decode).
 *  Rejects with a GitError(status) when git exits non-zero, unless the call
 *  opts into `allowFail` (then `{ code, stdout }` is returned). */
export interface GitExec {
  run(
    args: string[],
    opts: {
      cwd: string;
      env?: Record<string, string>;
      input?: Buffer;
      /** Don't throw on non-zero exit — return the code so the caller can
       *  branch (e.g. "ref does not exist yet"). */
      allowFail?: boolean;
    },
  ): Promise<{ code: number; stdout: Buffer }>;
}

/** Minimal filesystem seam for repo provisioning. */
export interface NativeGitFs {
  ensureDir(dir: string): Promise<void>;
  exists(dir: string): Promise<boolean>;
}

const text = (b: Buffer) => b.toString("utf-8");
const line = (b: Buffer) => text(b).trim();

export interface NativeGitProviderOpts {
  root: string;
  publicBase: string;
  exec: GitExec;
  fs: NativeGitFs;
  /** Throwaway index filename suffix source — defaults to a counter so two
   *  concurrent writes in one process don't share an index. */
  indexSuffix?: () => string;
}

export class NativeGitProvider implements GitProvider {
  private readonly root: string;
  private readonly publicBase: string;
  private readonly exec: GitExec;
  private readonly fsx: NativeGitFs;
  private indexCounter = 0;
  private readonly indexSuffix: () => string;

  constructor(opts: NativeGitProviderOpts) {
    this.root = opts.root.replace(/\/+$/, "");
    this.publicBase = opts.publicBase.replace(/\/+$/, "");
    this.exec = opts.exec;
    this.fsx = opts.fs;
    this.indexSuffix = opts.indexSuffix ?? (() => `${++this.indexCounter}`);
  }

  /** Absolute path of a project's bare repo. */
  private dir(repo: RepoRef): string {
    return join(this.root, repo.owner, `${repo.repo}.git`);
  }

  /** Run git inside the repo, throwing GitError on failure. */
  private async git(
    repo: RepoRef,
    args: string[],
    extra: { env?: Record<string, string>; input?: Buffer } = {},
  ): Promise<Buffer> {
    const cwd = this.dir(repo);
    const { code, stdout } = await this.exec.run(args, { cwd, ...extra });
    if (code !== 0) {
      // A missing repo / bad ref reads as 404; everything else as a 502.
      const status = code === 128 ? 404 : 502;
      throw new GitError(status, `git ${args[0]} failed (code ${code})`);
    }
    return stdout;
  }

  async getDefaultBranch(repo: RepoRef): Promise<string> {
    const { code, stdout } = await this.exec.run(
      ["symbolic-ref", "--short", "HEAD"],
      { cwd: this.dir(repo), allowFail: true },
    );
    const b = code === 0 ? line(stdout) : "";
    return b || "main";
  }

  async listTree(repo: RepoRef, ref?: string): Promise<FileNode[]> {
    const branch = ref || (await this.getDefaultBranch(repo));
    // -r recurse, -t include tree entries (Gitea returns both blob and tree).
    const out = text(await this.git(repo, ["ls-tree", "-r", "-t", branch]));
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        // "<mode> <type> <sha>\t<path>"
        const tab = l.indexOf("\t");
        const meta = l.slice(0, tab).split(/\s+/);
        return { type: meta[1], sha: meta[2], path: l.slice(tab + 1) };
      })
      .filter((e) => e.type === "blob" || e.type === "tree")
      .map((e) => ({ path: e.path, type: e.type as "blob" | "tree", sha: e.sha }));
  }

  /** Current blob sha of a path on a branch, or null when absent. */
  private async blobShaAt(
    repo: RepoRef,
    branch: string,
    path: string,
  ): Promise<string | null> {
    const { code, stdout } = await this.exec.run(
      ["rev-parse", "--verify", "--quiet", `${branch}:${path}`],
      { cwd: this.dir(repo), allowFail: true },
    );
    return code === 0 ? line(stdout) || null : null;
  }

  async readFile(repo: RepoRef, path: string, ref?: string): Promise<FileContent> {
    const branch = ref || (await this.getDefaultBranch(repo));
    const sha = await this.blobShaAt(repo, branch, path);
    if (!sha) throw new GitError(404, `not found: ${path}`);
    const content = text(await this.git(repo, ["cat-file", "blob", `${branch}:${path}`]));
    return { content, sha, encoding: "utf-8" };
  }

  async archive(repo: RepoRef, ref?: string): Promise<{ data: Uint8Array; filename: string }> {
    const branch = ref || (await this.getDefaultBranch(repo));
    const buf = await this.git(repo, ["archive", "--format=zip", branch]);
    return { data: new Uint8Array(buf), filename: `${repo.repo}.zip` };
  }

  /** Resolve the current commit of a branch, or null when the branch is
   *  unborn (first write to a fresh repo). */
  private async branchCommit(repo: RepoRef, branch: string): Promise<string | null> {
    const { code, stdout } = await this.exec.run(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: this.dir(repo), allowFail: true },
    );
    return code === 0 ? line(stdout) || null : null;
  }

  /** Build a new tree from the branch's current tree plus one staged change,
   *  commit it, and CAS the branch ref forward. Shared by write + delete. */
  private async commitChange(
    repo: RepoRef,
    branch: string,
    message: string,
    stage: (env: Record<string, string>) => Promise<void>,
  ): Promise<string> {
    const parent = await this.branchCommit(repo, branch);
    const env = { GIT_INDEX_FILE: `index-${this.indexSuffix()}` };
    if (parent) await this.git(repo, ["read-tree", parent], { env });
    await stage(env);
    const tree = line(await this.git(repo, ["write-tree"], { env }));
    const commit = line(
      await this.git(repo, [
        "commit-tree",
        tree,
        ...(parent ? ["-p", parent] : []),
        "-m",
        message,
      ]),
    );
    // CAS: pass the old value so a racing writer can't be silently lost.
    await this.git(repo, ["update-ref", `refs/heads/${branch}`, commit, parent ?? ""]);
    return commit;
  }

  async writeFile(repo: RepoRef, input: WriteInput): Promise<{ commitSha: string; sha: string }> {
    // Optimistic-concurrency guard, same contract as the Gitea adapter.
    const current = await this.blobShaAt(repo, input.branch, input.path);
    if (input.sha && current !== input.sha) {
      throw new GitError(409, `stale sha for ${input.path}`);
    }
    if (!input.sha && current) {
      throw new GitError(409, `already exists: ${input.path}`);
    }
    const blob = line(
      await this.git(repo, ["hash-object", "-w", "--stdin"], {
        input: Buffer.from(input.content, "utf-8"),
      }),
    );
    const message = input.message ?? `Update ${input.path} via Cantila`;
    const commit = await this.commitChange(repo, input.branch, message, async (env) => {
      await this.git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${input.path}`], { env });
    });
    return { commitSha: commit, sha: blob };
  }

  async deleteFile(repo: RepoRef, input: DeleteInput): Promise<{ commitSha: string }> {
    const current = await this.blobShaAt(repo, input.branch, input.path);
    if (!current) throw new GitError(404, `not found: ${input.path}`);
    if (input.sha && current !== input.sha) {
      throw new GitError(409, `stale sha for ${input.path}`);
    }
    const message = input.message ?? `Delete ${input.path} via Cantila`;
    const commit = await this.commitChange(repo, input.branch, message, async (env) => {
      await this.git(repo, ["update-index", "--force-remove", input.path], { env });
    });
    return { commitSha: commit };
  }

  private cloneUrl(owner: string, name: string): string {
    return `${this.publicBase}/${owner}/${name}.git`;
  }

  async createRepo(input: { owner: string; name: string; private?: boolean }): Promise<{ cloneUrl: string; defaultBranch: string }> {
    const repoDir = join(this.root, input.owner, `${input.name}.git`);
    if (!(await this.fsx.exists(repoDir))) {
      await this.fsx.ensureDir(join(this.root, input.owner));
      await this.exec.run(["init", "--bare", "--initial-branch=main", repoDir], { cwd: this.root });
    }
    return { cloneUrl: this.cloneUrl(input.owner, input.name), defaultBranch: "main" };
  }

  async migrateRepo(input: {
    owner: string;
    name: string;
    cloneAddr: string;
    authToken?: string;
    private?: boolean;
  }): Promise<{ cloneUrl: string; defaultBranch: string }> {
    const repoDir = join(this.root, input.owner, `${input.name}.git`);
    if (!(await this.fsx.exists(repoDir))) {
      await this.fsx.ensureDir(join(this.root, input.owner));
      // Authenticate against the SOURCE host for private repos by injecting
      // the token into the clone URL (https only).
      const addr = input.authToken
        ? input.cloneAddr.replace(/^https:\/\//, `https://oauth2:${input.authToken}@`)
        : input.cloneAddr;
      await this.exec.run(["clone", "--bare", addr, repoDir], { cwd: this.root });
    }
    const branch = await this.getDefaultBranch({ owner: input.owner, repo: input.name });
    return { cloneUrl: this.cloneUrl(input.owner, input.name), defaultBranch: branch };
  }
}

/* ---------- concrete seams (untested I/O edge) ---------- */

/** child_process-backed GitExec. */
export function makeGitExec(): GitExec {
  return {
    run(args, opts) {
      // Lazy import keeps the module load free of node:child_process for the
      // (faked) test path and mirrors the optional-dep pattern elsewhere.
      return import("node:child_process").then(
        ({ spawn }) =>
          new Promise((resolve, reject) => {
            const child = spawn("git", args, {
              cwd: opts.cwd,
              env: { ...process.env, ...(opts.env ?? {}) },
            });
            const out: Buffer[] = [];
            child.stdout.on("data", (d: Buffer) => out.push(d));
            child.on("error", reject);
            child.on("close", (code) => resolve({ code: code ?? 0, stdout: Buffer.concat(out) }));
            if (opts.input) child.stdin.end(opts.input);
            else child.stdin.end();
          }),
      );
    },
  };
}

/** node:fs-backed NativeGitFs. */
export function makeNativeGitFs(): NativeGitFs {
  return {
    async ensureDir(dir) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
    },
    async exists(dir) {
      const { stat } = await import("node:fs/promises");
      return stat(dir).then(
        () => true,
        () => false,
      );
    },
  };
}
