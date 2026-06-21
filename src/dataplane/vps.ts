/* ============================================================
   VpsDataPlane — deploy directly to a VPS over SSH + Docker,
   with no Coolify (plan 2026-06-18 §Stage 2).

   The image is built OFF the box by the shared ImageBuilder and
   pushed to a registry; this adapter only ever SSHes in to
   `docker pull` + `docker run` the container, wiring Traefik
   routing via container labels. Routing/TLS is handled by a
   standalone Traefik on the VPS (the same Let's Encrypt HTTP-01
   flow Coolify used) listening on the shared docker network.

   Selected by `CANTILA_DATAPLANE=vps`. The Coolify adapter stays
   available as instant rollback (flip the env back).

   All side effects go through an injected `SshRunner`, so the
   whole lifecycle is unit-testable without a real host. The
   command-assembly helpers are pure + exported for direct testing.
   ============================================================ */

import type { Project, ProjectMetricSample, Runtime } from "../domain/types";
import type { DataPlane, DeploySource } from "../deploy/pipeline";
import type { ImageBuilder } from "../deploy/image-builder";
import type { SshTarget } from "./ssh-docker-stats";
import type { SshRunner } from "./ssh-exec";
import { synthesiseMetrics, hashSeed } from "./metrics-synth";

export interface VpsRegistryAuth {
  url: string;
  user?: string;
  password?: string;
}

export interface VpsDataPlaneOptions {
  /** One or more VPS hosts. A project is pinned to one deterministically by
   *  `hash(project.id) % nodes.length` so restarts route it to the same box. */
  nodes: SshTarget[];
  /** Injected remote-exec. `systemSshRunner()` in production. */
  ssh: SshRunner;
  /** Off-box image builder — produces the registry image the VPS pulls. */
  imageBuilder: ImageBuilder;
  /** Apex for auto-assigned hostnames, default `cantila.app`. */
  apexDomain?: string;
  /** Docker network Traefik + app containers share, default `cantila`. */
  network?: string;
  /** Traefik entrypoint for HTTPS, default `websecure`. */
  entrypoint?: string;
  /** Traefik ACME cert resolver name, default `le`. */
  certResolver?: string;
  /** Registry login run on the box before pulling a private image. */
  registry?: VpsRegistryAuth;
}

export class VpsDataPlane implements DataPlane {
  private readonly nodes: SshTarget[];
  private readonly ssh: SshRunner;
  private readonly imageBuilder: ImageBuilder;
  private readonly apexDomain: string;
  private readonly network: string;
  private readonly entrypoint: string;
  private readonly certResolver: string;
  private readonly registry?: VpsRegistryAuth;

  constructor(opts: VpsDataPlaneOptions) {
    if (!opts.nodes || opts.nodes.length === 0) {
      throw new Error("VpsDataPlane: at least one node is required");
    }
    this.nodes = opts.nodes;
    this.ssh = opts.ssh;
    this.imageBuilder = opts.imageBuilder;
    this.apexDomain = opts.apexDomain ?? "cantila.app";
    this.network = opts.network ?? "cantila";
    this.entrypoint = opts.entrypoint ?? "websecure";
    this.certResolver = opts.certResolver ?? "le";
    this.registry = opts.registry;
  }

  async detectStack(source: DeploySource): Promise<Runtime> {
    return source.kind === "upload" ? "docker" : "node";
  }

  async buildImage(
    project: Project,
    source: DeploySource,
  ): Promise<{ imageRef: string }> {
    if (source.kind === "git" && project.repoUrl) {
      const built = await this.imageBuilder.build({ project, ref: source.ref });
      if (built) return built;
      // No Coolify fall-back on the VPS plane — the builder is the only way
      // to turn a repo into a runnable image. Surface a clear, actionable
      // failure (the pipeline records it as build-failed).
      throw new Error(
        `VpsDataPlane: the image builder declined to build ${project.id} ` +
          `(docker-compose or an unsupported stack). Add a Dockerfile or ` +
          `push a prebuilt image.`,
      );
    }
    if (source.kind === "upload" && source.ref && isImageRef(source.ref)) {
      return { imageRef: source.ref };
    }
    throw new Error(
      "VpsDataPlane: no buildable repo and no prebuilt image to deploy",
    );
  }

  async schedule(project: Project): Promise<{ nodeId: string }> {
    return { nodeId: this.nodeFor(project).host };
  }

  async startContainer(
    project: Project,
    imageRef: string,
    _nodeId: string,
    env: Record<string, string>,
  ): Promise<void> {
    const node = this.nodeFor(project);
    const cmd = buildRunCommand({
      container: containerName(project),
      imageRef,
      env,
      hosts: [this.hostFor(project)],
      network: this.network,
      entrypoint: this.entrypoint,
      certResolver: this.certResolver,
      port: project.appPort ?? 3000,
      registry: this.registry,
    });
    await this.ssh.run(node, cmd);
  }

  async route(project: Project): Promise<{ url: string }> {
    return { url: `https://${this.hostFor(project)}` };
  }

  async runMigration(
    project: Project,
    imageRef: string,
    env: Record<string, string>,
  ): Promise<{ ok: boolean; log?: string }> {
    const node = this.nodeFor(project);
    const cmd = buildMigrateCommand({ imageRef, env, registry: this.registry });
    try {
      const out = await this.ssh.run(node, cmd);
      return { ok: true, log: tail(out) };
    } catch (err) {
      return { ok: false, log: err instanceof Error ? err.message : String(err) };
    }
  }

  async destroyApp(project: Project): Promise<void> {
    const node = this.nodeFor(project);
    await this.ssh
      .run(node, `docker rm -f ${containerName(project)}`)
      .catch(() => {
        /* best-effort by contract — a stale container must not block removal */
      });
  }

  async attachDomain(project: Project, hostname: string): Promise<void> {
    const node = this.nodeFor(project);
    const cn = containerName(project);
    // Inspect the running container so we can re-run it with the same image +
    // env and the merged host set (Traefik routers come from labels, so a new
    // host means re-creating the container with an updated rule).
    const raw = await this.ssh.run(
      node,
      `docker inspect ${cn} --format '{{json .}}'`,
    );
    const info = parseInspect(raw);
    if (!info) {
      throw new Error(`attachDomain: cannot inspect container ${cn}`);
    }
    const hosts = mergeHosts(
      [this.hostFor(project), ...info.hosts],
      hostname.trim().toLowerCase(),
    );
    const cmd = buildRunCommand({
      container: cn,
      imageRef: info.image,
      env: info.env,
      hosts,
      network: this.network,
      entrypoint: this.entrypoint,
      certResolver: this.certResolver,
      port: project.appPort ?? 3000,
      registry: this.registry,
    });
    await this.ssh.run(node, cmd);
  }

  async healthCheck(url: string): Promise<boolean> {
    // Same backoff probe as the Coolify plane — a freshly-rolled container
    // can take a few seconds to accept connections + for Traefik to refresh.
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

  async diagnoseCrash(
    project: Project,
    url: string,
  ): Promise<string | undefined> {
    const node = this.nodeFor(project);
    const cn = containerName(project);
    const parts: string[] = [`health check got no 200 from ${url}`];
    const status = await this.ssh
      .run(
        node,
        `docker inspect ${cn} --format '{{.State.Status}} exit={{.State.ExitCode}}'`,
      )
      .catch(() => undefined);
    if (status?.trim()) parts.push(`container ${status.trim()}`);
    const logs = await this.ssh
      .run(node, `docker logs --tail 30 ${cn} 2>&1`)
      .catch(() => undefined);
    if (logs?.trim()) {
      const t = logs
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(-12)
        .join(" | ")
        .slice(0, 800);
      if (t) parts.push(`logs: ${t}`);
    }
    return parts.join(" · ");
  }

  async sampleMetrics(project: Project): Promise<ProjectMetricSample[]> {
    // Read the real container status (so a stopped container reports 0)
    // and synthesise the CPU/memory/RPS window around it — Coolify's
    // SSH/Traefik collectors key off Coolify labels these containers don't
    // carry, so we don't reuse them here.
    const status = await this.ssh
      .run(
        this.nodeFor(project),
        `docker inspect ${containerName(project)} --format '{{.State.Status}}'`,
      )
      .then((s) => s.trim())
      .catch(() => undefined);
    return synthesiseMetrics(project, status);
  }

  // -- private helpers --------------------------------------------------

  private nodeFor(project: Project): SshTarget {
    return this.nodes.length === 1
      ? this.nodes[0]!
      : this.nodes[hashSeed(project.id) % this.nodes.length]!;
  }

  private hostFor(project: Project): string {
    return `${project.slug}.${this.apexDomain}`;
  }
}

/* ---- pure command-assembly helpers (exported for testing) ---- */

/** Deterministic, reversible container name — lets us look the container
 *  back up by Cantila project id after a control-plane restart. */
export function containerName(project: Pick<Project, "id">): string {
  return `cantila-${project.id}`;
}

/** Prisma schema-apply command, run in a one-off container of the built image
 *  before the app serves traffic. Parity with the Coolify pre-deploy hook:
 *  no Prisma → no-op; committed migrations → `migrate deploy`; schema only →
 *  `db push`. */
export const VPS_MIGRATE_CMD =
  "if [ -f prisma/schema.prisma ]; then " +
  "if [ -d prisma/migrations ]; then npx --yes prisma migrate deploy; " +
  "else npx --yes prisma db push --accept-data-loss --skip-generate; fi; fi";

export interface RunCommandArgs {
  container: string;
  imageRef: string;
  env: Record<string, string>;
  hosts: string[];
  network: string;
  entrypoint: string;
  certResolver: string;
  port: number;
  registry?: VpsRegistryAuth;
}

/** Assemble the remote shell command that pulls the image and (re)starts the
 *  container with Traefik routing labels. Idempotent: ensures the network,
 *  removes any prior container, then runs the new one. */
export function buildRunCommand(a: RunCommandArgs): string {
  const labels = traefikLabels({
    container: a.container,
    hosts: a.hosts,
    entrypoint: a.entrypoint,
    certResolver: a.certResolver,
    port: a.port,
  });
  const envFlags = Object.entries(a.env).map(
    ([k, v]) => `-e ${k}=${sq(v)}`,
  );
  const runParts = [
    "docker",
    "run",
    "-d",
    "--name",
    a.container,
    "--restart",
    "unless-stopped",
    "--network",
    a.network,
    ...labels,
    ...envFlags,
    sq(a.imageRef),
  ];
  const steps = [
    loginStep(a.registry),
    `docker network create ${a.network} >/dev/null 2>&1 || true`,
    `docker pull ${sq(a.imageRef)}`,
    `docker rm -f ${a.container} >/dev/null 2>&1 || true`,
    ...a.hosts.map((h) => reclaimHostStep(h, a.container)),
    runParts.join(" "),
  ].filter(Boolean);
  return steps.join(" && ");
}

/** Remove any OTHER running container whose Traefik labels already claim
 *  `host`, so a redeploy can't leave two containers fighting over the same
 *  `Host()` router rule. The old Coolify-created containers use hashed names
 *  (not `cantila-<id>`), so the plain `docker rm -f <new name>` in
 *  buildRunCommand never reaped them — this does, by matching the rule label
 *  value rather than the name. Self-skips `keep` and is fully best-effort. */
export function reclaimHostStep(host: string, keep: string): string {
  const pattern = "Host(`" + host + "`)";
  return (
    `for c in $(docker ps --format '{{.Names}}'); do ` +
    `[ "$c" = ${sq(keep)} ] && continue; ` +
    `docker inspect "$c" --format '{{json .Config.Labels}}' 2>/dev/null ` +
    `| grep -qF ${sq(pattern)} && docker rm -f "$c" >/dev/null 2>&1 || true; ` +
    `done`
  );
}

/** Assemble the remote one-off `docker run --rm` that applies the schema. */
export function buildMigrateCommand(a: {
  imageRef: string;
  env: Record<string, string>;
  registry?: VpsRegistryAuth;
}): string {
  const envFlags = Object.entries(a.env).map(([k, v]) => `-e ${k}=${sq(v)}`);
  const run = [
    "docker",
    "run",
    "--rm",
    ...envFlags,
    sq(a.imageRef),
    "sh",
    "-c",
    sq(VPS_MIGRATE_CMD),
  ].join(" ");
  const steps = [
    loginStep(a.registry),
    `docker pull ${sq(a.imageRef)} >/dev/null 2>&1 || true`,
    run,
  ].filter(Boolean);
  return steps.join(" && ");
}

/** Traefik router/service label flags for a container. Multiple hosts join
 *  into one router rule with `||`. */
export function traefikLabels(a: {
  container: string;
  hosts: string[];
  entrypoint: string;
  certResolver: string;
  port: number;
}): string[] {
  const r = `traefik.http.routers.${a.container}`;
  const s = `traefik.http.services.${a.container}`;
  const rule = a.hosts.map((h) => "Host(`" + h + "`)").join(" || ");
  return [
    "-l traefik.enable=true",
    `-l ${sq(`${r}.rule=${rule}`)}`,
    `-l ${r}.entrypoints=${a.entrypoint}`,
    `-l ${r}.tls=true`,
    `-l ${r}.tls.certresolver=${a.certResolver}`,
    `-l ${s}.loadbalancer.server.port=${a.port}`,
  ];
}

/** `docker login` step, or empty string when no registry creds are set. */
function loginStep(registry?: VpsRegistryAuth): string {
  if (!registry || !registry.user || !registry.password) return "";
  return `docker login ${registry.url} -u ${sq(registry.user)} -p ${sq(
    registry.password,
  )}`;
}

interface InspectInfo {
  image: string;
  env: Record<string, string>;
  hosts: string[];
}

/** Parse `docker inspect --format '{{json .}}'` output for attachDomain:
 *  the image, the app's env (filtering docker/runtime defaults), and the
 *  hosts already in its Traefik router rule. Returns null if unparseable. */
export function parseInspect(raw: string): InspectInfo | null {
  let json: any;
  try {
    json = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  const node = Array.isArray(json) ? json[0] : json;
  if (!node?.Config) return null;
  const image: string = node.Config.Image ?? node.Image ?? "";
  if (!image) return null;

  const env: Record<string, string> = {};
  for (const line of (node.Config.Env as string[] | undefined) ?? []) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (ENV_DENYLIST.has(key)) continue;
    env[key] = line.slice(eq + 1);
  }

  const labels = (node.Config.Labels as Record<string, string>) ?? {};
  const ruleKey = Object.keys(labels).find((k) =>
    /^traefik\.http\.routers\..+\.rule$/.test(k),
  );
  const hosts = ruleKey ? parseHostRule(labels[ruleKey]!) : [];

  return { image, env, hosts };
}

/** Container/runtime env keys we must NOT re-inject when re-running a
 *  container (they belong to the image/runtime, not the app config). */
const ENV_DENYLIST = new Set(["PATH", "HOME", "HOSTNAME", "TERM"]);

/** Extract hostnames from a Traefik rule like
 *  "Host(`a.com`) || Host(`b.com`)". */
export function parseHostRule(rule: string): string[] {
  const out: string[] = [];
  const re = /Host\(`([^`]+)`\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rule)) !== null) out.push(m[1]!);
  return out;
}

/** Merge a hostname into a list, de-duped + lowercased, order-stable. */
export function mergeHosts(existing: string[], add: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of [...existing, add]) {
    const t = h.trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Single-quote a shell argument (POSIX): wrap in '…', escaping embedded
 *  quotes. Backticks inside single quotes are literal, so Traefik's
 *  Host(`…`) rule survives intact. */
function sq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function tail(s: string): string {
  return s
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-12)
    .join(" | ")
    .slice(0, 800);
}

/** Heuristic — is `ref` a real Docker image reference (registry/path[:tag])
 *  rather than a placeholder. Mirrors the Coolify adapter's check. */
function isImageRef(ref: string): boolean {
  if (!ref || ref === "coolify:pending") return false;
  if (ref.includes("/")) return true;
  if (/:[A-Za-z0-9._-]+$/.test(ref)) return true;
  return false;
}
