/* ============================================================
   Coolify-backed data plane (plan §19).

   Replaces `stubDataPlane` when COOLIFY_API_URL + COOLIFY_API_TOKEN
   are set. Cantila Projects become Coolify Applications:
     Coolify app `name` = `cantila-<project.id>`
     Coolify app `fqdn` = `<project.slug>.cantila.app`
   so `route()` matches the rest of the platform's URL convention.

   Routing of DeploySource kinds to Coolify primitives:
     - source.kind === "git"     → /applications/public (Nixpacks build).
     - source.kind === "upload"  → /applications/dockerimage when source.ref
                                   parses as a registry image (the CLI / build
                                   pipeline pushed the bytes first); otherwise
                                   the nginx:alpine placeholder slot.
     - source.kind === "chat"    → same as upload for now.
     - sampleMetrics() emits synthesised samples shaped by the live
       container status from Coolify's /servers/{uuid}/resources call.
       Coolify v4 does not expose per-app CPU/memory time series via
       its public REST API — both `/applications/{uuid}/metrics` and
       `/servers/{uuid}/metrics` 404. The numbers stay synthesised
       until either Coolify exposes a Sentinel endpoint or we add a
       node_exporter / docker-stats SSH path (plan §19.7).
   ============================================================ */

import type { Project, ProjectMetricSample, Region, Runtime } from "../domain/types";
import type { DataPlane, DeploySource } from "../deploy/pipeline";

/** Per-region Coolify panel binding (plan §19.8 multi-server). Phase 3
 *  uses one Coolify panel per region — this carries each panel's URL,
 *  token, server and project uuid. The base options' `apiUrl` /
 *  `apiToken` act as defaults when a region entry omits them. */
export interface CoolifyRegionConfig {
  /** Optional override of the default `apiUrl` for this region.
   *  Set when a separate Coolify panel runs in this region. */
  apiUrl?: string;
  /** Optional override of the default `apiToken` for this region. */
  apiToken?: string;
  /** Coolify Server UUID for this region. */
  serverUuid: string;
  /** Coolify Project UUID for this region. */
  projectUuid: string;
}

export interface CoolifyDataPlaneOptions {
  /** Base URL of the Coolify API, e.g. http://168.119.97.112:8000/api/v1.
   *  Used as the default when a region binding omits `apiUrl`. */
  apiUrl: string;
  /** API token from Coolify > Keys & Tokens. Default for regions that
   *  omit their own `apiToken`. */
  apiToken: string;
  /** UUID of the Coolify Server resource tenant apps deploy onto.
   *  Back-compat — used when `regions` is unset, applied to every
   *  project regardless of `Project.region`. */
  serverUuid?: string;
  /** UUID of the Coolify Project tenant apps live under. Back-compat
   *  — used when `regions` is unset. */
  projectUuid?: string;
  /** Region → per-region panel binding. When set, `schedule()` /
   *  `createApp()` / `findAppUuid()` route per-project by
   *  `Project.region`. When unset, the legacy single-region pair
   *  (`serverUuid` + `projectUuid`) is used for every project. */
  regions?: Partial<Record<Region, CoolifyRegionConfig>>;
  /** Region to fall back to when a Project's region has no entry in
   *  `regions`. Defaults to the first key in `regions` insertion
   *  order, or — back-compat — the single-region binding. */
  defaultRegion?: Region;
  /** Coolify environment name within the project, default `production`. */
  environmentName?: string;
  /** Apex used for auto-assigned FQDNs, default `cantila.app`. */
  apexDomain?: string;
  /** Optional persistence hook for the Cantila Project → Coolify
   *  Application UUID mapping. When wired, `startContainer` persists the
   *  uuid on first deploy so a control-plane restart doesn't need to
   *  re-scan `/applications` to find each tenant app (plan §19 — drops
   *  the in-process cache rehydrate). When absent the cache still works,
   *  just rebuilt lazily on restart. */
  persistAppUuid?: (projectId: string, appUuid: string) => Promise<void>;
}

/** Concrete per-project routing — apiUrl/apiToken/serverUuid/projectUuid
 *  all resolved with region overrides + defaults applied. Internal. */
interface ResolvedRegion {
  apiUrl: string;
  apiToken: string;
  serverUuid: string;
  projectUuid: string;
}

export class CoolifyDataPlane implements DataPlane {
  private readonly defaultApiUrl: string;
  private readonly defaultApiToken: string;
  private readonly environmentName: string;
  private readonly apexDomain: string;
  /** Per-region routing table. Always populated — when the caller
   *  passes only `serverUuid` + `projectUuid` (legacy single-region
   *  setup), it gets folded into a one-entry table keyed by
   *  `defaultRegion`. */
  private readonly regions: ReadonlyMap<Region, ResolvedRegion>;
  private readonly defaultRegion: Region;
  /** projectId → Coolify Application UUID. Authoritative copy lives on
   *  `Project.coolifyAppUuid` (column added 2026-05-28); this is a
   *  per-process read-through cache so the hot path doesn't re-hit the
   *  DB on every deploy. Misses fall back to the persisted field, then
   *  the Coolify `/applications` list (in the right region), then create. */
  private readonly appUuids = new Map<string, string>();
  private readonly persistAppUuid?: (
    projectId: string,
    appUuid: string,
  ) => Promise<void>;

  constructor(opts: CoolifyDataPlaneOptions) {
    this.defaultApiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.defaultApiToken = opts.apiToken;
    this.environmentName = opts.environmentName ?? "production";
    this.apexDomain = opts.apexDomain ?? "cantila.app";
    this.persistAppUuid = opts.persistAppUuid;

    const regions = new Map<Region, ResolvedRegion>();
    if (opts.regions && Object.keys(opts.regions).length > 0) {
      for (const [region, cfg] of Object.entries(opts.regions) as [
        Region,
        CoolifyRegionConfig,
      ][]) {
        regions.set(region, {
          apiUrl: (cfg.apiUrl ?? this.defaultApiUrl).replace(/\/+$/, ""),
          apiToken: cfg.apiToken ?? this.defaultApiToken,
          serverUuid: cfg.serverUuid,
          projectUuid: cfg.projectUuid,
        });
      }
    } else if (opts.serverUuid && opts.projectUuid) {
      // Back-compat: legacy single-region. Pick `defaultRegion` (or
      // `fsn1` — Cantila's launch region) as the key so the routing
      // table is still a real region map.
      const region: Region = opts.defaultRegion ?? "fsn1";
      regions.set(region, {
        apiUrl: this.defaultApiUrl,
        apiToken: this.defaultApiToken,
        serverUuid: opts.serverUuid,
        projectUuid: opts.projectUuid,
      });
    } else {
      throw new Error(
        "CoolifyDataPlane: either `regions` or both `serverUuid` + `projectUuid` must be set",
      );
    }
    this.regions = regions;
    this.defaultRegion =
      opts.defaultRegion && regions.has(opts.defaultRegion)
        ? opts.defaultRegion
        : (regions.keys().next().value as Region);
  }

  /** Resolve the per-region routing for a project. Falls back to
   *  `defaultRegion` when the project's region has no entry — that
   *  keeps the legacy single-region setup working unchanged. */
  private regionFor(project: Project): ResolvedRegion {
    return (
      this.regions.get(project.region) ??
      this.regions.get(this.defaultRegion)!
    );
  }

  async detectStack(source: DeploySource): Promise<Runtime> {
    // Coolify (via Nixpacks) detects the real stack at build time; the
    // Cantila pipeline only uses this for the activity log. Mirror the
    // stub's heuristic so existing behaviour is unchanged.
    return source.kind === "upload" ? "docker" : "node";
  }

  async buildImage(
    _project: Project,
    source: DeploySource,
  ): Promise<{ imageRef: string }> {
    // Coolify builds atomically during deploy for git sources, so there
    // is no separate image-build step on this side — return a stable
    // placeholder so the Deployment row records something. For an
    // `upload` deploy that arrives with a real image reference (the CLI
    // having pushed the bytes to a registry already), pass the ref
    // straight through as the imageRef. `startContainer` recognises it
    // and configures Coolify to pull that image instead of falling back
    // to the `nginx:alpine` placeholder. Plan §19.
    if (source.kind === "upload" && source.ref && isImageRef(source.ref)) {
      return { imageRef: source.ref };
    }
    return { imageRef: `coolify:pending` };
  }

  async schedule(project: Project): Promise<{ nodeId: string }> {
    // Per-region routing (plan §19.8). The nodeId carries the Coolify
    // Server UUID of the region the project belongs to — recorded in the
    // Deployment row so the activity stream shows which server ran it.
    // Within-region multi-node load-balancing is still left to a future
    // drop; today each region maps to a single Coolify server.
    return { nodeId: this.regionFor(project).serverUuid };
  }

  async startContainer(
    project: Project,
    imageRef: string,
    _nodeId: string,
    env: Record<string, string>,
  ): Promise<void> {
    const region = this.regionFor(project);
    // Lookup precedence: in-memory cache → persisted Project column →
    // Coolify's app list (slow, scanned by name) → create.
    let uuid = await this.findAppUuid(project);
    if (!uuid) {
      uuid = await this.createApp(project, imageRef);
    }
    // Memoize + persist whatever uuid we ended up with so the next
    // deploy / restart skips straight to env-sync + redeploy.
    this.appUuids.set(project.id, uuid);
    if (project.coolifyAppUuid !== uuid && this.persistAppUuid) {
      // Best-effort — never fail a deploy because the bookkeeping write
      // failed. The cache still works for the rest of the process.
      try {
        await this.persistAppUuid(project.id, uuid);
      } catch {
        /* swallow — telemetry is the right place to flag this */
      }
    }

    // Push env vars (best-effort — Coolify returns 200 even for already-set keys).
    await this.syncEnv(uuid, env, region);

    // Trigger a fresh deploy. For an existing app this is a redeploy that
    // rebuilds the image from source and rolls the container.
    await this.request(
      "POST",
      `/deploy?uuid=${encodeURIComponent(uuid)}`,
      undefined,
      region,
    );
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
    // Status check (real) → synthetic fill (deterministic). The Coolify
    // v4 public REST surface does NOT expose per-app or per-server
    // CPU/memory series — those numbers are collected by Coolify's
    // internal "Sentinel" agent and only surfaced in the dashboard UI.
    // `/api/v1/servers/{uuid}/metrics` returns 404 even with
    // `is_metrics_enabled: true`. Probed against the live Coolify
    // (qy01zelvuwhlxwzya73pavwl) on 2026-05-28 — confirmed gap, not
    // a configuration problem.
    //
    // Until either (a) Sentinel exposes a public metrics endpoint,
    // (b) we add an SSH path that scrapes `docker stats` off the node,
    // or (c) we run our own node_exporter sidecar, the honest move is
    // to keep emitting plausible samples derived from the project's
    // real status — `running:unknown` → live numbers, `exited` → zeros.
    // We DO call `/servers/{uuid}/resources` so the synthesis at least
    // respects what Coolify reports about the container's lifecycle
    // instead of guessing from the Cantila-side `Project.status` (which
    // can lag the data plane by a few seconds).
    const liveStatus = await this.fetchResourceStatus(project).catch(
      () => undefined,
    );
    return synthesiseMetrics(project, liveStatus);
  }

  // -- private helpers --------------------------------------------------

  /** Ask Coolify what status it reports for this project's container.
   *  Used to inform `sampleMetrics` so the synthesised CPU/memory
   *  numbers respect the real container lifecycle (a stopped container
   *  always reports 0%, regardless of what the Cantila Project row
   *  says). Returns `undefined` on any failure — the caller falls back
   *  to the Project's own status field. */
  private async fetchResourceStatus(
    project: Project,
  ): Promise<string | undefined> {
    const name = appNameFor(project);
    const region = this.regionFor(project);
    try {
      const resources = await this.request<CoolifyResource[]>(
        "GET",
        `/servers/${encodeURIComponent(region.serverUuid)}/resources`,
        undefined,
        region,
      );
      const match = resources.find(
        (r) => r.name === name && r.type === "application",
      );
      return match?.status;
    } catch {
      return undefined;
    }
  }

  private async findAppUuid(project: Project): Promise<string | undefined> {
    const cached = this.appUuids.get(project.id);
    if (cached) return cached;
    // Persisted column — populated on previous deploys (plan §19). Skip
    // the full app-list scan when we already know the uuid.
    if (project.coolifyAppUuid) {
      this.appUuids.set(project.id, project.coolifyAppUuid);
      return project.coolifyAppUuid;
    }
    const name = appNameFor(project);
    const region = this.regionFor(project);
    const list = await this.request<CoolifyApp[]>(
      "GET",
      "/applications",
      undefined,
      region,
    );
    const found = list.find((a) => a.name === name);
    if (found) this.appUuids.set(project.id, found.uuid);
    return found?.uuid;
  }

  private async createApp(
    project: Project,
    imageRef: string,
  ): Promise<string> {
    const name = appNameFor(project);
    const region = this.regionFor(project);
    // Coolify validates `domains` as a full URL — protocol prefix required.
    const fqdn = `https://${project.slug}.${this.apexDomain}`;

    // Decision tree for the underlying Coolify app type:
    //   1. `imageRef` is a real registry reference (CLI / upload flow
    //      that produced an image — plan §19.4)  → /applications/dockerimage
    //      pointing at that image.
    //   2. Project has a `repoUrl`  → /applications/public + Nixpacks.
    //   3. Otherwise fall back to the `nginx:alpine` placeholder so the
    //      slot exists and the tenant can swap in an image later.
    if (imageRef && imageRef !== "coolify:pending" && isImageRef(imageRef)) {
      const { image, tag } = splitImageRef(imageRef);
      const body = {
        project_uuid: region.projectUuid,
        server_uuid: region.serverUuid,
        environment_name: this.environmentName,
        name,
        docker_registry_image_name: image,
        docker_registry_image_tag: tag,
        ports_exposes: "3000",
        domains: fqdn,
        instant_deploy: false,
      };
      const created = await this.request<{ uuid: string }>(
        "POST",
        "/applications/dockerimage",
        body,
        region,
      );
      return created.uuid;
    }

    if (project.repoUrl) {
      // Public git deploy via Nixpacks (the common case).
      const body = {
        project_uuid: region.projectUuid,
        server_uuid: region.serverUuid,
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
        region,
      );
      return created.uuid;
    }

    // No git repo and no usable image — placeholder slot, swap later
    // via the Console or `cantila env`. Plan §19.
    const body = {
      project_uuid: region.projectUuid,
      server_uuid: region.serverUuid,
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
      region,
    );
    return created.uuid;
  }

  private async syncEnv(
    appUuid: string,
    env: Record<string, string>,
    region: ResolvedRegion,
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
      region,
    );
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    region?: ResolvedRegion,
  ): Promise<T> {
    // When the caller specifies a region we route to that Coolify panel
    // (multi-server / multi-region — plan §19.8). Without a region we
    // fall back to the default URL + token — used by the static health
    // check and any future endpoint that isn't tenant-scoped.
    const apiUrl = region?.apiUrl ?? this.defaultApiUrl;
    const apiToken = region?.apiToken ?? this.defaultApiToken;
    const url = `${apiUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
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

interface CoolifyResource {
  uuid: string;
  name: string;
  /** "application" | "standalone-postgresql" | … */
  type: string;
  /** Free-text from the Coolify backend, e.g. "running:unknown",
   *  "running:healthy", "exited", "restarting". */
  status?: string;
}

function appNameFor(project: Project): string {
  // Deterministic + reversible: lets us look the app back up from the
  // Cantila Project id after a control-plane restart wipes the cache.
  return `cantila-${project.id}`;
}

/** Heuristic — `ref` is a Docker image reference (registry/path[:tag])
 *  rather than a placeholder. We require either an explicit `:tag` or
 *  a registry host (something containing a `/`) so we don't accept a
 *  raw single-word string like "pending" by accident. */
function isImageRef(ref: string): boolean {
  if (!ref || ref === "coolify:pending") return false;
  // Path or registry-host pattern: foo/bar, ghcr.io/foo/bar, etc.
  if (ref.includes("/")) return true;
  // Or a bare name with a real tag — e.g. "nginx:1.27".
  if (/:[A-Za-z0-9._-]+$/.test(ref)) return true;
  return false;
}

/** Split a Docker image ref into (image, tag). Defaults the tag to
 *  `latest` when absent. Digest refs (`image@sha256:...`) are passed
 *  through as the image portion verbatim with `latest` as the tag —
 *  Coolify's docker_registry_image_tag field doesn't accept digests. */
function splitImageRef(ref: string): { image: string; tag: string } {
  // Strip protocol if the caller pasted a full URL by accident.
  const trimmed = ref.replace(/^https?:\/\//, "");
  // A digest separates with `@` — keep image as-is, tag falls back.
  if (trimmed.includes("@")) {
    return { image: trimmed.split("@")[0]!, tag: "latest" };
  }
  // Find the LAST colon — a registry host can contain colons in port
  // numbers (e.g. ghcr.io:443/foo/bar:tag). The tag is always the
  // segment after the final `/`-delimited path component's colon.
  const lastSlash = trimmed.lastIndexOf("/");
  const tail = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  const colon = tail.lastIndexOf(":");
  if (colon > 0) {
    const tag = tail.slice(colon + 1);
    const image = (lastSlash >= 0 ? trimmed.slice(0, lastSlash + 1) : "") +
      tail.slice(0, colon);
    return { image, tag };
  }
  return { image: trimmed, tag: "latest" };
}

function synthesiseMetrics(
  project: Project,
  liveStatus?: string,
): ProjectMetricSample[] {
  const SAMPLE_COUNT = 12;
  const INTERVAL_MS = 5_000;
  const now = Date.now();
  const seed = hashSeed(project.id);
  // Coolify is the source of truth for whether the container is up
  // when we have its status; otherwise fall back to the Cantila side.
  const effectiveStatus = mapCoolifyStatus(liveStatus) ?? project.status;
  const baseCpu =
    effectiveStatus === "live"
      ? 25 + (seed % 30)
      : effectiveStatus === "sleeping"
        ? 2 + (seed % 5)
        : 0;
  const baseRps =
    effectiveStatus === "live"
      ? 4 + (seed % 12)
      : effectiveStatus === "sleeping"
        ? 0.1 + (seed % 5) / 10
        : 0;
  const baseMem =
    effectiveStatus === "live" || effectiveStatus === "sleeping"
      ? 35 + (seed % 25)
      : 0;
  const out: ProjectMetricSample[] = [];
  for (let i = SAMPLE_COUNT - 1; i >= 0; i--) {
    const at = new Date(now - i * INTERVAL_MS).toISOString();
    if (
      effectiveStatus === "crashed" ||
      effectiveStatus === "paused" ||
      effectiveStatus === "provisioning" ||
      effectiveStatus === "building"
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

/** Translate a Coolify resource status string into the Cantila
 *  Project status vocabulary so `synthesiseMetrics` has one decision
 *  axis. Returns `undefined` when the input is unrecognised — the
 *  caller then uses the Cantila-side status instead. */
function mapCoolifyStatus(
  s: string | undefined,
): "live" | "sleeping" | "crashed" | "paused" | undefined {
  if (!s) return undefined;
  const lower = s.toLowerCase();
  if (lower.startsWith("running")) return "live";
  if (lower.startsWith("exited") || lower.startsWith("dead")) return "crashed";
  if (lower.startsWith("paused")) return "paused";
  if (lower.startsWith("restarting") || lower.startsWith("created"))
    return "sleeping";
  return undefined;
}

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
