/* ============================================================
   SSH-based `docker stats` collector (plan §19.7).

   Implements `MetricsCollector` by SSH'ing to the Coolify host and
   running `docker stats --no-stream --format '{{json .}}'` filtered
   by Coolify's `coolify.applicationId` label. Shells out to the
   system `ssh` binary (no `ssh2` dep), so the runtime image needs
   the `openssh-client` package — Coolify's default Ubuntu host
   ships it, and the control-plane container's Nixpacks base
   includes it via `apt`.

   Returns `null` on any failure (no SSH binary, no key, no matching
   container, parse failure) — the caller falls back to the existing
   status-aware synthesis. Never throws.
   ============================================================ */

import { spawn } from "node:child_process";
import type {
  MetricsCollector,
  MetricsCollectorInput,
  MetricsReading,
} from "./metrics-collector";
import type { Region } from "../domain/types";

export interface SshTarget {
  /** Hostname or IP of the Coolify server. */
  host: string;
  /** SSH user, default `root` (matches Coolify's default install). */
  user?: string;
  /** SSH port, default 22. */
  port?: number;
  /** Absolute path to the private key. When unset, the system's
   *  default key + agent are used. */
  privateKeyPath?: string;
}

export interface SshDockerStatsOptions {
  /** Per-region SSH targets. The collector looks up the region from
   *  the input and uses that target. Unknown regions return `null`. */
  targets: Partial<Record<Region, SshTarget>>;
  /** Overall timeout (ms) for the SSH command — default 8000. The
   *  data plane is on the request path for `/v1/projects/:id/metrics`
   *  so the budget has to be tight. */
  timeoutMs?: number;
  /** Override the SSH binary path — useful for tests. Default `ssh`. */
  sshBinary?: string;
}

export class SshDockerStatsCollector implements MetricsCollector {
  private readonly targets: Partial<Record<Region, SshTarget>>;
  private readonly timeoutMs: number;
  private readonly sshBinary: string;

  constructor(opts: SshDockerStatsOptions) {
    this.targets = opts.targets;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.sshBinary = opts.sshBinary ?? "ssh";
  }

  async collect(input: MetricsCollectorInput): Promise<MetricsReading | null> {
    const target = this.targets[input.region];
    if (!target) return null;

    // Two-stage pipe on the remote shell:
    //   1. `docker ps -q --filter label=coolify.applicationId=<uuid>` →
    //      list running container ids for this app (handles replicas).
    //   2. `xargs -r docker stats --no-stream --format '{{json .}}'` →
    //      emit one JSON object per running container.
    // `xargs -r` is a no-op when stage 1 returns nothing (no running
    // replicas), so the whole pipeline exits 0 with empty stdout and
    // we return `null`.
    //
    // The remote command is single-quoted to keep ssh from re-interpreting
    // `{{json .}}` braces; we also escape the appUuid since it's a real
    // uuid string we don't want shell-interpreted.
    const safeUuid = shellEscape(input.appUuid);
    const remote =
      `docker ps -q --filter label=coolify.applicationId=${safeUuid} ` +
      `| xargs -r docker stats --no-stream --format '{{json .}}'`;

    const stdout = await this.runSsh(target, remote).catch(() => null);
    if (stdout == null) return null;

    return parseDockerStats(stdout);
  }

  private runSsh(target: SshTarget, remoteCmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args: string[] = [
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", `ConnectTimeout=${Math.ceil(this.timeoutMs / 1000)}`,
        "-p", String(target.port ?? 22),
      ];
      if (target.privateKeyPath) {
        args.push("-i", target.privateKeyPath);
      }
      const user = target.user ?? "root";
      args.push(`${user}@${target.host}`, remoteCmd);

      const child = spawn(this.sshBinary, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        // Kill the whole tree — ssh may have spawned a remote shell.
        try { child.kill("SIGKILL"); } catch { /* nothing to clean */ }
        reject(new Error(`ssh timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
      child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
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
  }
}

/** Parse one or more JSON lines from `docker stats --format '{{json .}}'`
 *  and average CPU/memory across the replicas. Tolerates blank lines.
 *  Returns `null` when there are no parseable lines (no running
 *  replicas, malformed output, etc).
 *
 *  Exported for testing — also covers parsing oddities like the `%`
 *  suffix and CPU values > 100 (per-core CPU on a multi-core host),
 *  which we clamp at 100 since the rest of the system reads cpuPct
 *  as a 0–100 fraction. */
export function parseDockerStats(stdout: string): MetricsReading | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const samples: { cpu: number; mem: number }[] = [];
  for (const line of lines) {
    let row: { CPUPerc?: string; MemPerc?: string } | null = null;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row) continue;
    const cpu = parsePercent(row.CPUPerc);
    const mem = parsePercent(row.MemPerc);
    if (cpu == null || mem == null) continue;
    samples.push({ cpu, mem });
  }
  if (samples.length === 0) return null;

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  // CPU can exceed 100 on a multi-core host (sum across cores). Clamp
  // so downstream consumers (Console gauges, ScaleAgent thresholds)
  // see a true 0–100.
  const cpuPct = clamp(round1(avg(samples.map((s) => s.cpu))), 0, 100);
  const memPct = clamp(round1(avg(samples.map((s) => s.mem))), 0, 100);
  return { cpuPct, memPct, replicas: samples.length };
}

function parsePercent(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/%\s*$/, "");
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return n;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Cheap single-arg shell-escape — wraps in single quotes and
 *  escapes any embedded single quotes. Enough for a uuid string;
 *  not a general escape. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
