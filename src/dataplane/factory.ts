/* ============================================================
   Data-plane selection (plan §19.10).

   Returns CoolifyDataPlane when the four COOLIFY_* env vars are all
   set; otherwise returns stubDataPlane. Mirrors how StripeAdapter,
   SsoProvider, TelephonyProvider and the rest auto-select.
   ============================================================ */

import type { DataPlane } from "../deploy/pipeline";
import { stubDataPlane } from "./stub";
import { CoolifyDataPlane } from "./coolify";

export interface DataPlaneSelection {
  dataPlane: DataPlane;
  label: string;
  live: boolean;
}

export function selectDataPlane(env: NodeJS.ProcessEnv = process.env): DataPlaneSelection {
  const apiUrl = env.COOLIFY_API_URL?.trim();
  const apiToken = env.COOLIFY_API_TOKEN?.trim();
  const serverUuid = env.COOLIFY_SERVER_UUID?.trim();
  const projectUuid = env.COOLIFY_PROJECT_UUID?.trim();

  if (apiUrl && apiToken && serverUuid && projectUuid) {
    return {
      dataPlane: new CoolifyDataPlane({
        apiUrl,
        apiToken,
        serverUuid,
        projectUuid,
        environmentName: env.COOLIFY_ENVIRONMENT_NAME?.trim() || undefined,
        apexDomain: env.CANTILA_APEX_DOMAIN?.trim() || undefined,
      }),
      label: "Coolify",
      live: true,
    };
  }
  return { dataPlane: stubDataPlane, label: "stub", live: false };
}
