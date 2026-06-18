/* ============================================================
   SshRunner — run a remote command over the system `ssh` binary.

   Shared by the VPS data plane (deploy lifecycle) and available to
   any other adapter that needs remote docker control. Shells out to
   `ssh` (no `ssh2` dep — matches SshDockerStatsCollector), so the
   runtime image needs `openssh-client`. The runner is injectable so
   the data plane stays unit-testable without a real host.
   ============================================================ */

import { spawn } from "node:child_process";
import type { SshTarget } from "./ssh-docker-stats";

export interface SshExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SshRunOptions {
  /** When set, the string is piped to the remote command's stdin (and the
   *  channel is closed). Used by the SSH build host's `writeFile`, which
   *  pipes file content into `cat > path` rather than embedding it in the
   *  command line. When unset, stdin is `/dev/null`. */
  stdin?: string;
}

export interface SshRunner {
  /** Run `command` on `target`. Resolves with stdout on exit 0; rejects
   *  with an Error (message includes stderr tail) on non-zero or transport
   *  failure. Optionally pipes `opts.stdin` to the remote process. */
  run(target: SshTarget, command: string, opts?: SshRunOptions): Promise<string>;
}

export interface SystemSshRunnerOptions {
  /** Per-command timeout (ms). Default 600000 (10 min) — a deploy pulls and
   *  starts a container, which can be slow on first pull. */
  timeoutMs?: number;
  /** Override the ssh binary — useful for tests. Default `ssh`. */
  sshBinary?: string;
}

/** Production SshRunner over the system `ssh` binary. */
export function systemSshRunner(opts: SystemSshRunnerOptions = {}): SshRunner {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const sshBinary = opts.sshBinary ?? "ssh";
  return {
    run(target, command, opts) {
      return new Promise<string>((resolve, reject) => {
        const args: string[] = [
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          "ConnectTimeout=15",
          "-p",
          String(target.port ?? 22),
        ];
        if (target.privateKeyPath) args.push("-i", target.privateKeyPath);
        args.push(`${target.user ?? "root"}@${target.host}`, command);

        const hasStdin = opts?.stdin !== undefined;
        const stdin: "pipe" | "ignore" = hasStdin ? "pipe" : "ignore";
        const child = spawn(sshBinary, args, {
          stdio: [stdin, "pipe", "pipe"] as const,
        });
        if (hasStdin) {
          child.stdin!.end(opts!.stdin);
        }
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* nothing to clean */
          }
          reject(new Error(`ssh timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout!.on("data", (b) => (stdout += b.toString("utf8")));
        child.stderr!.on("data", (b) => (stderr += b.toString("utf8")));
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) return resolve(stdout);
          reject(new Error(`ssh exited ${code}: ${stderr.slice(0, 500)}`));
        });
      });
    },
  };
}
