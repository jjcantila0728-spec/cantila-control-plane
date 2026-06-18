/* ============================================================
   ImageBuilder — build a tenant's container image OFF the
   production box, with registry layer caching, and push it to a
   registry so the data plane only ever has to `docker pull`
   (plan 2026-06-18 §Stage 1).

   This is the fast-build lever. The dominant cost today is
   Coolify building from source on the prod server with Nixpacks
   (cold toolchain, weak caching) on every deploy. A BuildKit
   build with `--cache-from/--cache-to type=registry` reuses the
   dependency-install layer across deploys, and the build runs
   wherever the BuildHost points (the control-plane host today,
   a dedicated builder later) — never blocking the prod box.

   The port is intentionally tiny: `build()` returns a pullable
   image ref, or `null` to tell the caller "I can't build this —
   fall back to source-build on the data plane" (no repo, a
   docker-compose app, or a long-tail stack we leave to Nixpacks).

   All real I/O (git clone, filesystem, `docker buildx`) lives
   behind the injected `BuildHost`, so the builder is fully
   unit-testable without Docker.
   ============================================================ */

import type { Project } from "../domain/types";
import { detectStack } from "../git/detect-stack";
import { generateDockerfile } from "./dockerfiles";

/** The subset of a Project the builder needs. */
export type BuildProject = Pick<
  Project,
  "id" | "repoUrl" | "branch" | "buildPack" | "appPort"
>;

export interface ImageBuildInput {
  project: BuildProject;
  /** Commit SHA / ref being deployed — used as the immutable image tag.
   *  Falls back to `latest` when absent. */
  ref?: string;
}

export interface ImageBuilder {
  /**
   * Build and push the project's image. Returns a pullable registry ref
   * (`registry/ns/cantila-<id>:<tag>`), or `null` when the builder declines
   * so the caller falls back to building from source on the data plane.
   */
  build(input: ImageBuildInput): Promise<{ imageRef: string } | null>;
}

/** Default builder — always declines, preserving today's behaviour
 *  (the data plane builds from source). Used when no real builder is
 *  configured. */
export const noopImageBuilder: ImageBuilder = {
  async build() {
    return null;
  },
};

/** All side-effecting operations the buildx builder needs, injected so the
 *  builder itself is pure control-flow. `nodeBuildHost` is the production
 *  implementation; tests pass a recording fake. */
export interface BuildHost {
  /** Create a fresh empty working directory and return its absolute path. */
  mkWorkdir(label: string): Promise<string>;
  /** Shallow-clone `repoUrl` at `branch` into `dir`. */
  clone(repoUrl: string, branch: string, dir: string): Promise<void>;
  /** List repo file paths (relative, forward-slashed) for stack detection. */
  listFiles(dir: string): Promise<string[]>;
  /** Read a repo file (relative path) or null if absent. */
  readFile(dir: string, rel: string): Promise<string | null>;
  /** Write a file (relative path) into the workdir. */
  writeFile(dir: string, rel: string, content: string): Promise<void>;
  /** Run a command in `cwd`; reject on non-zero exit. */
  exec(cmd: string, args: string[], cwd: string): Promise<void>;
  /** Best-effort removal of the workdir. */
  cleanup(dir: string): Promise<void>;
}

export interface BuildxConfig {
  /** Registry host, e.g. `git.cantila.app` (Gitea's built-in registry). */
  registry: string;
  /** Path namespace under the registry, e.g. `cantila`. Default `cantila`. */
  namespace?: string;
}

/** Filename for the Dockerfile we generate for Nixpacks-class stacks. We never
 *  overwrite a repo's own `Dockerfile`. */
const GENERATED_DOCKERFILE = "Dockerfile.cantila";

/**
 * BuildKit-based image builder. Clones the repo, detects the stack, writes a
 * canonical cache-friendly Dockerfile when appropriate, then
 * `docker buildx build --push` with registry-backed layer caching.
 */
export class BuildxImageBuilder implements ImageBuilder {
  private readonly registry: string;
  private readonly namespace: string;

  constructor(
    private readonly host: BuildHost,
    config: BuildxConfig,
  ) {
    this.registry = config.registry.replace(/\/+$/, "");
    this.namespace = (config.namespace ?? "cantila").replace(/^\/+|\/+$/g, "");
  }

  async build(input: ImageBuildInput): Promise<{ imageRef: string } | null> {
    const { project } = input;
    // No repo → nothing to build from source; let the data plane decide
    // (placeholder slot / pre-pushed image).
    if (!project.repoUrl) return null;

    const dir = await this.host.mkWorkdir(`build-${project.id}`);
    try {
      await this.host.clone(project.repoUrl, project.branch ?? "main", dir);

      const paths = await this.host.listFiles(dir);
      const stack = await detectStack(paths, (p) =>
        this.host.readFile(dir, p),
      );

      // docker-compose apps declare their own multi-service topology — buildx
      // can't produce a single runnable image. Leave those to the data plane.
      if (stack.buildPack === "dockercompose") return null;

      // Decide which Dockerfile buildx should use.
      //   - generated Dockerfile (Node/Python/Go/static) → write + `-f`.
      //   - repo's own Dockerfile (buildPack === "dockerfile") → use as-is.
      //   - otherwise (long-tail Nixpacks stack) → decline, fall back.
      const generated = generateDockerfile(stack);
      let dockerfileArg: string[] = [];
      if (generated) {
        await this.host.writeFile(dir, GENERATED_DOCKERFILE, generated);
        dockerfileArg = ["-f", GENERATED_DOCKERFILE];
      } else if (stack.buildPack !== "dockerfile") {
        return null;
      }

      const image = `${this.registry}/${this.namespace}/cantila-${project.id}`;
      const tag = imageTag(input.ref);
      const imageRef = `${image}:${tag}`;
      const cacheRef = `${image}:buildcache`;

      await this.host.exec(
        "docker",
        [
          "buildx",
          "build",
          ...dockerfileArg,
          "-t",
          imageRef,
          "--cache-from",
          `type=registry,ref=${cacheRef}`,
          "--cache-to",
          `type=registry,ref=${cacheRef},mode=max`,
          "--push",
          ".",
        ],
        dir,
      );

      return { imageRef };
    } finally {
      await this.host.cleanup(dir).catch(() => {});
    }
  }
}

/** Turn a commit SHA / ref into a valid, short Docker tag. Docker tags allow
 *  [A-Za-z0-9._-], max 128 chars, and may not start with `.`/`-`. We slice a
 *  SHA to 12 chars (plenty unique) and fall back to `latest`. */
export function imageTag(ref: string | undefined): string {
  if (!ref) return "latest";
  const cleaned = ref.replace(/[^A-Za-z0-9._-]/g, "").replace(/^[.-]+/, "");
  if (!cleaned) return "latest";
  // A 40-char SHA → first 12; anything already short stays as-is.
  return cleaned.length > 12 && /^[0-9a-f]+$/i.test(cleaned)
    ? cleaned.slice(0, 12)
    : cleaned.slice(0, 128);
}
