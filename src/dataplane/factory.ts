/* ============================================================
   Data-plane selection (plan §19.10).

   Returns CoolifyDataPlane when the four COOLIFY_* env vars are all
   set; otherwise returns stubDataPlane. Mirrors how StripeAdapter,
   SsoProvider, TelephonyProvider and the rest auto-select.
   ============================================================ */

import type { DataPlane } from "../deploy/pipeline";
import type { Store } from "../domain/store";
import type { Region } from "../domain/types";
import { stubDataPlane } from "./stub";
import { CoolifyDataPlane, type CoolifyRegionConfig } from "./coolify";
import {
  SshDockerStatsCollector,
  type SshTarget,
} from "./ssh-docker-stats";
import {
  TraefikRpsCollector,
  type TraefikTarget,
} from "./traefik-rps";

export interface DataPlaneSelection {
  dataPlane: DataPlane;
  label: string;
  live: boolean;
}

export interface SelectDataPlaneOptions {
  /** When wired, the Coolify data plane persists the
   *  `coolifyAppUuid` field on the Cantila Project so restarts skip
   *  the full /applications scan. Optional — the data plane still
   *  works without it via the in-process cache (plan §19). */
  store?: Store;
}

/** Known Cantila regions — mirrors the `Region` union in types.ts.
 *  Lives here so env parsing can iterate without importing the type
 *  values at runtime. */
const REGIONS: Region[] = ["fsn1", "hel1", "ash"];

/** Build the per-region routing map from env. Recognised vars per
 *  region (uppercase region name):
 *    COOLIFY_REGION_<R>_SERVER_UUID
 *    COOLIFY_REGION_<R>_PROJECT_UUID
 *    COOLIFY_REGION_<R>_API_URL    (optional — defaults to COOLIFY_API_URL)
 *    COOLIFY_REGION_<R>_API_TOKEN  (optional — defaults to COOLIFY_API_TOKEN)
 *
 *  Returns `undefined` when no region-specific env is set — the
 *  caller falls back to the single-region COOLIFY_SERVER_UUID +
 *  COOLIFY_PROJECT_UUID pair. Plan §19.8. */
function parseRegions(
  env: NodeJS.ProcessEnv,
): Partial<Record<Region, CoolifyRegionConfig>> | undefined {
  const out: Partial<Record<Region, CoolifyRegionConfig>> = {};
  for (const region of REGIONS) {
    const prefix = `COOLIFY_REGION_${region.toUpperCase()}_`;
    const serverUuid = env[`${prefix}SERVER_UUID`]?.trim();
    // Within-region multi-node (plan §19.8): comma-separated list of
    // Coolify Server UUIDs. Takes precedence over `_SERVER_UUID` when
    // both are set so an operator can roll out a second node by
    // adding it to the list without rebuilding the env atomically.
    const serversRaw = env[`${prefix}SERVER_UUIDS`]?.trim();
    const servers = serversRaw
      ? serversRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const projectUuid = env[`${prefix}PROJECT_UUID`]?.trim();
    if (!projectUuid) continue;
    if (!serverUuid && (!servers || servers.length === 0)) continue;
    out[region] = {
      serverUuid,
      servers,
      projectUuid,
      apiUrl: env[`${prefix}API_URL`]?.trim() || undefined,
      apiToken: env[`${prefix}API_TOKEN`]?.trim() || undefined,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseDefaultRegion(env: NodeJS.ProcessEnv): Region | undefined {
  const raw = env.COOLIFY_DEFAULT_REGION?.trim().toLowerCase();
  if (!raw) return undefined;
  return REGIONS.includes(raw as Region) ? (raw as Region) : undefined;
}

/** Build the per-region SSH target map for the metrics collector
 *  (plan §19.7). Per-region env vars:
 *    COOLIFY_REGION_<R>_SSH_HOST
 *    COOLIFY_REGION_<R>_SSH_USER      (optional, default `root`)
 *    COOLIFY_REGION_<R>_SSH_PORT      (optional, default 22)
 *    COOLIFY_REGION_<R>_SSH_KEY_PATH  (optional, falls back to ssh-agent)
 *
 *  Back-compat single-region falls under `COOLIFY_SSH_HOST` (with the
 *  same `_USER` / `_PORT` / `_KEY_PATH` siblings); it lands under the
 *  default region. Returns an empty object when nothing is set —
 *  caller then skips constructing the collector and the data plane
 *  falls back to status-aware synthesis. */
function parseSshTargets(
  env: NodeJS.ProcessEnv,
  defaultRegion: Region,
): Partial<Record<Region, SshTarget>> {
  const out: Partial<Record<Region, SshTarget>> = {};
  for (const region of REGIONS) {
    const prefix = `COOLIFY_REGION_${region.toUpperCase()}_SSH_`;
    const host = env[`${prefix}HOST`]?.trim();
    if (!host) continue;
    out[region] = {
      host,
      user: env[`${prefix}USER`]?.trim() || undefined,
      port: parsePort(env[`${prefix}PORT`]),
      privateKeyPath: env[`${prefix}KEY_PATH`]?.trim() || undefined,
    };
  }
  // Back-compat single-region SSH config — only used when the default
  // region has no per-region SSH already.
  const legacyHost = env.COOLIFY_SSH_HOST?.trim();
  if (legacyHost && !out[defaultRegion]) {
    out[defaultRegion] = {
      host: legacyHost,
      user: env.COOLIFY_SSH_USER?.trim() || undefined,
      port: parsePort(env.COOLIFY_SSH_PORT),
      privateKeyPath: env.COOLIFY_SSH_KEY_PATH?.trim() || undefined,
    };
  }
  return out;
}

function parsePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : undefined;
}

/** Per-region Traefik /metrics URL map for the RPS collector
 *  (plan §19.7 — H). Per-region env vars:
 *    COOLIFY_REGION_<R>_TRAEFIK_METRICS_URL
 *    COOLIFY_REGION_<R>_TRAEFIK_METRICS_TOKEN  (optional bearer)
 *
 *  Single-region back-compat:
 *    COOLIFY_TRAEFIK_METRICS_URL
 *    COOLIFY_TRAEFIK_METRICS_TOKEN
 *
 *  Returns an empty object when nothing is set — the caller skips
 *  constructing the collector and the data plane falls back to
 *  the synthesised RPS baseline. */
function parseTraefikTargets(
  env: NodeJS.ProcessEnv,
  defaultRegion: Region,
): Partial<Record<Region, TraefikTarget>> {
  const out: Partial<Record<Region, TraefikTarget>> = {};
  for (const region of REGIONS) {
    const prefix = `COOLIFY_REGION_${region.toUpperCase()}_TRAEFIK_METRICS_`;
    const url = env[`${prefix}URL`]?.trim();
    if (!url) continue;
    out[region] = {
      metricsUrl: url,
      bearerToken: env[`${prefix}TOKEN`]?.trim() || undefined,
    };
  }
  const legacyUrl = env.COOLIFY_TRAEFIK_METRICS_URL?.trim();
  if (legacyUrl && !out[defaultRegion]) {
    out[defaultRegion] = {
      metricsUrl: legacyUrl,
      bearerToken: env.COOLIFY_TRAEFIK_METRICS_TOKEN?.trim() || undefined,
    };
  }
  return out;
}

export function selectDataPlane(
  env: NodeJS.ProcessEnv = process.env,
  opts: SelectDataPlaneOptions = {},
): DataPlaneSelection {
  const apiUrl = env.COOLIFY_API_URL?.trim();
  const apiToken = env.COOLIFY_API_TOKEN?.trim();
  let regions = parseRegions(env);
  const serverUuid = env.COOLIFY_SERVER_UUID?.trim();
  // Within-region multi-node single-region back-compat: comma-separated
  // list of server UUIDs in the implicit single region (plan §19.8).
  // When set, we synthesise a one-entry `regions` map keyed by the
  // default region so the multi-node selector runs.
  const legacyServersRaw = env.COOLIFY_SERVER_UUIDS?.trim();
  const legacyServers = legacyServersRaw
    ? legacyServersRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const projectUuid = env.COOLIFY_PROJECT_UUID?.trim();

  // Need API URL + token plus either a region map or the single-region pair.
  const haveLegacy =
    (serverUuid || (legacyServers && legacyServers.length > 0)) &&
    !!projectUuid;
  const haveRouting = regions !== undefined || haveLegacy;

  if (apiUrl && apiToken && haveRouting) {
    const store = opts.store;
    const persistAppUuid = store
      ? async (projectId: string, appUuid: string) => {
          await store.updateProject(projectId, { coolifyAppUuid: appUuid });
        }
      : undefined;

    const declaredDefault = parseDefaultRegion(env);
    const fallbackDefault: Region =
      declaredDefault ??
      (regions ? (Object.keys(regions)[0] as Region) : "fsn1");

    // Promote the legacy single-region multi-server list into a
    // synthesised one-region map so the data plane sees the full
    // server set. Only triggers when the operator opted into the new
    // env (and hasn't already supplied a full regions map).
    if (!regions && legacyServers && legacyServers.length > 1) {
      regions = {
        [fallbackDefault]: {
          serverUuid: serverUuid || undefined,
          servers: legacyServers,
          projectUuid: projectUuid!,
        },
      };
    }

    const sshTargets = parseSshTargets(env, fallbackDefault);
    const metricsCollector =
      Object.keys(sshTargets).length > 0
        ? new SshDockerStatsCollector({ targets: sshTargets })
        : undefined;

    const traefikTargets = parseTraefikTargets(env, fallbackDefault);
    const rpsCollector =
      Object.keys(traefikTargets).length > 0
        ? new TraefikRpsCollector({ targets: traefikTargets })
        : undefined;

    // Multi-node when any region has > 1 server OR the legacy
    // single-region path opted into `COOLIFY_SERVER_UUIDS`.
    const hasMultiNode = regions
      ? Object.values(regions).some(
          (r) => (r?.servers && r.servers.length > 1),
        )
      : (legacyServers?.length ?? 0) > 1;

    const liveLabel = buildLiveLabel({
      multiRegion: !!regions && Object.keys(regions).length > 1,
      multiNode: hasMultiNode,
      realMetrics: !!metricsCollector,
      realRps: !!rpsCollector,
    });

    return {
      dataPlane: new CoolifyDataPlane({
        apiUrl,
        apiToken,
        serverUuid: regions ? undefined : serverUuid,
        projectUuid: regions ? undefined : projectUuid,
        regions,
        defaultRegion: declaredDefault,
        environmentName: env.COOLIFY_ENVIRONMENT_NAME?.trim() || undefined,
        apexDomain: env.CANTILA_APEX_DOMAIN?.trim() || undefined,
        persistAppUuid,
        metricsCollector,
        rpsCollector,
      }),
      label: liveLabel,
      live: true,
    };
  }
  return { dataPlane: stubDataPlane, label: "stub", live: false };
}

function buildLiveLabel(flags: {
  multiRegion: boolean;
  multiNode: boolean;
  realMetrics: boolean;
  realRps: boolean;
}): string {
  const parts: string[] = [];
  if (flags.multiRegion) parts.push("multi-region");
  if (flags.multiNode) parts.push("multi-node");
  if (flags.realMetrics) parts.push("real metrics");
  if (flags.realRps) parts.push("real rps");
  return parts.length === 0 ? "Coolify" : `Coolify (${parts.join(", ")})`;
}
