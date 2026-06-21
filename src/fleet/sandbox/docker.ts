import path from "node:path";
import type { SandboxRunner, SandboxRequest, SandboxResult } from "./types";

export interface ExecResult { code: number; stdout: string; stderr: string }

export interface DockerDeps {
  /** Run a command (e.g. `docker`). Throws or returns non-zero on failure. */
  exec: (cmd: string, args: string[]) => Promise<ExecResult>;
  /** True when an absolute path exists (used to detect prisma/schema.prisma). */
  fileExists: (absPath: string) => Promise<boolean>;
  /** Optional HTTP GET resolving to the status code (0 on error). When omitted
   *  the runner probes via a one-off curl container on the sandbox network,
   *  which is the correct path for a remote/socket docker daemon. Injected in
   *  unit tests for determinism. */
  probe?: (url: string) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollIntervalMs?: number;
  defaultTimeoutMs?: number;
  /** Container image the product runs in. */
  image?: string;
  /** Host port the product is published on for probing. */
  port?: number;
}

const MAX_LOG = 8000;
const trunc = (s: string) => (s.length > MAX_LOG ? s.slice(-MAX_LOG) : s);

/** Boots a freshly built product in a disposable Docker container and reports
 *  whether it actually runs. Every docker interaction is injected so the logic
 *  is testable without a daemon. Activated by FLEET_SANDBOX=docker. */
export class DockerSandboxRunner implements SandboxRunner {
  constructor(private d: DockerDeps) {}

  async run(req: SandboxRequest): Promise<SandboxResult> {
    const { exec, fileExists, probe, sleep, now } = this.d;
    const poll = this.d.pollIntervalMs ?? 1000;
    const timeout = req.timeoutMs ?? this.d.defaultTimeoutMs ?? 120000;
    const image = this.d.image ?? "node:20-alpine";
    const port = this.d.port ?? 8080;

    const app = `cantila-sandbox-${req.projectId}`;
    const db = `cantila-sandbox-db-${req.projectId}`;
    const net = `cantila-sbnet-${req.projectId}`;
    const mount = `${req.workspaceDir}:/app`;

    const start = now();
    let logs = "";
    const cleanup: string[] = [];               // container names to rm -f, always
    const append = (r: ExecResult) => { logs += (r.stdout || "") + (r.stderr || ""); };

    try {
      await exec("docker", ["network", "create", net]);

      // 1. install deps into the mounted workspace
      append(await exec("docker", [
        "run", "--rm", "-v", mount, "-w", "/app", image, "sh", "-c", "npm ci || npm install",
      ]));

      // 2. migrate against a throwaway Postgres when the product has a schema —
      //    this is what catches the "DB never migrated" crash before deploy.
      let dbEnv: string[] = [];
      if (await fileExists(path.join(req.workspaceDir, "prisma", "schema.prisma"))) {
        cleanup.push(db);
        await exec("docker", [
          "run", "-d", "--name", db, "--network", net,
          "-e", "POSTGRES_PASSWORD=sandbox", "-e", "POSTGRES_DB=app", "postgres:16-alpine",
        ]);
        const dbUrl = `postgresql://postgres:sandbox@${db}:5432/app`;
        dbEnv = ["-e", `DATABASE_URL=${dbUrl}`];
        append(await exec("docker", [
          "run", "--rm", "-v", mount, "-w", "/app", "--network", net, ...dbEnv,
          image, "sh", "-c", "npx prisma migrate deploy",
        ]));
      }

      // 3. boot — minimal, controlled env only. Host secrets are NEVER forwarded.
      cleanup.push(app);                          // pushed before boot so teardown always fires
      await exec("docker", [
        "run", "-d", "--name", app, "--network", net,
        "-p", `127.0.0.1:${port}:${port}`, "-v", mount, "-w", "/app",
        "-e", `PORT=${port}`, "-e", "NODE_ENV=production", ...dbEnv,
        image, "sh", "-c", "npm start",
      ]);

      // 4. probe until healthy or timeout. Probe from a one-off curl container
      //    ON the sandbox network (http://<app>:<port>) rather than the host's
      //    127.0.0.1 — the app's port is only published on whichever host the
      //    docker daemon lives on, which is NOT the control-plane container's
      //    loopback. Going through the network makes the probe correct whether
      //    docker is a local socket or remote (SSH) daemon. Falls back to the
      //    injected probe() when present (unit tests / future host-local mode).
      const healthUrl = `http://${app}:${port}/health`;
      const rootUrl = `http://${app}:${port}/`;
      const probeUrl = async (url: string): Promise<number> => {
        if (probe) return probe(url);
        try {
          const r = await exec("docker", [
            "run", "--rm", "--network", net, "curlimages/curl:8.11.1",
            "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", url,
          ]);
          return Number.parseInt((r.stdout || "").trim(), 10) || 0;
        } catch {
          return 0;
        }
      };
      const deadline = start + timeout;
      let status = 0;
      while (now() < deadline) {
        status = await probeUrl(healthUrl);
        if (status === 200) break;
        status = await probeUrl(rootUrl);
        if (status === 200) break;
        await sleep(poll);
      }
      const passed = status === 200;

      try { append(await exec("docker", ["logs", "--tail", "200", app])); } catch { /* best effort */ }

      return {
        passed,
        detail: passed ? "booted; HTTP 200" : `did not become healthy before timeout (last status ${status})`,
        logs: trunc(logs),
        durationMs: now() - start,
      };
    } catch (err) {
      return {
        passed: false,
        detail: `sandbox error: ${err instanceof Error ? err.message : String(err)}`,
        logs: trunc(logs),
        durationMs: now() - start,
      };
    } finally {
      // 5. teardown — always, swallow errors
      for (const name of cleanup) { try { await exec("docker", ["rm", "-f", name]); } catch { /* ignore */ } }
      try { await exec("docker", ["network", "rm", net]); } catch { /* ignore */ }
    }
  }
}
