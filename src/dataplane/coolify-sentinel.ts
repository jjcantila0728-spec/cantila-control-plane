/* ============================================================
   Coolify Sentinel metrics collector (plan §19.7 — D, stub).

   Coolify's internal "Sentinel" agent collects per-container CPU /
   memory and powers the dashboard's live tile, but as of 2026-05-28
   it does NOT expose those series via the public REST API — both
   `/applications/<uuid>/metrics` and `/servers/<uuid>/metrics`
   return 404 even with `is_metrics_enabled: true` (probed live on
   the FSN1 panel; see `scripts/probe-coolify-sentinel.mjs` for the
   exact probe list).

   This adapter is the seam that drops in if/when a public endpoint
   appears. Today it always returns `null`, so the data plane falls
   back to `SshDockerStatsCollector` (when configured) and then to
   the status-aware synthesis. The shape — `{ apiUrl, apiToken,
   endpointTemplate }` — lets the operator point at a discovered
   path without editing the data-plane source, by setting
   `COOLIFY_SENTINEL_METRICS_PATH` (e.g. `/sentinel/metrics?app={appUuid}`).
   The placeholder `{appUuid}` is substituted at request time.

   This file deliberately ships as a stub rather than wired into the
   factory — when the probe surfaces a working endpoint, the factory
   gets one more `else if` branch that prefers Sentinel over SSH
   (real HTTP < real SSH for latency + auth surface).
   ============================================================ */

import type {
  MetricsCollector,
  MetricsCollectorInput,
  MetricsReading,
} from "./metrics-collector";
import type { Region } from "../domain/types";

export interface CoolifySentinelOptions {
  /** Per-region Coolify panel binding. Same shape as the data plane's
   *  region map so the factory can pass them straight through. */
  regions: Partial<
    Record<
      Region,
      { apiUrl: string; apiToken: string; serverUuid: string }
    >
  >;
  /** Template for the metrics path. Placeholders:
   *    {appUuid}     — Coolify Application UUID
   *    {serverUuid}  — Coolify Server UUID for the project's region
   *  Example (hypothetical):
   *    `/servers/{serverUuid}/sentinel/metrics?application={appUuid}`. */
  endpointTemplate: string;
  /** HTTP timeout in ms — default 4000. */
  timeoutMs?: number;
}

export class CoolifySentinelCollector implements MetricsCollector {
  private readonly opts: CoolifySentinelOptions;

  constructor(opts: CoolifySentinelOptions) {
    this.opts = opts;
  }

  async collect(input: MetricsCollectorInput): Promise<MetricsReading | null> {
    const region = this.opts.regions[input.region];
    if (!region) return null;
    const path = this.opts.endpointTemplate
      .replace(/\{appUuid\}/g, encodeURIComponent(input.appUuid))
      .replace(/\{serverUuid\}/g, encodeURIComponent(region.serverUuid));
    try {
      const res = await fetch(`${region.apiUrl.replace(/\/+$/, "")}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${region.apiToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 4_000),
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as
        | SentinelResponse
        | null;
      return parseSentinelResponse(body);
    } catch {
      return null;
    }
  }
}

/** Tolerant parser — the eventual Coolify response shape is unknown,
 *  so this handles the two most likely forms: a single object with
 *  `cpuPercent` / `memoryPercent`, or an array of per-replica
 *  readings to average. Adjust once the shape is confirmed by
 *  `scripts/probe-coolify-sentinel.mjs`. */
type SentinelResponse =
  | { cpuPercent?: number; memoryPercent?: number }
  | Array<{ cpuPercent?: number; memoryPercent?: number }>
  | { data?: Array<{ cpuPercent?: number; memoryPercent?: number }> };

export function parseSentinelResponse(
  body: SentinelResponse | null,
): MetricsReading | null {
  if (!body) return null;
  const rows: Array<{ cpuPercent?: number; memoryPercent?: number }> =
    Array.isArray(body)
      ? body
      : "data" in body && Array.isArray(body.data)
        ? body.data
        : [body as { cpuPercent?: number; memoryPercent?: number }];
  const usable = rows.filter(
    (r) =>
      typeof r.cpuPercent === "number" && typeof r.memoryPercent === "number",
  );
  if (usable.length === 0) return null;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    cpuPct:
      Math.round(
        clamp(avg(usable.map((r) => r.cpuPercent!)), 0, 100) * 10,
      ) / 10,
    memPct:
      Math.round(
        clamp(avg(usable.map((r) => r.memoryPercent!)), 0, 100) * 10,
      ) / 10,
    replicas: usable.length,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
