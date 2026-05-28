/* ============================================================
   Data-plane selection (plan §19.10).

   Returns CoolifyDataPlane when the four COOLIFY_* env vars are all
   set; otherwise returns stubDataPlane. Mirrors how StripeAdapter,
   SsoProvider, TelephonyProvider and the rest auto-select.
   ============================================================ */

import type { DataPlane } from "../deploy/pipeline";
import type { Store } from "../domain/store";
import { stubDataPlane } from "./stub";
import { CoolifyDataPlane } from "./coolify";

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

export function selectDataPlane(
  env: NodeJS.ProcessEnv = process.env,
  opts: SelectDataPlaneOptions = {},
): DataPlaneSelection {
  const apiUrl = env.COOLIFY_API_URL?.trim();
  const apiToken = env.COOLIFY_API_TOKEN?.trim();
  const serverUuid = env.COOLIFY_SERVER_UUID?.trim();
  const projectUuid = env.COOLIFY_PROJECT_UUID?.trim();

  if (apiUrl && apiToken && serverUuid && projectUuid) {
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
        environmentName: env.COOLIFY_ENVIRONMENT_NAME?.trim() || undefined,
        apexDomain: env.CANTILA_APEX_DOMAIN?.trim() || undefined,
        persistAppUuid,
      }),
      label: "Coolify",
      live: true,
    };
  }
  return { dataPlane: stubDataPlane, label: "stub", live: false };
}
