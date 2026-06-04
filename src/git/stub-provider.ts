import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import type { GitProvider } from "./provider";
import type { RepoRef, FileNode, FileContent, WriteInput, DeleteInput } from "./types";
import { GitError } from "./types";

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const key = (r: RepoRef) => `${r.owner}/${r.repo}`;

/** In-memory GitProvider for offline dev/tests. Not persisted. */
export class StubGitProvider implements GitProvider {
  private repos = new Map<string, Map<string, string>>(); // key -> path -> content

  async getDefaultBranch(_repo: RepoRef): Promise<string> {
    return "main";
  }

  async createRepo(input: {
    owner: string;
    name: string;
    private?: boolean;
  }): Promise<{ cloneUrl: string; defaultBranch: string }> {
    const k = `${input.owner}/${input.name}`;
    if (!this.repos.has(k)) this.repos.set(k, new Map());
    return { cloneUrl: `stub://git/${k}.git`, defaultBranch: "main" };
  }

  private files(r: RepoRef): Map<string, string> {
    const f = this.repos.get(key(r));
    if (!f) throw new GitError(404, "repo not found");
    return f;
  }

  async listTree(r: RepoRef, _ref?: string): Promise<FileNode[]> {
    const files = this.files(r);
    const nodes: FileNode[] = [];
    const dirs = new Set<string>();
    for (const path of files.keys()) {
      nodes.push({ path, type: "blob", sha: sha(files.get(path)!) });
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!dirs.has(dir)) {
          dirs.add(dir);
          nodes.push({ path: dir, type: "tree", sha: sha(dir) });
        }
      }
    }
    return nodes;
  }

  async readFile(r: RepoRef, path: string, _ref?: string): Promise<FileContent> {
    const files = this.files(r);
    if (!files.has(path)) throw new GitError(404, "file not found");
    return { content: files.get(path)!, sha: sha(files.get(path)!), encoding: "utf-8" };
  }

  async archive(r: RepoRef, _ref?: string): Promise<{ data: Uint8Array; filename: string }> {
    const files = this.files(r);
    const entries: Record<string, Uint8Array> = {};
    for (const [path, content] of files) entries[path] = strToU8(content);
    return { data: zipSync(entries), filename: `${r.repo}.zip` };
  }

  async writeFile(
    r: RepoRef,
    input: WriteInput,
  ): Promise<{ commitSha: string; sha: string }> {
    const files = this.files(r);
    files.set(input.path, input.content);
    const s = sha(input.content);
    return { commitSha: sha(`commit:${input.path}:${s}`), sha: s };
  }

  async deleteFile(r: RepoRef, input: DeleteInput): Promise<{ commitSha: string }> {
    const files = this.files(r);
    files.delete(input.path);
    return { commitSha: sha(`del:${input.path}`) };
  }
}
