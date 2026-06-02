/* ============================================================
   Super-user authz (super-user management, slice 1).

   A pure decision function over a resolved Console session. Lives in
   its own module — separate from index.ts (which calls app.listen at
   import time) — so it is unit-testable without booting the server,
   mirroring how getApiKey/getSessionAuth were extracted into account.ts.
   ============================================================ */

import type { SessionAuth } from "./account";
import type { PlatformRole } from "../domain/types";

export type SuperuserDecision =
  | { ok: true; session: SessionAuth }
  | { ok: false; status: 401 | 403; error: string };

/** Decide whether `session` may access a platform super-user surface.
 *  `allow` defaults to superadmin-only; pass `["superadmin", "support"]`
 *  for read routes that `support` may also reach. Returns a discriminated
 *  decision — the caller maps `{status, error}` to a Fastify reply. */
export function authorizeSuperuser(
  session: SessionAuth | undefined,
  allow: PlatformRole[] = ["superadmin"],
): SuperuserDecision {
  if (!session) {
    return { ok: false, status: 401, error: "session required (Bearer cts_ token)" };
  }
  const role = session.platformRole;
  if (!role || !allow.includes(role)) {
    return { ok: false, status: 403, error: "super-user access required" };
  }
  return { ok: true, session };
}
