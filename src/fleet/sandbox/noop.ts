import type { SandboxRunner, SandboxRequest, SandboxResult } from "./types";

/** Default runner: smoke testing is disabled. Always passes so the deploy gate
 *  behaves exactly as it did before the sandbox existed. */
export class NoopSandboxRunner implements SandboxRunner {
  async run(_req?: SandboxRequest): Promise<SandboxResult> {
    return { passed: true, skipped: true, detail: "sandbox disabled", logs: "", durationMs: 0 };
  }
}
