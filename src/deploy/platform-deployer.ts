/* ============================================================
   PlatformDeployer — deploy Cantila's OWN platform apps
   (control-plane, console, gritcode) through the control-plane's
   pipeline, no Coolify (plan §19.12 Phase 2 follow-up).

   When Coolify was dropped (2026-06-18) the 3 platform apps lost
   their git-push auto-deploy and fell back to a manual two-step
   (scripts/ship-platform.sh: `git archive | ssh tar x` ->
   /root/deploy-platform.sh). This is the durable replacement: the
   control-plane builds each platform app's image OFF the box with
   the shared ImageBuilder (buildx + registry cache, from the app's
   git repo), then SSHes in to swap the live container — exactly the
   VpsDataPlane mechanism, but targeting a fixed, pre-existing
   container name instead of `cantila-<projectId>`.

   Faithful to scripts/deploy-platform.sh: the live container's env,
   labels (VERBATIM — Coolify's Traefik routing must survive), network
   and restart policy are read back via `docker inspect` and replayed
   onto the new image, so the request path is untouched.

   All side effects go through an injected SshRunner + ImageBuilder,
   so the whole thing is unit-testable without a real host or Docker.
   ============================================================ */

import type { ImageBuilder } from "./image-builder";
import type { SshRunner } from "../dataplane/ssh-exec";
import type { SshTarget } from "../dataplane/ssh-docker-stats";
import type { VpsRegistryAuth } from "../dataplane/vps";

/** A Cantila platform app the control-plane can self-deploy. */
export interface PlatformApp {
  /** Stable key used in API/CLI (e.g. "control-plane"). */
  name: string;
  /** Image-repo segment: the pushed image is `<registry>/<ns>/cantila-<imageId>`. */
  imageId: string;
  /** The live container name on the box to swap (set by Coolify originally). */
  container: string;
  /** Git repo the image is built from. */
  repoUrl: string;
  /** Branch to build, default applied by the caller. */
  branch: string;
  /** Port the app listens on inside the container. */
  appPort: number;
}

/** The platform apps the control-plane can self-deploy from git, keyed by
 *  `name`. Container names are the live Coolify-era containers on box 1 (they
 *  outlived Coolify — still running as plain docker, see §19.12 Phase 2).
 *  `gritcode` is intentionally absent: its local checkout has no git remote, so
 *  it can't be cloned + built off-box yet — it stays on the source-push path
 *  (scripts/ship-platform.sh) until it has a remote. */
export const PLATFORM_APPS: Record<string, PlatformApp> = {
  "control-plane": {
    name: "control-plane",
    imageId: "control-plane",
    container: "bd3l9kee90ic661e4rmpzjez-015854665436",
    repoUrl: "https://github.com/jjcantila0728-spec/cantila-control-plane.git",
    branch: "master",
    appPort: 8090,
  },
  console: {
    name: "console",
    imageId: "console",
    container: "jsyg2k7i89jg352o9dignhe8-165656603856",
    repoUrl: "https://github.com/jjcantila0728-spec/cantila.git",
    branch: "main",
    appPort: 3000,
  },
};

export interface PlatformDeployerOptions {
  /** Injected remote-exec. `systemSshRunner()` in production. */
  ssh: SshRunner;
  /** The box the platform apps run on. */
  node: SshTarget;
  /** Off-box image builder — produces the registry image the box pulls. */
  imageBuilder: ImageBuilder;
  /** The registry of deployable platform apps, keyed by `name`. */
  apps: Record<string, PlatformApp>;
  /** Registry login run on the box before pulling a private image. */
  registry?: VpsRegistryAuth;
}

export interface PlatformDeployResult {
  app: string;
  imageRef: string;
  container: string;
}

export class PlatformDeployer {
  constructor(private readonly opts: PlatformDeployerOptions) {}

  /** Build `appName`'s image from its repo and swap the live container,
   *  preserving its env, labels, network and restart policy. */
  async deploy(appName: string, ref?: string): Promise<PlatformDeployResult> {
    const app = this.opts.apps[appName];
    if (!app) {
      throw new Error(
        `unknown platform app: ${appName} (known: ${Object.keys(this.opts.apps).join(", ") || "none"})`,
      );
    }

    const built = await this.opts.imageBuilder.build({
      project: {
        id: app.imageId,
        repoUrl: app.repoUrl,
        branch: app.branch,
        buildPack: undefined,
        appPort: app.appPort,
      },
      ref,
    });
    if (!built) {
      throw new Error(
        `could not build platform app ${appName} from ${app.repoUrl} ` +
          `(builder declined — check the repo has a supported stack)`,
      );
    }

    const raw = await this.opts.ssh.run(
      this.opts.node,
      `docker inspect ${app.container} --format '{{json .}}'`,
    );
    const info = parsePlatformContainer(raw);
    if (!info) {
      throw new Error(
        `cannot inspect live container ${app.container} for ${appName}`,
      );
    }

    const cmd = buildPlatformRunCommand({
      container: app.container,
      imageRef: built.imageRef,
      env: info.env,
      labels: info.labels,
      network: info.network,
      restart: info.restart,
      registry: this.opts.registry,
    });
    await this.opts.ssh.run(this.opts.node, cmd);

    return { app: appName, imageRef: built.imageRef, container: app.container };
  }
}

/* ---- pure helpers (exported for testing) ---- */

export interface PlatformContainerInfo {
  env: Record<string, string>;
  labels: Record<string, string>;
  network: string;
  restart: string;
}

/** Container/runtime env keys we must NOT re-inject — they belong to the
 *  image/runtime, not the app config (mirrors VpsDataPlane + deploy-platform.sh). */
const ENV_DENYLIST = new Set([
  "PATH",
  "HOME",
  "HOSTNAME",
  "TERM",
  "NODE_VERSION",
  "YARN_VERSION",
]);

/** Parse `docker inspect --format '{{json .}}'` for a platform container:
 *  the filtered env, the labels VERBATIM (Traefik routing survives), the
 *  network, and the restart policy. Returns null if unparseable. */
export function parsePlatformContainer(
  raw: string,
): PlatformContainerInfo | null {
  let json: any;
  try {
    json = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  const node = Array.isArray(json) ? json[0] : json;
  if (!node?.Config) return null;

  const env: Record<string, string> = {};
  for (const line of (node.Config.Env as string[] | undefined) ?? []) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (ENV_DENYLIST.has(key)) continue;
    env[key] = line.slice(eq + 1);
  }

  const labels = { ...((node.Config.Labels as Record<string, string>) ?? {}) };

  const networks = node.NetworkSettings?.Networks as
    | Record<string, unknown>
    | undefined;
  const network = networks ? (Object.keys(networks)[0] ?? "coolify") : "coolify";

  const restart =
    (node.HostConfig?.RestartPolicy?.Name as string | undefined) ||
    "unless-stopped";

  return { env, labels, network, restart };
}

export interface PlatformRunArgs {
  container: string;
  imageRef: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  network: string;
  restart: string;
  registry?: VpsRegistryAuth;
}

/** Assemble the remote shell command that pulls the new image and re-runs the
 *  platform container with its env + labels preserved verbatim. Idempotent:
 *  login (if creds) -> pull -> rm -f -> run. */
export function buildPlatformRunCommand(a: PlatformRunArgs): string {
  const envFlags = Object.entries(a.env).map(([k, v]) => `-e ${k}=${sq(v)}`);
  const labelFlags = Object.entries(a.labels).map(
    ([k, v]) => `-l ${sq(`${k}=${v}`)}`,
  );
  const runParts = [
    "docker",
    "run",
    "-d",
    "--name",
    a.container,
    "--restart",
    a.restart,
    "--network",
    a.network,
    ...labelFlags,
    ...envFlags,
    sq(a.imageRef),
  ];
  const steps = [
    loginStep(a.registry),
    `docker pull ${sq(a.imageRef)}`,
    `docker rm -f ${a.container} >/dev/null 2>&1 || true`,
    runParts.join(" "),
  ].filter(Boolean);
  return steps.join(" && ");
}

/** `docker login` step, or empty string when no registry creds are set. */
function loginStep(registry?: VpsRegistryAuth): string {
  if (!registry || !registry.user || !registry.password) return "";
  return `docker login ${registry.url} -u ${sq(registry.user)} -p ${sq(registry.password)}`;
}

/** Single-quote a shell argument (POSIX): wrap in '…', escaping embedded
 *  quotes. Backticks inside single quotes are literal, so Traefik's
 *  Host(`…`) label survives intact. */
function sq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
