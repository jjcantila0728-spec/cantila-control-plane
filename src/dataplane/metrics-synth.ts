/* ============================================================
   Shared metric synthesis for live data planes.

   Coolify v4's public REST does not expose per-app CPU/memory
   time series, and `docker stats` carries no HTTP counters, so
   both the Coolify and VPS data planes synthesise a plausible,
   status-aware sample window — anchoring the newest sample to a
   real reading (SSH `docker stats` / Traefik `/metrics`) when one
   is available. Extracted here so both adapters share one copy.
   ============================================================ */

import type { Project, ProjectMetricSample } from "../domain/types";

/** Build a 12-sample window (last minute @ 5s) for a project. When a real
 *  CPU/memory `reading` and/or `rpsReading` is supplied the newest sample
 *  lands exactly on it (no jitter) so Console gauges + ScaleAgent see ground
 *  truth; older samples smooth-jitter around it so the sparkline reads like a
 *  series. Without a reading, a down status zeroes everything. */
export function synthesiseMetrics(
  project: Project,
  liveStatus?: string,
  reading?: { cpuPct: number; memPct: number; replicas: number } | null,
  rpsReading?: { rps: number } | null,
): ProjectMetricSample[] {
  const SAMPLE_COUNT = 12;
  const INTERVAL_MS = 5_000;
  const now = Date.now();
  const seed = hashSeed(project.id);
  const effectiveStatus = mapContainerStatus(liveStatus) ?? project.status;
  const baseCpu = reading
    ? reading.cpuPct
    : effectiveStatus === "live"
      ? 25 + (seed % 30)
      : effectiveStatus === "sleeping"
        ? 2 + (seed % 5)
        : 0;
  const baseRps = rpsReading
    ? rpsReading.rps
    : effectiveStatus === "live"
      ? 4 + (seed % 12)
      : effectiveStatus === "sleeping"
        ? 0.1 + (seed % 5) / 10
        : 0;
  const baseMem = reading
    ? reading.memPct
    : effectiveStatus === "live" || effectiveStatus === "sleeping"
      ? 35 + (seed % 25)
      : 0;
  const out: ProjectMetricSample[] = [];
  for (let i = SAMPLE_COUNT - 1; i >= 0; i--) {
    const at = new Date(now - i * INTERVAL_MS).toISOString();
    if (
      !reading &&
      (effectiveStatus === "crashed" ||
        effectiveStatus === "paused" ||
        effectiveStatus === "provisioning" ||
        effectiveStatus === "building")
    ) {
      out.push({ at, cpuPct: 0, memPct: 0, rps: 0 });
      continue;
    }
    const jitter = (Math.random() - 0.5) * 0.2;
    const cpuJ = i === 0 && reading ? 0 : jitter;
    const memJ = i === 0 && reading ? 0 : jitter * 0.5;
    const rpsJ = i === 0 && rpsReading ? 0 : jitter;
    out.push({
      at,
      cpuPct: Math.round(clamp(baseCpu * (1 + cpuJ), 0, 100) * 10) / 10,
      memPct: Math.round(clamp(baseMem * (1 + memJ), 0, 100) * 10) / 10,
      rps: Math.round(Math.max(0, baseRps * (1 + rpsJ)) * 10) / 10,
    });
  }
  return out;
}

/** Translate a container/runtime status string (Coolify resource status or a
 *  raw `docker inspect` State.Status) into the Cantila Project status
 *  vocabulary. Returns `undefined` when unrecognised — the caller then uses
 *  the Cantila-side status instead. */
export function mapContainerStatus(
  s: string | undefined,
): "live" | "sleeping" | "crashed" | "paused" | undefined {
  if (!s) return undefined;
  const lower = s.toLowerCase();
  if (lower.startsWith("running")) return "live";
  if (lower.startsWith("exited") || lower.startsWith("dead")) return "crashed";
  if (lower.startsWith("paused")) return "paused";
  if (lower.startsWith("restarting") || lower.startsWith("created"))
    return "sleeping";
  return undefined;
}

export function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
