/* ============================================================
   SecurityAgent — watches for auth abuse and stale credentials
   (plan §4.9 — "Auth failures, unauthorised mutations").

   v1 reasons over three signals the control plane already has:

     1. Auth-failure ring (cp.getAuthFailures) — bursts of
        `invalid_key`, `no_credentials`, `scope_denied`, or
        `cross_account` rejections that arrived recently.
     2. Stale admin keys — `lastUsedAt` older than the staleness
        window, or never-used keys older than the unused window.
     3. Open-door deployment — auth is not enforced
        (CANTILA_REQUIRE_AUTH=false) while ≥1 Account row exists,
        meaning a production tenant is reachable without a key.

   All proposals are queued for human review — security actions
   never auto-apply in v1. (Per plan §4.9 safety: destructive
   actions wait for human confirmation.) When telemetry matures
   we can promote `revoke clearly-compromised key` to a high-
   confidence destructive auto-apply, matching the §4.9 table's
   "Locks compromised keys" line.
   ============================================================ */

import type { ControlPlane, AuthFailureRecord } from "../core/control-plane";
import { config } from "../config";
import { id as makeId, now } from "../lib/ids";
import type { Agent, Observation, Proposal } from "./types";

/** Treat ≥10 failures inside this window as a burst worth flagging. */
const BURST_WINDOW_MS = 5 * 60 * 1000;
const BURST_THRESHOLD = 10;
/** Per-prefix attribution: ≥5 failures inside the burst window from one
 *  visible key prefix → that key looks compromised. */
const PREFIX_THRESHOLD = 5;
/** A key the operator has not used in this long is a candidate for revoke. */
const STALE_KEY_DAYS = 60;
/** A key minted but never used after this long is also a revoke candidate. */
const UNUSED_KEY_DAYS = 14;

function daysSince(iso: string): number {
  return (Date.now() - Date.parse(iso)) / (24 * 60 * 60 * 1000);
}

function tally<T extends string | number>(
  rows: AuthFailureRecord[],
  by: (r: AuthFailureRecord) => T | undefined,
): Map<T, number> {
  const out = new Map<T, number>();
  for (const r of rows) {
    const k = by(r);
    if (k === undefined) continue;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

export class SecurityAgent implements Agent {
  readonly name = "security" as const;

  async observe(cp: ControlPlane): Promise<Observation[]> {
    const out: Observation[] = [];
    const sinceIso = new Date(Date.now() - BURST_WINDOW_MS).toISOString();
    const recent = cp.getAuthFailures(sinceIso);

    if (recent.length >= BURST_THRESHOLD) {
      out.push({
        at: now(),
        agent: this.name,
        kind: "auth_failure_burst",
        detail: `${recent.length} auth failures in the last ${BURST_WINDOW_MS / 60_000} min`,
      });
    }

    const byPrefix = tally(recent, (r) => r.keyPrefix);
    for (const [prefix, count] of byPrefix) {
      if (count >= PREFIX_THRESHOLD) {
        out.push({
          at: now(),
          agent: this.name,
          kind: "prefix_burst",
          detail: `key ${prefix}… contributed ${count} of the recent failures`,
        });
      }
    }

    // Stale keys — needs to walk every account. countAccounts is cheap;
    // listAccounts gives us every tenant. (SecurityAgent is the one cross-
    // account observer in the brain; other agents are scoped to acc_demo.)
    const accounts = await cp.listAccounts();
    for (const account of accounts) {
      const keys = await cp.listApiKeys(account.id);
      for (const key of keys) {
        const referenceIso = key.lastUsedAt ?? key.createdAt;
        const age = daysSince(referenceIso);
        const threshold = key.lastUsedAt ? STALE_KEY_DAYS : UNUSED_KEY_DAYS;
        if (age >= threshold) {
          out.push({
            at: now(),
            agent: this.name,
            kind: key.lastUsedAt ? "stale_key" : "unused_key",
            detail:
              `key "${key.name}" (${key.prefix}…, scope ${key.scope}) ` +
              `${key.lastUsedAt ? "last used" : "minted"} ${Math.round(age)} days ago`,
          });
        }
      }
    }

    // Open-door check — auth is off but tenants exist.
    if (!config.requireAuth && accounts.length > 0) {
      out.push({
        at: now(),
        agent: this.name,
        kind: "auth_not_enforced",
        detail: `CANTILA_REQUIRE_AUTH=false with ${accounts.length} account(s) — every write route is open`,
      });
    }

    return out;
  }

  async propose(cp: ControlPlane): Promise<Proposal[]> {
    const out: Proposal[] = [];
    const sinceIso = new Date(Date.now() - BURST_WINDOW_MS).toISOString();
    const recent = cp.getAuthFailures(sinceIso);

    // 1. Per-prefix burst → propose revoking that specific key. Destructive
    //    (operator may still want the key for an audit), medium confidence
    //    when ≥ PREFIX_THRESHOLD, high when ≥ 3× threshold.
    const byPrefix = tally(recent, (r) => r.keyPrefix);
    for (const [prefix, count] of byPrefix) {
      if (count < PREFIX_THRESHOLD) continue;
      // Find the key (if any) so the proposal carries a concrete id and the
      // execute closure has something to call. The prefix isn't unique across
      // accounts in theory but is in practice (12 hex chars of entropy).
      const accounts = await cp.listAccounts();
      let matched: { keyId: string; name: string; accountId: string } | null = null;
      for (const account of accounts) {
        const keys = await cp.listApiKeys(account.id);
        const k = keys.find((row) => row.prefix === prefix);
        if (k) {
          matched = { keyId: k.id, name: k.name, accountId: k.accountId };
          break;
        }
      }
      const high = count >= PREFIX_THRESHOLD * 3;
      out.push({
        id: `prop_${makeId("sec").slice(3)}_prefix_${prefix}`,
        at: now(),
        agent: this.name,
        kind: "revoke_compromised_key",
        title: matched
          ? `Revoke "${matched.name}" — ${count} failures from ${prefix}…`
          : `Lock down prefix ${prefix}… — ${count} failures, no matching key`,
        body: matched
          ? `Key "${matched.name}" (${prefix}…) produced ${count} rejected requests in the last ${BURST_WINDOW_MS / 60_000} min. That's consistent with a compromised credential being probed. Revoke now, then audit ${matched.name}'s last legitimate use before re-issuing.`
          : `Prefix ${prefix}… produced ${count} rejected requests in the last ${BURST_WINDOW_MS / 60_000} min but no live key shares that prefix — almost certainly someone guessing key shapes. Consider IP-blocking the source if the gateway in front of Cantila supports it.`,
        confidence: high ? "high" : "medium",
        actionClass: "destructive",
        hints: matched
          ? [
              {
                label: "Revoke via CLI",
                hint: `cantila keys revoke ${matched.keyId}`,
              },
            ]
          : [],
        execute: async (controlPlane) => {
          if (!matched) {
            return {
              ok: true,
              detail: `Acknowledged — no live key matches ${prefix}…, nothing to revoke.`,
            };
          }
          const result = await controlPlane.revokeApiKey(
            matched.keyId,
            matched.accountId,
          );
          if ("error" in result) {
            return { ok: false, detail: result.error };
          }
          return {
            ok: true,
            detail: `Revoked "${matched.name}" (${prefix}…) — ${count} failures observed`,
          };
        },
      });
    }

    // 2. Stale / unused keys → low-confidence revoke proposal, queue only.
    const accounts = await cp.listAccounts();
    for (const account of accounts) {
      const keys = await cp.listApiKeys(account.id);
      for (const key of keys) {
        const referenceIso = key.lastUsedAt ?? key.createdAt;
        const age = daysSince(referenceIso);
        const threshold = key.lastUsedAt ? STALE_KEY_DAYS : UNUSED_KEY_DAYS;
        if (age < threshold) continue;
        const ageDays = Math.round(age);
        out.push({
          id: `prop_${makeId("sec").slice(3)}_stale_${key.id}`,
          at: now(),
          agent: this.name,
          kind: key.lastUsedAt ? "revoke_stale_key" : "revoke_unused_key",
          title: key.lastUsedAt
            ? `Revoke stale key "${key.name}" — unused for ${ageDays} days`
            : `Revoke never-used key "${key.name}" — minted ${ageDays} days ago`,
          body: key.lastUsedAt
            ? `Key "${key.name}" (${key.prefix}…) hasn't been touched in ${ageDays} days. Long-lived unused credentials are a soft attack surface — every day they sit unrevoked is a day a leaked copy could be cashed in. Confirm with the team before revoking.`
            : `Key "${key.name}" (${key.prefix}…) was minted ${ageDays} days ago and never used. Either the integration never shipped or the key got rotated out without being revoked. Drop it.`,
          confidence: "low",
          actionClass: "destructive",
          hints: [
            {
              label: "Revoke via CLI",
              hint: `cantila keys revoke ${key.id}`,
            },
          ],
          execute: async (controlPlane) => {
            const result = await controlPlane.revokeApiKey(key.id, key.accountId);
            if ("error" in result) {
              return { ok: false, detail: result.error };
            }
            return {
              ok: true,
              detail: `Revoked "${key.name}" — was ${ageDays} days stale`,
            };
          },
        });
      }
    }

    // 3. Auth disabled with live tenants → ack-only proposal (the brain
    //    can't flip an env var; this is a flag for the operator).
    if (!config.requireAuth && accounts.length > 0) {
      out.push({
        id: `prop_${makeId("sec").slice(3)}_authoff`,
        at: now(),
        agent: this.name,
        kind: "enable_auth_enforcement",
        title: `Turn on auth enforcement — ${accounts.length} tenant(s) currently exposed`,
        body: `CANTILA_REQUIRE_AUTH is off but ${accounts.length} tenant account(s) exist. Anyone who can reach the control-plane HTTP port can write to any project on any account. Set CANTILA_REQUIRE_AUTH=true and restart, then mint a per-tenant admin key.`,
        confidence: "high",
        actionClass: "destructive",
        hints: [
          {
            label: "Toggle on next deploy",
            hint: `# in your control-plane env file\nCANTILA_REQUIRE_AUTH=true`,
          },
        ],
        execute: async () => ({
          ok: true,
          detail:
            "Acknowledged — the env-var flip happens out of band; brain can't restart itself.",
        }),
      });
    }

    return out;
  }
}
