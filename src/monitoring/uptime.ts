/* ============================================================
   Uptime checker — plan §5.3 (Observability).
   Periodically runs healthChecks against every live project and
   keeps a short history per project so the Console can render
   uptime monitors and the public status page.

   Lives in-process; production swaps for a distributed checker
   that runs from multiple regions. The contract is a ring-buffer
   of the last N results plus a derived uptime %.
   ============================================================ */

import type { Store } from "../domain/store";
import type { DataPlane } from "../deploy/pipeline";
import type { Project } from "../domain/types";
import { ownerAccountId } from "../lib/owner-account";

export type CheckStatus = "up" | "degraded" | "down";

export interface UptimeMonitor {
  projectId: string;
  projectSlug: string;
  projectName: string;
  url: string;
  region: Project["region"];
  status: CheckStatus;
  /** 0..100. */
  uptimePct: number;
  /** Average response time (ms) across the recent history. */
  responseMs: number;
  /** Newest-last ring buffer. */
  history: CheckStatus[];
  lastCheckedAt?: string;
}

interface Entry {
  history: CheckStatus[];
  lastResponseMs: number[];
  lastCheckedAt?: string;
}

const HISTORY_SIZE = 32;

export class UptimeChecker {
  private state = new Map<string, Entry>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private deps: { store: Store; dataPlane: DataPlane },
    /** Interval between sweeps in ms. */
    private intervalMs: number = 30_000,
  ) {}

  start(): void {
    if (this.timer) return;
    // Kick off the first sweep on the next tick so callers can finish wiring.
    setImmediate(() => void this.sweep().catch(() => {}));
    this.timer = setInterval(() => {
      void this.sweep().catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Run one health-check sweep across every project for an account. */
  async sweep(): Promise<void> {
    // Single-tenant for now — match the rest of the CP demo flow.
    const projects = await this.deps.store.listProjects(ownerAccountId());
    for (const p of projects) {
      await this.checkProject(p);
    }
  }

  private async checkProject(project: Project): Promise<void> {
    const url = `https://${project.slug}.cantila.app`;
    const t0 = Date.now();
    let healthy = false;
    try {
      healthy = await this.deps.dataPlane.healthCheck(url);
    } catch {
      healthy = false;
    }
    const responseMs = Date.now() - t0;

    // Converge stored status toward observed reality. A project frozen in a
    // non-terminal state ("building"/"provisioning") whose domain is serving
    // has lost its deploy's terminal write (the CP process died between the
    // "building" and "live" writes — see GUIDE-project-status-reconciliation).
    // Repair it so the Console stops showing "Building" on a live project.
    // Only the toward-live direction is reconciled here; the failure
    // direction (a build hung too long) is a time-bounded watchdog concern,
    // and deliberate states (paused/sleeping/crashed) are never overridden.
    if (
      healthy &&
      (project.status === "building" || project.status === "provisioning")
    ) {
      await this.deps.store.updateProject(project.id, { status: "live" });
    }

    const entry = this.state.get(project.id) ?? {
      history: [],
      lastResponseMs: [],
    };
    // Project status crashed → mark as down regardless of the stub's answer.
    const status: CheckStatus =
      project.status === "crashed"
        ? "down"
        : healthy
          ? "up"
          : project.status === "sleeping"
            ? "degraded"
            : "down";
    entry.history.push(status);
    if (entry.history.length > HISTORY_SIZE) entry.history.shift();
    entry.lastResponseMs.push(responseMs);
    if (entry.lastResponseMs.length > HISTORY_SIZE) entry.lastResponseMs.shift();
    entry.lastCheckedAt = new Date().toISOString();
    this.state.set(project.id, entry);
  }

  /** Snapshot — used by the HTTP endpoint and the Console. */
  async monitors(accountId: string): Promise<UptimeMonitor[]> {
    const projects = await this.deps.store.listProjects(accountId);
    return projects.map((p) => this.toMonitor(p));
  }

  private toMonitor(p: Project): UptimeMonitor {
    const entry = this.state.get(p.id) ?? {
      history: [],
      lastResponseMs: [],
    };
    const history =
      entry.history.length > 0
        ? entry.history
        : ([(p.status === "live" ? "up" : "down") as CheckStatus]);
    const up = history.filter((s) => s === "up").length;
    const uptimePct = Math.round((up / history.length) * 10000) / 100;
    const responseMs =
      entry.lastResponseMs.length > 0
        ? Math.round(
            entry.lastResponseMs.reduce((s, ms) => s + ms, 0) /
              entry.lastResponseMs.length,
          )
        : 0;
    const status = history[history.length - 1];
    return {
      projectId: p.id,
      projectSlug: p.slug,
      projectName: p.name,
      url: `https://${p.slug}.cantila.app`,
      region: p.region,
      status,
      uptimePct,
      responseMs,
      history,
      lastCheckedAt: entry.lastCheckedAt,
    };
  }
}
