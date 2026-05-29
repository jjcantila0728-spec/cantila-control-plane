/* ============================================================
   Simulated data plane.
   Returns plausible values without touching real infrastructure —
   the control-plane equivalent of the Console's mock-data layer.
   Swap for real adapters (Docker, a registry, Traefik, Hetzner) to
   go live; nothing else in the codebase changes.
   ============================================================ */

import type { Project, ProjectMetricSample, Runtime } from "../domain/types";
import type { ServiceProvisioner } from "../deploy/provisioning";
import type { DataPlane, DeploySource } from "../deploy/pipeline";
import { id, secret } from "../lib/ids";

export const stubProvisioner: ServiceProvisioner = {
  async createDatabase(project: Project) {
    return {
      engine: "postgres",
      version: "16.3",
      connectionUri: `postgres://app:${secret().slice(0, 24)}@db-${project.slug}.int.cantila.cloud:5432/${project.slug}`,
    };
  },

  async createMailbox(project: Project) {
    const sendingDomain = `${project.slug}.send.cantila.email`;
    return {
      address: `mailer@${sendingDomain}`,
      sendingDomain,
      smtpHost: "smtp.cantila.email",
      smtpUser: project.slug,
      smtpPassword: secret().slice(0, 32),
    };
  },
};

export const stubDataPlane: DataPlane = {
  async detectStack(source: DeploySource): Promise<Runtime> {
    return source.kind === "upload" ? "docker" : "node";
  },

  async buildImage(project: Project) {
    return {
      imageRef: `registry.cantila.cloud/${project.slug}:${id("img").slice(4, 14)}`,
    };
  },

  async schedule(project: Project) {
    return { nodeId: `node-${project.region}-01` };
  },

  async startContainer() {
    // no-op — the simulated data plane does not run real containers
  },

  async route(project: Project) {
    return { url: `https://${project.slug}.cantila.app` };
  },

  async healthCheck() {
    return true;
  },

  async sampleMetrics(project: Project): Promise<ProjectMetricSample[]> {
    // 12 samples = the last minute at 5-second intervals. Plausible
    // values derived from project state — `live` projects emit moderate
    // load with some noise; `crashed` and `paused` projects emit zeros;
    // `sleeping` projects emit a low floor. Production reads real Docker
    // / kube stats + LB counters here.
    const SAMPLE_COUNT = 12;
    const INTERVAL_MS = 5_000;
    const now = Date.now();

    // Establish per-project bases so two consecutive reads of the same
    // project line up visually but two projects look different.
    const seed = hashSeed(project.id);
    const baseCpu =
      project.status === "live"
        ? 25 + seed % 30 // 25–55%
        : project.status === "sleeping"
          ? 2 + seed % 5  // 2–7%
          : 0;
    const baseRps =
      project.status === "live"
        ? 4 + seed % 12   // 4–16 rps
        : project.status === "sleeping"
          ? 0.1 + (seed % 5) / 10
          : 0;
    const baseMem =
      project.status === "live" || project.status === "sleeping"
        ? 35 + seed % 25 // 35–60%
        : 0;

    const out: ProjectMetricSample[] = [];
    for (let i = SAMPLE_COUNT - 1; i >= 0; i--) {
      const at = new Date(now - i * INTERVAL_MS).toISOString();
      // Random noise around the base. `crashed` / `paused` stays at 0.
      if (
        project.status === "crashed" ||
        project.status === "paused" ||
        project.status === "provisioning" ||
        project.status === "building"
      ) {
        out.push({ at, cpuPct: 0, memPct: 0, rps: 0 });
        continue;
      }
      const jitter = (Math.random() - 0.5) * 0.2; // ±10%
      const cpuPct = clamp(baseCpu * (1 + jitter), 0, 100);
      const memPct = clamp(baseMem * (1 + jitter * 0.5), 0, 100);
      const rps = Math.max(0, baseRps * (1 + jitter));
      out.push({
        at,
        cpuPct: Math.round(cpuPct * 10) / 10,
        memPct: Math.round(memPct * 10) / 10,
        rps: Math.round(rps * 10) / 10,
      });
    }
    return out;
  },
};

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
