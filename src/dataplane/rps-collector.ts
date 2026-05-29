/* ============================================================
   Real per-app RPS for the data plane (plan §19.7 — H).

   Separate port from `MetricsCollector` because the transport,
   wire-shape and rate-of-change logic for HTTP counters are
   completely different from `docker stats` (which only carries
   point-in-time CPU/memory percentages). Keeping them split lets
   `SshDockerStatsCollector` stay focused, and lets
   `TraefikRpsCollector` own the counter-delta math without
   leaking into the CPU/memory adapter.

   Returning `null` means "no real RPS available" — `sampleMetrics`
   then falls back to the synthesised baseline. The collector must
   never throw.
   ============================================================ */

import type { Region } from "../domain/types";

export interface RpsCollectorInput {
  /** Coolify Application UUID — when Traefik is configured to use
   *  the app uuid as the router name, this is the lookup key. */
  appUuid: string;
  /** Cantila/Coolify app name (`cantila-<projectId>`). Used as the
   *  primary router-name lookup since Coolify's Traefik labels
   *  default to the app name. */
  appName: string;
  /** Region the project lives in — the collector resolves its
   *  per-region Traefik metrics URL by this. */
  region: Region;
}

export interface RpsReading {
  /** Average requests-per-second over the most recent sample
   *  interval. Synthesised baseline can ride alongside; the data
   *  plane treats `null` from `collect()` as "no real reading". */
  rps: number;
}

export interface RpsCollector {
  collect(input: RpsCollectorInput): Promise<RpsReading | null>;
}
