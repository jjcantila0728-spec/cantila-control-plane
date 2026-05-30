/* ============================================================
   The deploy pipeline — eight steps (plan §7.3).
   Step 3 auto-wires the project's database, email and SMS.
   ============================================================ */

import type { Store } from "../domain/store";
import type {
  Project,
  Runtime,
  DeployTrigger,
  EnvVar,
  ProjectMetricSample,
} from "../domain/types";
import {
  provisionProjectServices,
  type ProvisionResult,
  type ServiceProvisioner,
} from "./provisioning";
import { id, now } from "../lib/ids";

export interface DeploySource {
  kind: "git" | "upload" | "chat";
  ref?: string;
}

/**
 * Data-plane contract for build / schedule / run / route. Simulated in
 * src/dataplane/stub.ts; production wires Docker, a registry and Traefik.
 */
export interface DataPlane {
  detectStack(source: DeploySource): Promise<Runtime>;
  buildImage(
    project: Project,
    source: DeploySource,
  ): Promise<{ imageRef: string }>;
  schedule(project: Project): Promise<{ nodeId: string }>;
  startContainer(
    project: Project,
    imageRef: string,
    nodeId: string,
    env: Record<string, string>,
  ): Promise<void>;
  route(project: Project): Promise<{ url: string }>;
  healthCheck(url: string): Promise<boolean>;
  /** Sample the project's current load (plan §5.2). Returns a window
   *  of the most-recent samples in oldest-first order; the stub
   *  data plane synthesises this from project state, the real one will
   *  read Docker / kube stats + the LB's request counters. */
  sampleMetrics(project: Project): Promise<ProjectMetricSample[]>;
  /** Tear down the project's running app on the data plane. Optional —
   *  the stub omits it (nothing real to remove); the Coolify data plane
   *  deletes the underlying Application. Best-effort by contract: callers
   *  treat a failure as non-fatal so a stale Coolify app never blocks
   *  removing the Cantila project. */
  destroyApp?(project: Project): Promise<void>;
}

/** Emitted once for each pipeline step as it completes. The HTTP SSE
 *  transport forwards these to subscribed clients (plan §5.3 — real-time
 *  logs). */
export interface DeployStepEvent {
  at: string;
  deploymentId: string;
  projectId: string;
  step: string;
}

export interface DeployInput {
  projectId: string;
  trigger: DeployTrigger;
  source: DeploySource;
  /** Optional commit metadata — set by the git webhook receiver so the
   *  deployment row carries the SHA, branch and message. */
  commit?: {
    hash?: string;
    message?: string;
    branch?: string;
  };
  /** When set, this deployment is a branch preview (plan §5.1). The URL
   *  becomes `{slug}-{previewBranch}.cantila.app`, the project's
   *  production status is left untouched, and only `preview`-scoped env
   *  vars are injected alongside the shared ones. */
  previewBranch?: string;
  /** Invoked after each step. The pipeline awaits it, so SSE writers can
   *  flush before the next step runs. */
  onStep?: (event: DeployStepEvent) => Promise<void> | void;
  /** When true, the pipeline paces each step with a short randomised delay
   *  so the stream feels live in the UI. Defaults to false. */
  pace?: boolean;
}

export interface DeployOutcome {
  deploymentId: string;
  status: "live" | "failed";
  url: string;
  steps: string[];
  provisioned: ProvisionResult;
}

export interface PipelineDeps {
  store: Store;
  provisioner: ServiceProvisioner;
  dataPlane: DataPlane;
}

/** Flatten env vars into a map for the container. Production deploys
 *  exclude `preview`-scoped vars; preview deploys include them (the
 *  `all`-scoped vars come along in both cases). */
function toEnvMap(vars: EnvVar[], isPreview: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of vars) {
    if (!isPreview && v.scope === "preview") continue;
    if (isPreview && v.scope === "production") continue;
    out[v.key] = v.value;
  }
  return out;
}

/** Branch → URL-safe label. "feat/new-ui" → "feat-new-ui". */
function previewSlug(branch: string): string {
  return (
    branch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "preview"
  );
}

const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs the eight-step deploy pipeline. Returns the live URL, the deployment
 * id, an ordered step trace, and what the auto-wiring provisioned this run.
 * If `onStep` is supplied, it is awaited after each step so a streaming
 * transport (SSE) can flush before the next step starts.
 */
export async function runDeploy(
  deps: PipelineDeps,
  input: DeployInput,
): Promise<DeployOutcome> {
  const { store, provisioner, dataPlane } = deps;
  const steps: string[] = [];

  const project = await store.getProject(input.projectId);
  if (!project) throw new Error(`project not found: ${input.projectId}`);

  // Fail loudly when a git deploy has no source. Without a connected
  // repository (or an uploaded image) the data plane falls through to an
  // `nginx:alpine` placeholder and then reports a misleading "live" — the
  // exact trap that makes a deploy look successful while serving the
  // default nginx page. Require the caller to connect a repo first
  // (POST /v1/projects/:id/git, or pass `repoUrl` in the deploy body) or
  // deploy an uploaded image (`source.kind: "upload"`).
  if (input.source.kind === "git" && !project.repoUrl) {
    throw new Error(
      "no git source connected — connect a repository first " +
        "(POST /v1/projects/:id/git, or include repoUrl in the deploy body), " +
        "or deploy an uploaded image, before deploying",
    );
  }

  const isPreview = Boolean(input.previewBranch);
  const deployment = await store.createDeployment({
    id: id("dpl"),
    projectId: project.id,
    status: "queued",
    trigger: input.trigger,
    runtime: project.runtime,
    logs: [],
    commitHash: input.commit?.hash,
    commitMessage: input.commit?.message,
    branch: input.commit?.branch,
    previewBranch: input.previewBranch,
    createdAt: now(),
  });

  async function emit(step: string): Promise<void> {
    steps.push(step);
    if (input.onStep) {
      await input.onStep({
        at: now(),
        deploymentId: deployment.id,
        projectId: project!.id,
        step,
      });
    }
    if (input.pace) {
      // Step pacing chosen to feel like a real CI step without being slow.
      await sleep(220 + Math.floor(Math.random() * 280));
    }
  }

  // 1 — source arrives
  await emit("source-received");

  // 2 — stack detection
  const runtime = await dataPlane.detectStack(input.source);
  await emit(`stack-detected:${runtime}`);

  // 3 — provision project services (the auto-wiring)
  const provisioned = await provisionProjectServices(
    store,
    provisioner,
    project,
  );
  await emit(`services-provisioned:${provisioned.injectedEnv.length}-env-injected`);

  // 4 — build
  await store.updateDeployment(deployment.id, { status: "building" });
  // Preview deploys don't touch the project's production status — the
  // running prod container should keep serving while the preview builds.
  if (!isPreview) {
    await store.updateProject(project.id, { status: "building" });
  }
  const { imageRef } = await dataPlane.buildImage(project, input.source);
  await emit("image-built");

  // 5 — schedule
  const { nodeId } = await dataPlane.schedule(project);
  await emit(`scheduled:${nodeId}`);

  // 6 — deploy
  const env = toEnvMap(await store.listEnvVars(project.id), isPreview);
  await dataPlane.startContainer(project, imageRef, nodeId, env);
  await emit("container-started");

  // 7 — route. For previews we override the URL produced by the data
  // plane so the preview lives on its own subdomain — production keeps
  // its main slug.cantila.app URL.
  const { url: baseUrl } = await dataPlane.route(project);
  const url = isPreview
    ? `https://${project.slug}-${previewSlug(input.previewBranch!)}.cantila.app`
    : baseUrl;
  await emit(isPreview ? `routed-preview:${input.previewBranch!}` : "routed");

  // 8 — verify
  const healthy = await dataPlane.healthCheck(url);
  await emit(healthy ? "verified" : "verify-failed");

  const status: "live" | "failed" = healthy ? "live" : "failed";
  await store.updateDeployment(deployment.id, {
    status,
    imageRef,
    nodeId,
    url,
    logs: steps,
  });
  // Only flip the project's own status on production deploys. A failed
  // preview shouldn't crash production.
  if (!isPreview) {
    await store.updateProject(project.id, {
      status: healthy ? "live" : "crashed",
    });
  }

  return { deploymentId: deployment.id, status, url, steps, provisioned };
}
