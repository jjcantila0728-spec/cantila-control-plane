/* ============================================================
   nodeBuildHost — the production BuildHost for BuildxImageBuilder.
   Real git clone, filesystem and `docker buildx` over Node's
   child_process + fs. Intentionally thin: all build *decisions*
   live in the (unit-tested) BuildxImageBuilder; this just runs
   the side effects.

   Operational notes (tuned on the build host, not unit-tested):
   - registry login is run once (memoised) before the first buildx
     invocation, using the injected creds;
   - a `docker-container` buildx builder is ensured once, because
     `--cache-to type=registry` requires it (the default docker
     driver can't export cache to a registry).
   ============================================================ */

import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildHost } from "./image-builder";

export interface NodeBuildHostOptions {
  /** Registry host to `docker login` against (e.g. git.cantila.app). */
  registry?: string;
  registryUser?: string;
  registryPassword?: string;
  /** Name of the buildx builder to create/use. Default `cantila`. */
  builderName?: string;
  /** Max child-process output buffer. Default 32 MiB (build logs are large). */
  maxBuffer?: number;
}

const run = (
  cmd: string,
  args: string[],
  cwd: string | undefined,
  maxBuffer: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer }, (err) =>
      err ? reject(err) : resolve(),
    );
  });

export function createNodeBuildHost(
  opts: NodeBuildHostOptions = {},
): BuildHost {
  const maxBuffer = opts.maxBuffer ?? 32 * 1024 * 1024;
  const builderName = opts.builderName ?? "cantila";
  let prepared: Promise<void> | null = null;

  // One-time login + buildx builder setup, memoised across builds.
  const ensurePrepared = (): Promise<void> => {
    if (!prepared) {
      prepared = (async () => {
        if (opts.registry && opts.registryUser && opts.registryPassword) {
          await run(
            "docker",
            [
              "login",
              opts.registry,
              "-u",
              opts.registryUser,
              "-p",
              opts.registryPassword,
            ],
            undefined,
            maxBuffer,
          );
        }
        // Ensure a docker-container builder exists (idempotent — `create`
        // fails if it already exists, so inspect first and tolerate either).
        await run("docker", ["buildx", "inspect", builderName], undefined, maxBuffer).catch(
          () =>
            run(
              "docker",
              ["buildx", "create", "--name", builderName, "--driver", "docker-container"],
              undefined,
              maxBuffer,
            ),
        );
      })().catch((err) => {
        // Reset so a transient failure can be retried on the next build.
        prepared = null;
        throw err;
      });
    }
    return prepared;
  };

  return {
    async mkWorkdir(label) {
      return mkdtemp(join(tmpdir(), `${label.replace(/[^A-Za-z0-9_-]/g, "")}-`));
    },

    async clone(repoUrl, branch, dir) {
      await run(
        "git",
        ["clone", "--depth", "1", "--branch", branch, repoUrl, dir],
        undefined,
        maxBuffer,
      );
    },

    async listFiles(dir) {
      const out: string[] = [];
      const walk = async (rel: string): Promise<void> => {
        const entries = await readdir(join(dir, rel), { withFileTypes: true });
        for (const e of entries) {
          if (e.name === ".git" || e.name === "node_modules") continue;
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(childRel);
          else out.push(childRel);
        }
      };
      await walk("");
      return out;
    },

    async readFile(dir, rel) {
      return readFile(join(dir, rel), "utf8").catch(() => null);
    },

    async writeFile(dir, rel, content) {
      await writeFile(join(dir, rel), content, "utf8");
    },

    async exec(cmd, args, cwd) {
      // The cache-exporting buildx build needs login + a container builder.
      if (cmd === "docker" && args[0] === "buildx" && args[1] === "build") {
        await ensurePrepared();
        await run("docker", [args[0], args[1], "--builder", builderName, ...args.slice(2)], cwd, maxBuffer);
        return;
      }
      await run(cmd, args, cwd, maxBuffer);
    },

    async cleanup(dir) {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
