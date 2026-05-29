/* ============================================================
   Traefik /metrics RPS collector (plan §19.7).

   Coolify v4 uses Traefik as its edge proxy. When Traefik is
   started with `--metrics.prometheus=true --entryPoints.metrics.
   address=:8082`, it exposes a Prometheus `/metrics` endpoint with
   one `traefik_router_requests_total{router="<name>@<provider>"}`
   counter per router. The counter is monotonic — RPS is the delta
   between two scrapes divided by the elapsed seconds.

   This collector:
   1. Fetches the Prometheus text on every `collect()` call.
   2. Sums the counters that match the project's router name (the
      Coolify-managed Traefik labels default to the app name).
   3. Stores `(timestamp, count)` per app, returns the rate against
      the previous scrape.

   Returns `null` on:
   - no metrics URL for the region,
   - HTTP / parse failure,
   - first scrape (no prior sample to delta against) — the caller
     just sees synthesised RPS until the second sample lands.

   Never throws.
   ============================================================ */

import type {
  RpsCollector,
  RpsCollectorInput,
  RpsReading,
} from "./rps-collector";
import type { Region } from "../domain/types";

export interface TraefikTarget {
  /** Absolute URL to Traefik's Prometheus `/metrics` endpoint,
   *  e.g. `http://168.119.97.112:8082/metrics`. */
  metricsUrl: string;
  /** Optional bearer token if the endpoint is auth-gated. Most
   *  Coolify installs leave Traefik's metrics endpoint open on the
   *  internal docker network — this slot is here for the day it
   *  gets fronted by a basic-auth or token proxy. */
  bearerToken?: string;
}

export interface TraefikRpsOptions {
  targets: Partial<Record<Region, TraefikTarget>>;
  /** Fetch timeout in ms — default 4000. The data plane is on the
   *  metrics-API request path so the budget has to be tight. */
  timeoutMs?: number;
}

interface Sample {
  /** Epoch ms when the count was observed. */
  at: number;
  /** Cumulative request count summed across matching routers. */
  count: number;
}

export class TraefikRpsCollector implements RpsCollector {
  private readonly targets: Partial<Record<Region, TraefikTarget>>;
  private readonly timeoutMs: number;
  /** `<region>:<appName>` → last sample. Keeps history bounded to
   *  one entry per app — there is no need to retain anything older. */
  private readonly samples = new Map<string, Sample>();

  constructor(opts: TraefikRpsOptions) {
    this.targets = opts.targets;
    this.timeoutMs = opts.timeoutMs ?? 4_000;
  }

  async collect(input: RpsCollectorInput): Promise<RpsReading | null> {
    const target = this.targets[input.region];
    if (!target) return null;

    const headers: Record<string, string> = { Accept: "text/plain" };
    if (target.bearerToken) {
      headers.Authorization = `Bearer ${target.bearerToken}`;
    }

    let text: string;
    try {
      const res = await fetch(target.metricsUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      text = await res.text();
    } catch {
      return null;
    }

    const count = sumRouterRequestCount(text, input.appName, input.appUuid);
    if (count == null) return null;

    const now = Date.now();
    const key = `${input.region}:${input.appName}`;
    const prior = this.samples.get(key);
    this.samples.set(key, { at: now, count });

    if (!prior) {
      // First scrape — we have nothing to delta against. Return
      // `null` so the data plane stays on synthesised RPS until the
      // next call lands.
      return null;
    }

    const dt = (now - prior.at) / 1000;
    if (dt <= 0) return null;
    const delta = count - prior.count;
    // Counter resets (Traefik restart, label rename) can produce a
    // negative delta — treat that as "we don't have a real reading
    // this round" rather than reporting a spurious negative RPS.
    if (delta < 0) return null;

    return { rps: Math.round((delta / dt) * 10) / 10 };
  }
}

/** Walk a Prometheus text exposition and sum every line that
 *  matches `traefik_router_requests_total` whose `router` label
 *  starts with the app's Coolify Traefik router name. Coolify
 *  labels routers as `<appUuid>-<deploymentSuffix>@docker` on some
 *  configs and `<appName>@docker` on others — we accept either.
 *
 *  Returns `null` when no matching counter line is found at all,
 *  so a fresh app (no traffic yet) doesn't get a fake 0 reading
 *  that contaminates the synthesised baseline. */
export function sumRouterRequestCount(
  text: string,
  appName: string,
  appUuid: string,
): number | null {
  // Each line looks like:
  //   traefik_router_requests_total{code="200",method="GET",
  //     protocol="http",router="cantila-prj_abc-svc@docker"} 1234
  //
  // The label value is double-quoted; the metric ends with whitespace
  // + a numeric value. We pull `router=...` out and check it against
  // the Cantila app's known names.
  const lines = text.split("\n");
  let total = 0;
  let matched = 0;
  for (const line of lines) {
    if (!line.startsWith("traefik_router_requests_total")) continue;
    const routerMatch = /router="([^"]+)"/.exec(line);
    if (!routerMatch) continue;
    const router = routerMatch[1]!;
    // Router name in Coolify usually contains the app name or uuid —
    // either substring match is enough since routers carry their
    // provider suffix (`@docker`) and may include rule suffixes.
    if (!router.includes(appName) && !router.includes(appUuid)) continue;
    const valueMatch = /\}\s+([0-9eE+\-.]+)\s*$/.exec(line);
    if (!valueMatch) continue;
    const n = Number(valueMatch[1]);
    if (!Number.isFinite(n)) continue;
    total += n;
    matched++;
  }
  return matched === 0 ? null : total;
}
