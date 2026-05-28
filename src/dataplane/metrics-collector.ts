/* ============================================================
   Real per-container metrics for the data plane (plan §19.7).

   Coolify v4's public REST API does NOT expose per-app CPU/memory
   time series — both `/applications/{uuid}/metrics` and
   `/servers/{uuid}/metrics` 404 even with `is_metrics_enabled: true`.
   This port is the seam the live data plane reaches through to
   collect real readings from somewhere else: today an SSH path that
   reads `docker stats` on the host (see `ssh-docker-stats.ts`), and
   later either a node_exporter sidecar or — if Coolify ever ships
   one — Sentinel's HTTP surface.

   Returning `null` is the contract for "no live reading available".
   The data plane then falls back to the existing status-aware
   synthesis so the activity feed and the ScaleAgent still get
   plausible numbers.
   ============================================================ */

import type { Region } from "../domain/types";

export interface MetricsCollectorInput {
  /** Coolify Application UUID — used to filter the host's containers
   *  by `coolify.applicationId` label, since Coolify launches one
   *  container per app + (optional) replica. */
  appUuid: string;
  /** Cantila/Coolify app name (`cantila-<projectId>`). Available as a
   *  fallback container filter if labels are missing on older
   *  containers. */
  appName: string;
  /** The region this project lives in — collector implementations
   *  resolve their per-region SSH target (or equivalent transport)
   *  by this. */
  region: Region;
}

export interface MetricsReading {
  /** Average CPU utilisation across replicas, 0–100. */
  cpuPct: number;
  /** Average memory utilisation across replicas, 0–100. */
  memPct: number;
  /** Number of running replicas that reported. Zero → returned `null`
   *  from `collect`; this field is therefore always ≥ 1 on a real
   *  reading. */
  replicas: number;
}

export interface MetricsCollector {
  /** Returns a real per-app reading, or `null` if the collector
   *  can't produce one (transport down, app not running, unknown
   *  region, etc). Must never throw — the data plane treats `null`
   *  and a thrown error identically (fall back to synthesis) but the
   *  no-throw contract keeps the call site clean. */
  collect(input: MetricsCollectorInput): Promise<MetricsReading | null>;
}
