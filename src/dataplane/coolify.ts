/* ============================================================
   Coolify-backed data plane (plan §19).

   Replaces `stubDataPlane` when COOLIFY_API_URL + COOLIFY_API_TOKEN
   are set. Cantila Projects become Coolify Applications:
     Coolify app `name` = `cantila-<project.id>`
     Coolify app `fqdn` = `<project.slug>.cantila.app`
   so `route()` matches the rest of the platform's URL convention.

   First slice (this drop):
     - source.kind === "git"     → /applications/public
     - source.kind === "upload"  → /applications/dockerimage (treats source.ref
                                   as a public image tag — the real upload-build
                                   path is a follow-up)
     - source.kind === "chat"    → same as upload for now
     - sampleMetrics() falls back to synthetic values. Coolify's Prometheus
       scrape lives behind /api/v1/servers/{uuid}/metrics and lands in a
       follow-up (plan §19.7).
   ============================================================ */

import type { Project, ProjectMetricSample, Runtime } from "../domain/types";
import type { DataPlane, DeploySource } from "../deploy/pipeline";

export interface CoolifyDataPlaneOptions {
  /** Base URL of the Coolify API, e.g. http://168.119.97.112:8000/api/v1 */
  apiUrl: string;
  /** API token from Coolify > Keys & Tokens. */
  apiToken: string;
  /** UUID of the Coolify Server resource tenant apps deploy onto. */
  serverUuid: string;
  /** UUID of the Coolify Project tenant apps live under. */
  projectUuid: string;
  /** Coolify environment name within the project, default `production`. */
  environmentName?: string;
  /** Apex used for auto-assigned FQDNs, default `cantila.app`. */
  apexDomain?: string;
}

export class CoolifyDataPlane implements DataPlane {
  private readonly apiUrl: string;
  private readonly apiToken: string;
  private readonly serverUuid: string;
  private readonly projectUuid: string;
  private readonly environmentName: string;
  private readonly apexDomain: string;
  /** projectId → Coolify Application UUID. Populated on create and on
   *  the first lookup that hits Coolify's list endpoint. In-process only;
   *  a restart re-hydrates from Coolify's list, so no DB column needed
   *  for the first slice. */
  private readonly appUuids = new Map<string, string>();

  constructor(opts: CoolifyDataPlaneOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.apiToken = opts.apiToken;
    this.serverUuid = opts.serverUuid;
    this.projectUuid = opts.projectUuid;
    this.environmentName = opts.environmentName ?? "production";
    this.apexDomain = opts.apexDomain ?? "cantila.app";
  }

  async detectStack(source: DeploySource): Promise<Runtime> {
    // Coolify (via Nixpacks) detects the real stack at build time; the
    // Cantila pipeline only uses this for the activity log. Mirror the
    // stub's heuristic so existing behaviour is unchanged.
    return source.kind === "upload" ? "docker" : "node";
  }

  async buildImage(
    _project: Project,
    _source: DeploySource,
  ): Promise<{ imageRef: string }> {
    // Coolify builds atomically during deploy, so there is no separate
    // image-build step on this side. Return a stable placeholder so the
    // Deployment row records something — the real image lives in
    // Coolify's internal registry, keyed by the application UUID.
    return { imageRef: `coolify:pending` };
  }

  async schedule(_project: Project): Promise<{ nodeId: string }> {
    // Multi-server scheduling is a follow-up (plan §19.8). For the first
    // slice every Cantila project lands on the configured Coolify server.
    return { nodeId: this.serverUuid };
  }

  async startContainer(
    project: Project,
    _imageRef: string,
    _nodeId: string,
    env: Record<string, string>,
  ): Promise<void> {
    // First check the cache + Coolify for an existing app; create if absent.
    let uuid = await this.findAppUuid(project);
    if (!uuid) {
      uuid = await this.createApp(project);
      this.appUuids.set(project.id, uuid);
    }

    // Push env vars (best-effort — Coolify returns 200 even for already-set keys).
    await this.syncEnv(uuid, env);

    // Trigger a fresh deploy. For an existing app this is a redeploy that
    // rebuilds the image from source and rolls the container.
    await this.request("POST", `/deploy?uuid=${encodeURIComponent(uuid)}`);
  }

  async route(project: Project): Promise<{ url: string }> {
    // Match the Cantila URL convention (plan §4.2 / §7.4) — the same shape
    // the Console and CLI assume everywhere. The user must wire
    // *.{apexDomain} DNS to the Coolify server's IP for this to resolve.
    return { url: `https://${project.slug}.${this.apexDomain}` };
  }

  async healthCheck(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async sampleMetrics(project: Project): Promise<ProjectMetricSample[]> {
    // First slice: synthetic samples. Real Coolify scrape lands in a
    // follow-up (plan §19.7); the swap is one method, no call-site
    // changes since ScaleAgent already reasons over the shape.
    return synthesiseMetrics(project);
  }

  // -- private helpers --------------------------------------------------

  private async findAppUuid(project: Project): Promise<string | undefined> {
    const cached = this.appUuids.get(project.id);
    if (cached) return cached;
    const name = appNameFor(project);
    const list = await this.request<CoolifyApp[]>("GET", "/applications");
    const found = list.find((a) => a.name === name);
    if (found) this.appUuids.set(project.id, found.uuid);
    return found?.uuid;
  }

  private async createApp(project: Project): Promise<string> {
    const name = appNameFor(project);
    // Coolify validates `domains` as a full URL — protocol prefix required.
    const fqdn = `https://${project.slug}.${this.apexDomain}`;

    if (project.repoUrl) {
      // Public git deploy via Nixpacks (the common case).
      const body = {
        project_uuid: this.projectUuid,
        server_uuid: this.serverUuid,
        environment_name: this.environmentName,
        name,
        git_repository: project.repoUrl,
        git_branch: project.branch ?? "main",
        build_pack: "nixpacks",
        ports_exposes: "3000",
        domains: fqdn,
        instant_deploy: false,
      };
      const created = await this.request<{ uuid: string }>(
        "POST",
        "/applications/public",
        body,
      );
      return created.uuid;
    }

    // No git repo on the project — fall back to a Docker image deploy.
    // Source.ref would be the image tag in a real upload flow; for the
    // first slice we deploy a placeholder so the slot exists, then the
    // tenant points it at a real image via `cantila env` or the Console.
    const body = {
      project_uuid: this.projectUuid,
      server_uuid: this.serverUuid,
      environment_name: this.environmentName,
      name,
      docker_registry_image_name: "nginx",
      docker_registry_image_tag: "alpine",
      ports_exposes: "80",
      domains: fqdn,
      instant_deploy: false,
    };
    const created = await this.request<{ uuid: string }>(
      "POST",
      "/applications/dockerimage",
      body,
    );
    return created.uuid;
  }

  private async syncEnv(
    appUuid: string,
    env: Record<string, string>,
  ): Promise<void> {
    // Bulk env-var upload — Coolify accepts a `data` array. Keys that
    // already exist are updated in place; new keys are created.
    const data = Object.entries(env).map(([key, value]) => ({
      key,
      value,
      is_preview: false,
      is_build_time: false,
      is_literal: true,
    }));
    if (data.length === 0) return;
    await this.request(
      "PATCH",
      `/applications/${encodeURIComponent(appUuid)}/envs/bulk`,
      { data },
    );
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Coolify ${method} ${path} → ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      );
    }
    // Some POSTs return 204 No Content; treat that as `{}`.
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }
}

interface CoolifyApp {
  uuid: string;
  name: string;
  fqdn?: string;
  status?: string;
}

function appNameFor(project: Project): string {
  // Deterministic + reversible: lets us look the app back up from the
  // Cantila Project id after a control-plane restart wipes the cache.
  return `cantila-${project.id}`;
}

function synthesiseMetrics(project: Project): ProjectMetricSample[] {
  const SAMPLE_COUNT = 12;
  const INTERVAL_MS = 5_000;
  const now = Date.now();
  const seed = hashSeed(project.id);
  const baseCpu =
    project.status === "live"
      ? 25 + (seed % 30)
      : project.status === "sleeping"
        ? 2 + (seed % 5)
        : 0;
  const baseRps =
    project.status === "live"
      ? 4 + (seed % 12)
      : project.status === "sleeping"
        ? 0.1 + (seed % 5) / 10
        : 0;
  const baseMem =
    project.status === "live" || project.status === "sleeping"
      ? 35 + (seed % 25)
      : 0;
  const out: ProjectMetricSample[] = [];
  for (let i = SAMPLE_COUNT - 1; i >= 0; i--) {
    const at = new Date(now - i * INTERVAL_MS).toISOString();
    if (
      project.status === "crashed" ||
      project.status === "paused" ||
      project.status === "provisioning" ||
      project.status === "building"
    ) {
      out.push({ at, cpuPct: 0, memPct: 0, rps: 0 });
      continue;
    }
    const jitter = (Math.random() - 0.5) * 0.2;
    out.push({
      at,
      cpuPct: Math.round(clamp(baseCpu * (1 + jitter), 0, 100) * 10) / 10,
      memPct: Math.round(clamp(baseMem * (1 + jitter * 0.5), 0, 100) * 10) / 10,
      rps: Math.round(Math.max(0, baseRps * (1 + jitter)) * 10) / 10,
    });
  }
  return out;
}

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
