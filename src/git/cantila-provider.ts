import type { GitProvider } from "./provider";
import type { RepoRef, FileNode, FileContent, WriteInput, DeleteInput } from "./types";
import { GitError } from "./types";

/** Exported pure mappers (unit-tested without network). */
export function mapTree(data: { tree: { path: string; type: string; sha: string }[] }): FileNode[] {
  return data.tree
    .filter((t) => t.type === "blob" || t.type === "tree")
    .map((t) => ({ path: t.path, type: t.type as "blob" | "tree", sha: t.sha }));
}
export function mapContent(data: { content: string; encoding: string; sha: string }): FileContent {
  const content =
    data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf-8") : data.content;
  return { content, sha: data.sha, encoding: "utf-8" };
}

const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** Gitea-backed GitProvider. base = `${giteaUrl}/api/v1`. */
export class CantilaGitProvider implements GitProvider {
  private base: string;
  constructor(
    giteaUrl: string,
    private token: string,
  ) {
    this.base = `${giteaUrl.replace(/\/+$/, "")}/api/v1`;
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `token ${this.token}`,
    };
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = `gitea ${res.status}`;
      try {
        const j = JSON.parse(text) as { message?: string };
        if (j.message) msg = j.message;
      } catch {
        /* ignore */
      }
      throw new GitError(res.status, msg);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  async getDefaultBranch(repo: RepoRef): Promise<string> {
    const r = await this.req<{ default_branch: string }>(`/repos/${repo.owner}/${repo.repo}`);
    return r.default_branch;
  }

  private async branchTreeSha(repo: RepoRef, branch: string): Promise<string> {
    const b = await this.req<{ commit: { id: string } }>(
      `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(branch)}`,
    );
    return b.commit.id;
  }

  async listTree(repo: RepoRef, ref?: string): Promise<FileNode[]> {
    const branch = ref || (await this.getDefaultBranch(repo));
    const treeSha = await this.branchTreeSha(repo, branch);
    const data = await this.req<{ tree: { path: string; type: string; sha: string }[] }>(
      `/repos/${repo.owner}/${repo.repo}/git/trees/${treeSha}?recursive=true`,
    );
    return mapTree(data);
  }

  async readFile(repo: RepoRef, path: string, ref?: string): Promise<FileContent> {
    const branch = ref || (await this.getDefaultBranch(repo));
    const data = await this.req<{ content: string; encoding: string; sha: string }>(
      `/repos/${repo.owner}/${repo.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`,
    );
    return mapContent(data);
  }

  async archive(repo: RepoRef, ref?: string): Promise<{ data: Uint8Array; filename: string }> {
    const branch = ref || (await this.getDefaultBranch(repo));
    const res = await fetch(
      `${this.base}/repos/${repo.owner}/${repo.repo}/archive/${encodeURIComponent(branch)}.zip`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = `gitea ${res.status}`;
      try {
        const j = JSON.parse(text) as { message?: string };
        if (j.message) msg = j.message;
      } catch {
        /* ignore */
      }
      throw new GitError(res.status, msg);
    }
    return { data: new Uint8Array(await res.arrayBuffer()), filename: `${repo.repo}.zip` };
  }

  async writeFile(repo: RepoRef, input: WriteInput): Promise<{ commitSha: string; sha: string }> {
    const body = {
      content: Buffer.from(input.content, "utf-8").toString("base64"),
      message: input.message ?? `Update ${input.path} via Cantila`,
      branch: input.branch,
      ...(input.sha ? { sha: input.sha } : {}),
    };
    const method = input.sha ? "PUT" : "POST";
    const data = await this.req<{ commit: { sha: string }; content: { sha: string } }>(
      `/repos/${repo.owner}/${repo.repo}/contents/${encPath(input.path)}`,
      { method, body: JSON.stringify(body) },
    );
    return { commitSha: data.commit.sha, sha: data.content.sha };
  }

  async deleteFile(repo: RepoRef, input: DeleteInput): Promise<{ commitSha: string }> {
    const body = {
      sha: input.sha,
      message: input.message ?? `Delete ${input.path} via Cantila`,
      branch: input.branch,
    };
    const data = await this.req<{ commit: { sha: string } }>(
      `/repos/${repo.owner}/${repo.repo}/contents/${encPath(input.path)}`,
      { method: "DELETE", body: JSON.stringify(body) },
    );
    return { commitSha: data.commit.sha };
  }

  /** Ensure the org exists (idempotent). */
  private async ensureOrg(owner: string): Promise<void> {
    await this.req(`/orgs/${owner}`).catch(async (e) => {
      if (e instanceof GitError && e.status === 404) {
        await this.req(`/orgs`, { method: "POST", body: JSON.stringify({ username: owner }) });
      } else {
        throw e;
      }
    });
  }

  async createRepo(input: { owner: string; name: string; private?: boolean }): Promise<{ cloneUrl: string; defaultBranch: string }> {
    await this.ensureOrg(input.owner);
    try {
      const r = await this.req<{ clone_url: string; default_branch: string }>(
        `/orgs/${input.owner}/repos`,
        {
          method: "POST",
          body: JSON.stringify({
            name: input.name,
            private: input.private ?? true,
            auto_init: true,
            default_branch: "main",
          }),
        },
      );
      return { cloneUrl: r.clone_url, defaultBranch: r.default_branch || "main" };
    } catch (e) {
      if (e instanceof GitError && (e.status === 409 || e.status === 422)) {
        const r = await this.req<{ clone_url: string; default_branch: string }>(
          `/repos/${input.owner}/${input.name}`,
        );
        return { cloneUrl: r.clone_url, defaultBranch: r.default_branch || "main" };
      }
      throw e;
    }
  }

  async migrateRepo(input: {
    owner: string;
    name: string;
    cloneAddr: string;
    authToken?: string;
    private?: boolean;
  }): Promise<{ cloneUrl: string; defaultBranch: string }> {
    await this.ensureOrg(input.owner);
    try {
      // Gitea clones the SOURCE itself (server-to-server, full history) —
      // the bootstrap-clone flow. `mirror:false` makes it a normal repo the
      // tenant owns from then on, not a read-only mirror.
      const r = await this.req<{ clone_url: string; default_branch: string }>(
        `/repos/migrate`,
        {
          method: "POST",
          body: JSON.stringify({
            clone_addr: input.cloneAddr,
            repo_owner: input.owner,
            repo_name: input.name,
            mirror: false,
            private: input.private ?? true,
            ...(input.authToken ? { auth_token: input.authToken } : {}),
          }),
        },
      );
      return { cloneUrl: r.clone_url, defaultBranch: r.default_branch || "main" };
    } catch (e) {
      if (e instanceof GitError && (e.status === 409 || e.status === 422)) {
        const r = await this.req<{ clone_url: string; default_branch: string }>(
          `/repos/${input.owner}/${input.name}`,
        );
        return { cloneUrl: r.clone_url, defaultBranch: r.default_branch || "main" };
      }
      throw e;
    }
  }
}
