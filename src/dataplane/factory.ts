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
    const projectUuid = env[`${prefix}PROJECT_UUID`]?.trim();
    if (!serverUuid || !projectUuid) continue;
    out[region] = {
      serverUuid,
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

export function selectDataPlane(
  env: NodeJS.ProcessEnv = process.env,
  opts: SelectDataPlaneOptions = {},
): DataPlaneSelection {
  const apiUrl = env.COOLIFY_API_URL?.trim();
  const apiToken = env.COOLIFY_API_TOKEN?.trim();
  const regions = parseRegions(env);
  const serverUuid = env.COOLIFY_SERVER_UUID?.trim();
  const projectUuid = env.COOLIFY_PROJECT_UUID?.trim();

  // Need API URL + token plus either a region map or the single-region pair.
  const haveRouting =
    regions !== undefined || (serverUuid && projectUuid);

  if (apiUrl && apiToken && haveRouting) {
    const store = opts.store;
    const persistAppUuid = store
      ? async (projectId: string, appUuid: string) => {
          await store.updateProject(projectId, { coolifyAppUuid: appUuid });
        }
      : undefined;
    return {
      dataPlane: new CoolifyDataPlane({
        apiUrl,
        apiToken,
        serverUuid,
        projectUuid,
        regions,
        defaultRegion: parseDefaultRegion(env),
        environmentName: env.COOLIFY_ENVIRONMENT_NAME?.trim() || undefined,
        apexDomain: env.CANTILA_APEX_DOMAIN?.trim() || undefined,
        persistAppUuid,
      }),
      label: regions ? "Coolify (multi-region)" : "Coolify",
      live: true,
    };
  }
  return { dataPlane: stubDataPlane, label: "stub", live: false };
}
