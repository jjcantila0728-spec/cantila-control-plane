import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type { SandboxRunner } from "./types";
import { NoopSandboxRunner } from "./noop";
import { DockerSandboxRunner, type ExecResult } from "./docker";
import { fleetConfig } from "../config";

export type { SandboxRunner } from "./types";

function realExec(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function realFileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function realProbe(url: string): Promise<number> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Select the smoke-test backend from config. Noop unless FLEET_SANDBOX=docker. */
export function getSandboxRunner(): SandboxRunner {
  const cfg = fleetConfig();
  if (cfg.sandbox === "docker") {
    return new DockerSandboxRunner({
      exec: realExec,
      fileExists: realFileExists,
      probe: realProbe,
      sleep,
      now: () => Date.now(),
      defaultTimeoutMs: cfg.sandboxTimeoutMs,
    });
  }
  return new NoopSandboxRunner();
}
