/* Build sandbox — pre-deploy smoke test. A SandboxRunner takes a freshly built
   product workspace, boots it in isolation, and reports whether it actually runs.
   Two adapters implement this port: NoopSandboxRunner (default, no-op) and
   DockerSandboxRunner (real, behind FLEET_SANDBOX=docker). See
   docs/superpowers/specs/2026-06-04-build-sandbox-design.md. */

export interface SandboxRequest {
  /** Absolute path to the built product workspace. */
  workspaceDir: string;
  /** Stack hint from DeployPlan.stack (e.g. "next", "node"). */
  stack: string;
  projectId: string;
  /** Overrides config default when set. */
  timeoutMs?: number;
}

export interface SandboxResult {
  /** True when the product booted and answered HTTP (or the runner is a no-op). */
  passed: boolean;
  /** True when no real smoke test ran (Noop / disabled). */
  skipped?: boolean;
  /** Human summary for the orchestrator op card. */
  detail: string;
  /** Captured build/container logs, truncated. */
  logs: string;
  durationMs: number;
}

export interface SandboxRunner {
  run(req: SandboxRequest): Promise<SandboxResult>;
}
