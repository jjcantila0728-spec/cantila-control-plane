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

import { generateKeyPairSync, createPublicKey } from "node:crypto";
import type { Project, ProjectMetricSample, Region, Runtime } from "../domain/types";
import type { DataPlane, DeploySource } from "../deploy/pipeline";
import type { MetricsCollector } from "./metrics-collector";
import type { RpsCollector } from "./rps-collector";

/** Per-region Coolify panel binding (plan §19.8 multi-server). Phase 3
 *  uses one Coolify panel per region — this carries each panel's URL,
 *  token, server(s) and project uuid. The base options' `apiUrl` /
 *  `apiToken` act as defaults when a region entry omits them. */
export interface CoolifyRegionConfig {
  /** Optional override of the default `apiUrl` for this region.
   *  Set when a separate Coolify panel runs in this region. */
  apiUrl?: string;
  /** Optional override of the default `apiToken` for this region. */
  apiToken?: string;
  /** Coolify Server UUID for this region (single-node back-compat).
   *  Either this or `servers` must be set. */
  serverUuid?: string;
  /** Multiple Coolify Server UUIDs in this region (within-region
   *  multi-node, plan §19.8). When ≥ 2 are set, project-to-server
   *  binding is deterministic by `hash(project.id) % servers.length`
   *  — no extra bookkeeping, a control-plane restart still routes
   *  every project to the same server. Takes precedence over
   *  `serverUuid` when both are set. */
  servers?: string[];
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
  /** Optional real-metrics collector (plan §19.7). When wired,
   *  `sampleMetrics()` asks the collector first; on `null` or any
   *  failure it falls back to the existing status-aware synthesis.
   *  Today's implementation is `SshDockerStatsCollector` — SSH'ing to
   *  the Coolify host and reading `docker stats` filtered by
   *  Coolify's `coolify.applicationId` label. */
  metricsCollector?: MetricsCollector;
  /** Optional real-RPS collector (plan §19.7). Separate seam from
   *  `metricsCollector` because HTTP counters are a different
   *  transport / wire-shape from `docker stats`. Today's
   *  implementation is `TraefikRpsCollector` — Prometheus scrape
   *  of Coolify's bundled Traefik. */
  rpsCollector?: RpsCollector;
  /** Cantila Gitea base URL (e.g. https://git.cantila.app). When set
   *  together with `giteaToken`, `repoHost: "cantila"` projects deploy
   *  via Coolify's private-deploy-key flow (SSH + a per-project deploy
   *  key) instead of `/applications/public` — which mangles a
   *  self-hosted HTTPS URL into an unclonable `owner/repo` path. */
  giteaApiUrl?: string;
  /** Gitea admin token, used to register each project's deploy key on
   *  its repo. */
  giteaToken?: string;
}

/** Concrete per-project routing — apiUrl/apiToken/serverUuid/projectUuid
 *  all resolved with region overrides + defaults applied. Internal. */
interface ResolvedRegion {
  apiUrl: string;
  apiToken: string;
  serverUuid: string;
  projectUuid: string;
}

/** Region-level binding with multiple servers — `regionFor()` picks
 *  one per project deterministically and returns a `ResolvedRegion`. */
interface ResolvedRegionGroup {
  apiUrl: string;
  apiToken: string;
  /** Non-empty list of Coolify Server UUIDs in this region. */
  servers: string[];
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
   *  `defaultRegion`. Each entry can carry one or more servers
   *  (within-region multi-node, plan §19.8). */
  private readonly regions: ReadonlyMap<Region, ResolvedRegionGroup>;
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
  private readonly metricsCollector?: MetricsCollector;
  private readonly rpsCollector?: RpsCollector;
  private readonly giteaApiUrl?: string;
  private readonly giteaToken?: string;

  constructor(opts: CoolifyDataPlaneOptions) {
    this.defaultApiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.defaultApiToken = opts.apiToken;
    this.environmentName = opts.environmentName ?? "production";
    this.apexDomain = opts.apexDomain ?? "cantila.app";
    this.persistAppUuid = opts.persistAppUuid;
    this.metricsCollector = opts.metricsCollector;
    this.rpsCollector = opts.rpsCollector;
    this.giteaApiUrl = opts.giteaApiUrl?.replace(/\/+$/, "") || undefined;
    this.giteaToken = opts.giteaToken || undefined;

    const regions = new Map<Region, ResolvedRegionGroup>();
    if (opts.regions && Object.keys(opts.regions).length > 0) {
      for (const [region, cfg] of Object.entries(opts.regions) as [
        Region,
        CoolifyRegionConfig,
      ][]) {
        const servers = resolveRegionServers(cfg);
        if (servers.length === 0) {
          throw new Error(
            `CoolifyDataPlane: region "${region}" has no serverUuid / servers configured`,
          );
        }
        regions.set(region, {
          apiUrl: (cfg.apiUrl ?? this.defaultApiUrl).replace(/\/+$/, ""),
          apiToken: cfg.apiToken ?? this.defaultApiToken,
          servers,
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
        servers: [opts.serverUuid],
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

  /** Resolve the per-region routing for a project, picking one
   *  server from the region's group deterministically by
   *  `hash(project.id) % servers.length` so the same project always
   *  lands on the same node across control-plane restarts (plan
   *  §19.8 within-region multi-node). Falls back to `defaultRegion`
   *  when the project's region has no entry — that keeps the legacy
   *  single-region setup working unchanged. */
  private regionFor(project: Project): ResolvedRegion {
    const group =
      this.regions.get(project.region) ??
      this.regions.get(this.defaultRegion)!;
    const serverUuid =
      group.servers.length === 1
        ? group.servers[0]!
        : group.servers[hashSeed(project.id) % group.servers.length]!;
    return {
      apiUrl: group.apiUrl,
      apiToken: group.apiToken,
      serverUuid,
      projectUuid: group.projectUuid,
    };
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

    // Ensure the schema-migration hook is set BEFORE we redeploy, so the
    // tenant's Prisma schema is applied to its (freshly-provisioned, empty)
    // Postgres in this very deploy — otherwise the app boots against a
    // schema-less DB and every query throws P2021 ("table does not exist").
    await this.ensureMigrateHook(uuid, region);

    // Converge the Coolify build pack with the project's declared runtime.
    // Without this, an app created before the project was switched to
    // `runtime: docker` (or created by an older control plane that always
    // chose nixpacks) keeps building with Nixpacks forever — which turns a
    // Vite repo into a static Caddy site whose SPA fallback shadows /api/*.
    await this.ensureBuildPack(uuid, project, region);

    // Push env vars (best-effort — Coolify returns 200 even for already-set keys).
    await this.syncEnv(uuid, env, region, buildPackFor(project).build_pack);

    // Trigger a fresh deploy. For an existing app this is a redeploy that
    // rebuilds the image from source and rolls the container.
    const started = await this.request<CoolifyDeployStart>(
      "POST",
      `/deploy?uuid=${encodeURIComponent(uuid)}`,
      undefined,
      region,
    );

    // Coolify's /deploy is asynchronous — it queues a build and returns
    // immediately. Returning here made the pipeline's verify step probe
    // whatever container was ALREADY serving (the previous build), so a
    // failed build reported "verified"/live while the site silently kept
    // running old code. Await the real outcome: poll the deployment until
    // it finishes, fail loudly (with the build-log tail) when Coolify
    // reports failure, and only fall through on poll timeout — where the
    // old behaviour (health-check whatever is live) is the honest fallback.
    const coolifyDeployUuid = deployUuidFrom(started);
    if (coolifyDeployUuid) {
      await this.awaitDeployment(coolifyDeployUuid, region);
    }
  }

  async destroyApp(project: Project): Promise<void> {
    const region = this.regionFor(project);
    const uuid = await this.findAppUuid(project);
    if (!uuid) return; // nothing provisioned (or already gone) — no-op.
    // Delete the Coolify Application, cleaning up its container, volumes
    // and Traefik route. `cleanup=true` removes attached configurations.
    await this.request(
      "DELETE",
      `/applications/${encodeURIComponent(uuid)}?cleanup=true`,
      undefined,
      region,
    );
    // Drop the cache entry so a re-created project with the same id
    // doesn't resolve to the deleted app uuid.
    this.appUuids.delete(project.id);
  }

  /** Attach a custom hostname to the tenant's Coolify Application so its
   *  bundled Traefik routes the host and requests a Let's Encrypt cert
   *  (plan §22.6). Reads the app's current `fqdn`, appends the new host
   *  (idempotent — a host already present is a no-op merge), PATCHes the
   *  domain list, then redeploys so Traefik regenerates its routers with
   *  the new SNI and triggers the HTTP-01 challenge. The cert only issues
   *  once the customer's DNS (CNAME → `<slug>.cantila.app`) resolves to
   *  this server; the verify sweep flips `Domain.sslActive` when that
   *  round-trip succeeds. */
  async attachDomain(project: Project, hostname: string): Promise<void> {
    const host = hostname.trim().toLowerCase();
    const region = this.regionFor(project);
    const uuid = await this.findAppUuid(project);
    if (!uuid) {
      throw new Error(
        `attachDomain: no Coolify app provisioned for project ${project.id}`,
      );
    }
    // Read the current domain list so we don't clobber the free
    // *.cantila.app fqdn (or any previously-attached custom host).
    const app = await this.request<CoolifyApp>(
      "GET",
      `/applications/${encodeURIComponent(uuid)}`,
      undefined,
      region,
    );
    const domains = mergeFqdn(app.fqdn, `https://${host}`);
    await this.request(
      "PATCH",
      `/applications/${encodeURIComponent(uuid)}`,
      { domains },
      region,
    );
    // Redeploy so Coolify regenerates the Traefik labels — the new
    // router (and its on-demand ACME cert request) only exists after the
    // proxy config is rewritten with the updated domain set.
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
    // Retry with backoff: a container that just rolled can take seconds to
    // accept connections (cold runtime boot, Traefik router refresh), and a
    // single 5s probe was marking legitimately-healthy deploys "crashed".
    // ~22s worst case across 4 attempts; first success returns immediately.
    const waitsMs = [0, 2_000, 5_000, 10_000];
    for (const wait of waitsMs) {
      if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
      try {
        const res = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) return true;
      } catch {
        /* transient — retry */
      }
    }
    return false;
  }

  /** Explain a failed health check: the container's Coolify status (e.g.
   *  `exited`, `running:unhealthy`) plus a tail of its runtime logs, so the
   *  deploy records WHY instead of a bare "verify-failed". Always returns a
   *  string (at minimum naming the unreachable URL); the status/log lookups
   *  are best-effort and silently omitted when unavailable. */
  async diagnoseCrash(
    project: Project,
    url: string,
  ): Promise<string | undefined> {
    const parts: string[] = [`health check got no 200 from ${url}`];
    const status = await this.fetchResourceStatus(project).catch(
      () => undefined,
    );
    if (status) parts.push(`container status=${status}`);
    const uuid =
      this.appUuids.get(project.id) ?? project.coolifyAppUuid ?? undefined;
    if (uuid) {
      const logs = await this.fetchAppLogs(uuid, this.regionFor(project)).catch(
        () => undefined,
      );
      if (logs) parts.push(`logs: ${logs}`);
    }
    return parts.join(" · ");
  }

  /** Best-effort tail of a Coolify application's runtime container logs.
   *  Returns undefined when the endpoint is unavailable or returns nothing
   *  — crash diagnosis must never depend on it. */
  private async fetchAppLogs(
    appUuid: string,
    region: ResolvedRegion,
  ): Promise<string | undefined> {
    try {
      const res = await this.request<{ logs?: string } | string>(
        "GET",
        `/applications/${encodeURIComponent(appUuid)}/logs?lines=100`,
        undefined,
        region,
      );
      const raw = typeof res === "string" ? res : (res?.logs ?? "");
      const tail = String(raw)
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(-12)
        .join(" | ");
      return tail.slice(0, 800) || undefined;
    } catch {
      return undefined;
    }
  }

  async sampleMetrics(project: Project): Promise<ProjectMetricSample[]> {
    // Two-tier read:
    //   1. `metricsCollector` (when wired) returns a real CPU/memory
    //      reading sampled from the container — today via SSH +
    //      `docker stats`. The reading replaces the latest synthesis
    //      sample so gauges + ScaleAgent see ground truth; the
    //      preceding samples in the returned series still smooth-jitter
    //      around the reading so the sparkline doesn't look like a flat
    //      line on every poll.
    //   2. Status-aware synthesis falls in when the collector returns
    //      `null` (unconfigured, no running replicas, transport
    //      failure). Coolify v4's public REST does not expose per-app
    //      or per-server CPU/memory series — both
    //      `/applications/{uuid}/metrics` and
    //      `/servers/{uuid}/metrics` 404 even with metrics enabled
    //      (probed against the live Coolify on 2026-05-28). The
    //      synthesis path is the honest "we still don't know" output.
    //
    // RPS is still synthesised in both branches — `docker stats`
    // doesn't carry HTTP counters, and Coolify's bundled Traefik
    // doesn't expose per-router metrics through the v4 REST API
    // either. A node_exporter / Traefik-metrics drop unblocks that
    // independently; the collector seam stays the same.
    const liveStatus = await this.fetchResourceStatus(project).catch(
      () => undefined,
    );
    const appUuid =
      this.appUuids.get(project.id) ?? project.coolifyAppUuid ?? undefined;
    const appName = appNameFor(project);

    // CPU/memory reading (SSH `docker stats`) and RPS reading
    // (Traefik /metrics) are fetched in parallel — both target the
    // same Coolify host and the data plane is on the metrics-API
    // request path, so a serial call would double the latency.
    const [metricsReading, rpsReading] = await Promise.all([
      this.metricsCollector && appUuid
        ? this.metricsCollector
            .collect({ appUuid, appName, region: project.region })
            .catch(() => null)
        : Promise.resolve(null),
      this.rpsCollector && appUuid
        ? this.rpsCollector
            .collect({ appUuid, appName, region: project.region })
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    return synthesiseMetrics(project, liveStatus, metricsReading, rpsReading);
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
        ports_exposes: String(project.appPort ?? 3000),
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

    // Cantila-hosted Gitea repo: Coolify's `/applications/public` mangles a
    // self-hosted HTTPS URL into an unclonable `owner/repo` path, so we use
    // the private-deploy-key (SSH) flow — register a per-project deploy key
    // on the Gitea repo + in Coolify, then create the app pointing at the
    // scp-style SSH URL (which Coolify stores verbatim).
    if (
      project.repoHost === "cantila" &&
      project.repoUrl &&
      this.giteaApiUrl &&
      this.giteaToken
    ) {
      return this.createCantilaGitApp(project, region, name, fqdn);
    }

    if (project.repoUrl) {
      // Public git deploy (GitHub etc.). `runtime: docker` projects build
      // their repo-root Dockerfile verbatim; everything else goes through
      // Nixpacks. Nixpacks must never see a docker-runtime project — it
      // ignores Dockerfiles and turns SPA repos into static Caddy sites
      // whose fallback shadows the app's own /api/* routes.
      const body = {
        project_uuid: region.projectUuid,
        server_uuid: region.serverUuid,
        environment_name: this.environmentName,
        name,
        git_repository: project.repoUrl,
        git_branch: project.branch ?? "main",
        ...buildPackFor(project),
        ports_exposes: portsExposesFor(project),
        ...(await this.domainFields(project, fqdn)),
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

  /** Create a Coolify app for a Cantila-hosted (Gitea) repo.
   *
   *  Coolify's `/applications/public` mangles a self-hosted HTTPS URL into
   *  an unclonable `owner/repo` path; its `/applications/private-deploy-key`
   *  endpoint stores `git_repository` verbatim. We therefore use the
   *  deploy-key endpoint but point it at an **HTTPS clone URL with an
   *  embedded token** — cloning over HTTPS (the same transport the
   *  control-plane already uses for the Gitea API) sidesteps the host's
   *  SSH server entirely (git.cantila.app:22 is the host's OpenSSH, not
   *  Gitea's key-only SSH, so SSH deploy keys can't authenticate there).
   *  The endpoint still requires a `private_key_uuid`, so we register a
   *  throwaway key purely to satisfy it; the HTTPS URL is what actually
   *  authenticates the clone. */
  private async createCantilaGitApp(
    project: Project,
    region: ResolvedRegion,
    name: string,
    fqdn: string,
  ): Promise<string> {
    const parsed = parseGiteaRepo(project.repoUrl!);
    if (!parsed) {
      throw new Error(`cannot parse Cantila repo URL: ${project.repoUrl}`);
    }
    const { host, owner, repo } = parsed;
    // Token-authenticated HTTPS clone URL. Coolify redacts URLs in its
    // deploy logs; the token lives only in the trusted Coolify app config.
    const httpsUrl = `https://oauth2:${this.giteaToken}@${host}/${owner}/${repo}.git`;

    // The deploy-key endpoint requires a private_key_uuid; register a
    // throwaway key to satisfy it (unused — the clone goes over HTTPS).
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    const key = await this.request<{ uuid: string }>(
      "POST",
      "/security/keys",
      { name: `cantila-${project.id}`, private_key: privateKey as string },
      region,
    );

    const created = await this.request<{ uuid: string }>(
      "POST",
      "/applications/private-deploy-key",
      {
        project_uuid: region.projectUuid,
        server_uuid: region.serverUuid,
        environment_name: this.environmentName,
        name,
        private_key_uuid: key.uuid,
        git_repository: httpsUrl,
        git_branch: project.branch ?? "main",
        ...buildPackFor(project),
        ports_exposes: portsExposesFor(project),
        ...(await this.domainFields(project, fqdn)),
        instant_deploy: false,
      },
      region,
    );
    return created.uuid;
  }

  /** Create-body fragment that wires the project's free *.cantila.app fqdn
   *  to its Coolify app. Single-container apps take Coolify's `domains`
   *  field; docker-compose apps must use `docker_compose_domains` keyed by
   *  the compose service (Coolify 422s on `domains` for compose). When the
   *  service can't be resolved we create without a domain rather than fail
   *  the whole deploy. */
  private async domainFields(
    project: Project,
    fqdn: string,
  ): Promise<Record<string, unknown>> {
    const buildPack = buildPackFor(project).build_pack;
    if (buildPack !== "dockercompose") return { domains: fqdn };
    const composeService = await this.resolveComposeService(project);
    if (!composeService) {
      console.warn(
        `[coolify] ${project.id}: docker-compose app — could not resolve a ` +
          `web service to map ${fqdn} to; creating without a domain (attach ` +
          `it from the Console). Coolify rejects 'domains' for compose apps.`,
      );
    }
    return domainCreateFields({ buildPack, fqdn, composeService });
  }

  /** The compose service the project's domain should map to. Only resolvable
   *  for Cantila-hosted (Gitea) repos, whose compose file we can read over
   *  the Gitea API. Returns null otherwise (e.g. a GitHub compose repo) —
   *  the app then deploys without an auto-attached domain. */
  private async resolveComposeService(
    project: Project,
  ): Promise<string | null> {
    if (
      project.repoHost !== "cantila" ||
      !project.repoUrl ||
      !this.giteaApiUrl ||
      !this.giteaToken
    ) {
      return null;
    }
    const parsed = parseGiteaRepo(project.repoUrl);
    if (!parsed) return null;
    const branch = project.branch ?? "main";
    for (const path of [
      "docker-compose.yml",
      "docker-compose.yaml",
      "compose.yml",
      "compose.yaml",
    ]) {
      const raw = await this.fetchGiteaRaw(
        parsed.owner,
        parsed.repo,
        branch,
        path,
      ).catch(() => null);
      const svc = raw ? firstComposeService(raw) : null;
      if (svc) return svc;
    }
    return null;
  }

  /** Fetch a single file from a Cantila-hosted Gitea repo (raw bytes).
   *  Returns null on any non-200 so callers can probe alternative paths. */
  private async fetchGiteaRaw(
    owner: string,
    repo: string,
    ref: string,
    path: string,
  ): Promise<string | null> {
    const res = await fetch(
      `${this.giteaApiUrl}/api/v1/repos/${owner}/${repo}/raw/${path}?ref=${encodeURIComponent(ref)}`,
      { headers: { Authorization: `token ${this.giteaToken}` } },
    );
    if (!res.ok) return null;
    return res.text();
  }

  /** Add a read-only deploy key to a Gitea repo. Tolerates 422 (already set). */
  private async addGiteaDeployKey(
    owner: string,
    repo: string,
    publicKey: string,
    title: string,
  ): Promise<void> {
    const res = await fetch(
      `${this.giteaApiUrl}/api/v1/repos/${owner}/${repo}/keys`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${this.giteaToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ title, key: publicKey, read_only: true }),
      },
    );
    if (!res.ok && res.status !== 422) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Gitea add deploy key → ${res.status}: ${text.slice(0, 300)}`,
      );
    }
  }

  /** (Re)assert the Coolify `pre_deployment_command` that applies the
   *  tenant's Prisma schema to its database before the new container
   *  serves traffic. Runs inside a container of the freshly-built image
   *  (so `prisma`, the schema and `DATABASE_URL` are all present):
   *    - no Prisma in the repo            → no-op (the `if` exits 0);
   *    - schema + committed migrations     → `prisma migrate deploy`;
   *    - schema only (AI-generated apps)   → `prisma db push` creates it.
   *  Idempotent: set on every deploy so both new and pre-existing apps
   *  converge. Best-effort — a failure to set the hook must not abort an
   *  otherwise-valid deploy (the app is no worse off than before), but it
   *  is the primary mechanism, so we surface failures to telemetry. */
  private async ensureMigrateHook(
    appUuid: string,
    region: ResolvedRegion,
  ): Promise<void> {
    try {
      await this.request(
        "PATCH",
        `/applications/${encodeURIComponent(appUuid)}`,
        { pre_deployment_command: MIGRATE_PREDEPLOY_COMMAND },
        region,
      );
    } catch (err) {
      // Don't fail the deploy because the bookkeeping PATCH failed.
      console.warn(
        `[coolify] failed to set migrate pre_deployment_command on ${appUuid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Make the Coolify app's build pack reflect `project.runtime`.
   *  `runtime: docker` → Coolify's `dockerfile` build pack (builds the
   *  repo-root Dockerfile exactly as written); anything else keeps
   *  Nixpacks. Idempotent — PATCHed on every deploy so existing apps
   *  converge after a runtime change. Best-effort like the migrate hook:
   *  a bookkeeping failure must not abort an otherwise-valid deploy. */
  private async ensureBuildPack(
    appUuid: string,
    project: Project,
    region: ResolvedRegion,
  ): Promise<void> {
    // Only PATCH when we know better than the created default: a stack
    // detection result persisted on the project, or the legacy
    // runtime:docker rule. Plain legacy projects stay untouched.
    if (!project.buildPack && project.runtime !== "docker") return;
    try {
      await this.request(
        "PATCH",
        `/applications/${encodeURIComponent(appUuid)}`,
        { ...buildPackFor(project), ports_exposes: portsExposesFor(project) },
        region,
      );
    } catch (err) {
      console.warn(
        `[coolify] failed to set build_pack on ${appUuid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Poll a Coolify deployment until it reaches a terminal state.
   *  Throws on `failed`/`cancelled` with the build-log tail so the
   *  pipeline (and ultimately the operator) sees WHY the build broke
   *  instead of a misleading "live" pointing at the previous container.
   *  On poll timeout (Coolify still building) it returns silently — the
   *  pipeline's verify step then reports against whatever is serving,
   *  which is the pre-existing behaviour and the honest fallback while
   *  the build finishes in the background. */
  private async awaitDeployment(
    deploymentUuid: string,
    region: ResolvedRegion,
    timeoutMs = 240_000,
    pollMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let dep: CoolifyDeployment;
      try {
        dep = await this.request<CoolifyDeployment>(
          "GET",
          `/deployments/${encodeURIComponent(deploymentUuid)}`,
          undefined,
          region,
        );
      } catch (err) {
        // Endpoint missing / transient error — don't block the deploy on
        // observability. Fall back to fire-and-forget semantics.
        console.warn(
          `[coolify] cannot poll deployment ${deploymentUuid}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      const status = (dep.status ?? "").toLowerCase();
      if (status === "finished") return;
      if (status === "failed" || status === "cancelled") {
        throw new Error(
          `Coolify build ${status}: ${tailOfBuildLogs(dep.logs)}`,
        );
      }
      await new Promise<void>((r) => setTimeout(r, pollMs));
    }
    console.warn(
      `[coolify] deployment ${deploymentUuid} still running after ${
        timeoutMs / 1000
      }s — verify will probe the currently-serving container`,
    );
  }

  private async syncEnv(
    appUuid: string,
    env: Record<string, string>,
    region: ResolvedRegion,
    buildPack?: string,
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

    // Build-time vars: keep Nixpacks from dropping devDependencies under its
    // default NODE_ENV=production (else typescript/webpack/vite are missing
    // at compile time and the build fails). is_build_time:true so they apply
    // during the build only, not at runtime.
    for (const [key, value] of Object.entries(nixpacksBuildEnv(buildPack ?? ""))) {
      data.push({
        key,
        value,
        is_preview: false,
        is_build_time: true,
        is_literal: true,
      });
    }

    // Merge the platform-level claude.ai subscription token so every Coolify
    // app (new or redeployed) inherits it automatically — no manual edit
    // needed. Injected with is_literal:false: Coolify wraps is_literal:true
    // values in single quotes that reach the container as part of the value
    // (verified), which would corrupt the Bearer token and 401 every call.
    // The token has no shell-special characters, so non-literal is safe.
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      data.push({
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        value: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        is_preview: false,
        is_build_time: false,
        is_literal: false,
      });
    }

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

/** Coolify's POST /deploy response. Two shapes exist in the wild:
 *  v4 ≥4.0.0-beta returns `{ deployments: [{ resource_uuid,
 *  deployment_uuid, message }] }`; some builds return a flat
 *  `{ deployment_uuid }`. */
interface CoolifyDeployStart {
  deployment_uuid?: string;
  deployments?: { deployment_uuid?: string }[];
}

interface CoolifyDeployment {
  /** "queued" | "in_progress" | "finished" | "failed" | "cancelled" */
  status?: string;
  /** JSON-encoded array of { output, type, hidden } lines. */
  logs?: string;
}

/** Pull the deployment uuid out of either /deploy response shape. */
function deployUuidFrom(started: CoolifyDeployStart): string | undefined {
  return (
    started.deployment_uuid ??
    started.deployments?.find((d) => d.deployment_uuid)?.deployment_uuid
  );
}

/** Coolify build pack fields for a project. The stack detection result
 *  persisted by `bootstrapGit`/`connectGit` (`project.buildPack`) wins —
 *  it saw the actual repo tree. The legacy `runtime:docker` rule covers
 *  rows from before detection existed; everything else is Nixpacks.
 *  Spread into app-create bodies and mirrored by `ensureBuildPack`. */
function buildPackFor(project: Project): {
  build_pack: string;
  dockerfile_location?: string;
} {
  const pack =
    project.buildPack ??
    (project.runtime === "docker" ? "dockerfile" : "nixpacks");
  return pack === "dockerfile"
    ? { build_pack: "dockerfile", dockerfile_location: "/Dockerfile" }
    : { build_pack: pack };
}

/** Container port Coolify should expose for a project. Detection
 *  persists `appPort`; legacy rows keep the historical defaults
 *  (3000, or 80 for static builds). */
function portsExposesFor(project: Project): string {
  const pack = buildPackFor(project).build_pack;
  return String(project.appPort ?? (pack === "static" ? 80 : 3000));
}

/** Coolify rejects the `domains` field for docker-compose apps — domains
 *  must be set per-service via `docker_compose_domains`
 *  (`[{ name, domain }]`). Returns the create-body fragment that wires the
 *  project's free *.cantila.app fqdn:
 *    - non-compose build packs   → `{ domains }` (single container);
 *    - compose + resolved service → `{ docker_compose_domains }`;
 *    - compose + unknown service  → `{}` — still un-breaks the create
 *      (sending `domains` 422'd: "The domains field cannot be used for
 *      dockercompose applications"). The caller logs that the domain must
 *      be attached separately. */
export function domainCreateFields(args: {
  buildPack: string;
  fqdn: string;
  composeService: string | null;
}): Record<string, unknown> {
  if (args.buildPack !== "dockercompose") return { domains: args.fqdn };
  if (args.composeService) {
    return {
      docker_compose_domains: [
        { name: args.composeService, domain: args.fqdn },
      ],
    };
  }
  return {};
}

/** First web-facing service in a docker-compose file: the first top-level
 *  `services:` entry that publishes ports, else the first service. Minimal
 *  indentation scan — no YAML dependency, tolerant of comments and blank
 *  lines. Returns null when no services block parses. */
export function firstComposeService(yaml: string): string | null {
  const lines = yaml.split(/\r?\n/).map((l) => l.replace(/\t/g, "  "));
  let servicesIndent = -1; // indent of the `services:` key
  let serviceIndent = -1; // indent of service-name keys (one level in)
  let current: string | null = null;
  const services: { name: string; hasPorts: boolean }[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    if (servicesIndent === -1) {
      if (/^services\s*:/.test(trimmed)) servicesIndent = indent;
      continue;
    }
    // dedent back to/above `services:` ends the block
    if (indent <= servicesIndent) break;

    if (serviceIndent === -1) serviceIndent = indent;
    if (indent === serviceIndent) {
      current = trimmed.replace(/:.*$/, "").trim();
      if (current) services.push({ name: current, hasPorts: false });
    } else if (current && /^ports\s*:/.test(trimmed)) {
      const svc = services.find((s) => s.name === current);
      if (svc) svc.hasPorts = true;
    }
  }

  if (services.length === 0) return null;
  return (services.find((s) => s.hasPorts) ?? services[0]!).name;
}

/** Build-time env vars that stop Nixpacks/npm/yarn from skipping
 *  devDependencies under their default NODE_ENV=production — without these,
 *  build tools declared as devDependencies (typescript, webpack, vite…) are
 *  absent at compile time and the build fails. Empty for non-Nixpacks build
 *  packs (Dockerfile / compose own their installs). */
export function nixpacksBuildEnv(buildPack: string): Record<string, string> {
  if (buildPack !== "nixpacks") return {};
  return { NPM_CONFIG_PRODUCTION: "false", YARN_PRODUCTION: "false" };
}

/** Last ~20 visible lines of a Coolify deployment's JSON-encoded logs,
 *  flattened for an error message. Tolerates unparseable input. */
function tailOfBuildLogs(logs: string | undefined): string {
  if (!logs) return "(no build logs)";
  try {
    const lines = (JSON.parse(logs) as { output?: string; hidden?: boolean }[])
      .filter((l) => l && !l.hidden && l.output)
      .map((l) => String(l.output).trimEnd());
    return lines.slice(-20).join(" | ").slice(0, 1500) || "(empty build logs)";
  } catch {
    return logs.slice(-1500);
  }
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

/** Parse a Cantila Gitea clone URL into host/owner/repo (repo without .git). */
function parseGiteaRepo(
  url: string,
): { host: string; owner: string; repo: string } | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/^\/+/, "").split("/");
    if (parts.length < 2) return null;
    const owner = parts[0]!;
    const repo = parts[1]!.replace(/\.git$/, "");
    if (!owner || !repo) return null;
    return { host: u.host, owner, repo };
  } catch {
    return null;
  }
}

/** Encode an RSA public key (SPKI PEM) as an OpenSSH `ssh-rsa AAAA...` line. */
function sshRsaFromPublicPem(pem: string): string {
  const jwk = createPublicKey(pem).export({ format: "jwk" }) as {
    n: string;
    e: string;
  };
  const blob = Buffer.concat([
    sshField(Buffer.from("ssh-rsa")),
    sshField(mpint(Buffer.from(jwk.e, "base64url"))),
    sshField(mpint(Buffer.from(jwk.n, "base64url"))),
  ]);
  return `ssh-rsa ${blob.toString("base64")}`;
}

/** Length-prefixed (uint32 BE) SSH wire field. */
function sshField(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

/** SSH mpint: prepend 0x00 when the high bit is set (values are signed). */
function mpint(buf: Buffer): Buffer {
  if (buf.length > 0 && (buf[0]! & 0x80) !== 0) {
    return Buffer.concat([Buffer.from([0x00]), buf]);
  }
  return buf;
}

/** Shell run inside a one-off container of the built image, before the
 *  new container goes live, on every deploy. Guarded so non-Prisma apps
 *  are a clean no-op; prefers committed migrations and falls back to
 *  `db push` for apps that ship only a schema (typical of AI-generated
 *  projects). `--accept-data-loss` is required for non-interactive
 *  `db push`; on a fresh, empty database it only ever creates tables. */
const MIGRATE_PREDEPLOY_COMMAND =
  "sh -c 'if [ -f prisma/schema.prisma ]; then " +
  "if [ -d prisma/migrations ]; then npx --yes prisma migrate deploy; " +
  "else npx --yes prisma db push --accept-data-loss --skip-generate; fi; fi'";

/** Merge a hostname URL into a Coolify comma-separated `fqdn` list,
 *  trimming trailing slashes and de-duplicating so attach is idempotent.
 *  Coolify stores domains as `https://a.com,https://b.com`. */
function mergeFqdn(existing: string | undefined, add: string): string {
  const norm = (s: string) => s.trim().replace(/\/+$/, "");
  const set = new Set(
    (existing ?? "").split(",").map(norm).filter(Boolean),
  );
  set.add(norm(add));
  return [...set].join(",");
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
  reading?: { cpuPct: number; memPct: number; replicas: number } | null,
  rpsReading?: { rps: number } | null,
): ProjectMetricSample[] {
  const SAMPLE_COUNT = 12;
  const INTERVAL_MS = 5_000;
  const now = Date.now();
  const seed = hashSeed(project.id);
  // Coolify is the source of truth for whether the container is up
  // when we have its status; otherwise fall back to the Cantila side.
  const effectiveStatus = mapCoolifyStatus(liveStatus) ?? project.status;
  // When a real reading is available, anchor CPU + memory to it so
  // gauges + ScaleAgent see ground truth on the latest sample. The
  // historical samples still smooth around it so the sparkline reads
  // like a series, not a single dot.
  const baseCpu = reading
    ? reading.cpuPct
    : effectiveStatus === "live"
      ? 25 + (seed % 30)
      : effectiveStatus === "sleeping"
        ? 2 + (seed % 5)
        : 0;
  // Anchor RPS to the real Traefik reading when available; otherwise
  // fall back to the status-derived baseline. A reading of exactly 0
  // is still a real measurement (the app is up but idle), so we
  // accept zero through the conditional rather than degrading to
  // synthesis.
  const baseRps = rpsReading
    ? rpsReading.rps
    : effectiveStatus === "live"
      ? 4 + (seed % 12)
      : effectiveStatus === "sleeping"
        ? 0.1 + (seed % 5) / 10
        : 0;
  const baseMem = reading
    ? reading.memPct
    : effectiveStatus === "live" || effectiveStatus === "sleeping"
      ? 35 + (seed % 25)
      : 0;
  const out: ProjectMetricSample[] = [];
  for (let i = SAMPLE_COUNT - 1; i >= 0; i--) {
    const at = new Date(now - i * INTERVAL_MS).toISOString();
    // Without a real reading, a "down" status zeroes everything.
    // With a real reading, we trust the container — `docker stats`
    // only emits a row when the container is running, so a reading
    // implies live.
    if (
      !reading &&
      (effectiveStatus === "crashed" ||
        effectiveStatus === "paused" ||
        effectiveStatus === "provisioning" ||
        effectiveStatus === "building")
    ) {
      out.push({ at, cpuPct: 0, memPct: 0, rps: 0 });
      continue;
    }
    const jitter = (Math.random() - 0.5) * 0.2;
    // The newest sample (i === 0) lands exactly on the real reading
    // when present — no jitter — so the Console gauge and the
    // /metrics endpoint match what the operator would see on the
    // host directly. The older samples get smooth-jitter.
    const cpuJ = i === 0 && reading ? 0 : jitter;
    const memJ = i === 0 && reading ? 0 : jitter * 0.5;
    // Newest sample anchors to the real Traefik RPS (no jitter) when
    // a reading is present; older samples smooth around it like CPU
    // + memory do.
    const rpsJ = i === 0 && rpsReading ? 0 : jitter;
    out.push({
      at,
      cpuPct: Math.round(clamp(baseCpu * (1 + cpuJ), 0, 100) * 10) / 10,
      memPct: Math.round(clamp(baseMem * (1 + memJ), 0, 100) * 10) / 10,
      rps: Math.round(Math.max(0, baseRps * (1 + rpsJ)) * 10) / 10,
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

/** Collapse the (possibly redundant) single-server + multi-server
 *  fields on a `CoolifyRegionConfig` into one deduped, ordered list.
 *  `servers` wins when both are set (the explicit-multi form); a lone
 *  `serverUuid` becomes a single-element list (back-compat). */
function resolveRegionServers(cfg: CoolifyRegionConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string | undefined) => {
    const t = s?.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  if (cfg.servers && cfg.servers.length > 0) {
    for (const s of cfg.servers) add(s);
  } else if (cfg.serverUuid) {
    add(cfg.serverUuid);
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
