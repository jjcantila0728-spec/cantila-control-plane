/* ============================================================
   sshBuildHost — the production BuildHost for BuildxImageBuilder
   when the build runs on a REMOTE node over SSH (plan §19.12
   Phase 1, Path B).

   Why this exists: the control-plane container has no docker socket
   and no docker CLI, so `nodeBuildHost` (local execFile) can't run
   `docker buildx` in prod. Rather than hand the app container host
   root via a mounted socket (Path A — rejected), we ship the build
   to a dedicated build node over SSH. The §19.11 design anticipated
   exactly this ("move the build to a dedicated node without touching
   the pipeline") — only the BuildHost changes; BuildxImageBuilder is
   untouched.

   All build *decisions* live in the (unit-tested) BuildxImageBuilder;
   this just assembles the remote shell commands. Operational notes,
   mirroring nodeBuildHost:
   - registry login + a `docker-container` buildx builder are ensured
     once (memoised) before the first build, because
     `--cache-to type=registry` needs the container driver;
   - every interpolated path/arg is single-quote escaped.
   ============================================================ */

import type { BuildHost } from "./image-builder";
import type { SshRunner } from "../dataplane/ssh-exec";
import type { SshTarget } from "../dataplane/ssh-docker-stats";

export interface SshBuildHostOptions {
  /** SSH transport (injected so this is unit-testable without a host). */
  ssh: SshRunner;
  /** The build node to run git + docker buildx on. */
  target: SshTarget;
  /** Registry host to `docker login` against (e.g. git.cantila.app). */
  registry?: string;
  registryUser?: string;
  registryPassword?: string;
  /** Name of the buildx builder to create/use. Default `cantila`. */
  builderName?: string;
}

/** Single-quote shell escape: wrap in '…' and escape embedded quotes. Safe
 *  for arbitrary paths, URLs and flags interpolated into a remote command. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function sshBuildHost(opts: SshBuildHostOptions): BuildHost {
  const { ssh, target } = opts;
  const builderName = opts.builderName ?? "cantila";
  let prepared: Promise<void> | null = null;

  const run = (command: string, stdin?: string): Promise<string> =>
    ssh.run(target, command, stdin === undefined ? undefined : { stdin });

  // One-time `docker login` + buildx builder ensure, memoised across builds.
  // A transient failure resets the memo so the next build retries prep.
  const ensurePrepared = (): Promise<void> => {
    if (!prepared) {
      prepared = (async () => {
        if (opts.registry && opts.registryUser && opts.registryPassword) {
          await run(
            `docker login ${sq(opts.registry)} -u ${sq(opts.registryUser)} -p ${sq(opts.registryPassword)}`,
          );
        }
        // Idempotent: inspect first, create only if missing. `--cache-to
        // type=registry` requires the docker-container driver.
        await run(
          `docker buildx inspect ${sq(builderName)} >/dev/null 2>&1 || ` +
            `docker buildx create --name ${sq(builderName)} --driver docker-container`,
        );
      })().catch((err) => {
        prepared = null;
        throw err;
      });
    }
    return prepared;
  };

  return {
    async mkWorkdir(_label) {
      const out = await run("mktemp -d");
      return out.trim();
    },

    async clone(repoUrl, branch, dir) {
      await run(
        `git clone --depth 1 --branch ${sq(branch)} ${sq(repoUrl)} ${sq(dir)}`,
      );
    },

    async listFiles(dir) {
      // `cd dir && find .` yields ./-prefixed relative paths; prune the same
      // dirs nodeBuildHost skips so stack detection sees identical input.
      const out = await run(
        `cd ${sq(dir)} && find . -type f ` +
          `-not -path './.git/*' -not -path './node_modules/*'`,
      );
      return out
        .split("\n")
        .map((l) => l.trim().replace(/^\.\//, ""))
        .filter((l) => l.length > 0);
    },

    async readFile(dir, rel) {
      return run(`cat ${sq(`${dir}/${rel}`)}`).catch(() => null);
    },

    async writeFile(dir, rel, content) {
      // Pipe content over stdin rather than embedding it in the command line
      // (avoids quoting whole files + arg-length limits).
      await run(`cat > ${sq(`${dir}/${rel}`)}`, content);
    },

    async exec(cmd, args, cwd) {
      // The cache-exporting buildx build needs login + a container builder,
      // and must run with that named builder.
      if (cmd === "docker" && args[0] === "buildx" && args[1] === "build") {
        await ensurePrepared();
        const rebuilt = [
          "buildx",
          "build",
          "--builder",
          builderName,
          ...args.slice(2),
        ];
        await run(
          `cd ${sq(cwd)} && ${sq(cmd)} ${rebuilt.map(sq).join(" ")}`,
        );
        return;
      }
      await run(`cd ${sq(cwd)} && ${sq(cmd)} ${args.map(sq).join(" ")}`);
    },

    async cleanup(dir) {
      await run(`rm -rf ${sq(dir)}`).catch(() => {});
    },
  };
}
