/* ============================================================
   Cantilapay — audit log service (plan §25, Phase 0).

   Every state change in cantilapay lands as a row in
   `CantilapayAuditLog`. The Console "Activity" tab reads from
   here; cantilapay support reads it to debug tenant reports.

   The audit log is intentionally SEPARATE from Cantila's main
   `recordEvent` audit log (`cp.recordEvent`) — cantilapay audit
   events have their own retention, their own access controls
   (only the tenant can read their own log), and a separate event
   namespace (every type begins with `cantilapay.`).
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

export interface CantilapayAuditEntry {
  id: string;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  apiKeyId: string | null;
  createdAt: string;
}

/** Record one audit entry. The `type` is a dot-namespaced cantilapay
 *  event name — e.g. `cantilapay.account.created`,
 *  `cantilapay.api_key.issued`, `cantilapay.webhook.delivered`.
 *
 *  Best-effort: a write failure logs and continues so a transient DB
 *  hiccup doesn't break the primary operation. */
export async function recordCantilapayAudit(
  prisma: PrismaClient,
  input: {
    cantilapayAccountId: string;
    type: string;
    message: string;
    data?: Record<string, unknown> | null;
    apiKeyId?: string | null;
  },
): Promise<void> {
  try {
    await prisma.cantilapayAuditLog.create({
      data: {
        cantilapayAccountId: input.cantilapayAccountId,
        type: input.type,
        message: input.message,
        data: input.data ? JSON.stringify(input.data) : null,
        apiKeyId: input.apiKeyId ?? null,
      },
    });
  } catch (err) {
    // Don't let an audit failure break the request — surface it so
    // an operator can see the chain in logs, but continue.
    console.error("[cantilapay] audit write failed", {
      type: input.type,
      cantilapayAccountId: input.cantilapayAccountId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** List recent audit entries for an account, newest first. */
export async function listCantilapayAudit(
  prisma: PrismaClient,
  input: { cantilapayAccountId: string; limit?: number },
): Promise<CantilapayAuditEntry[]> {
  const take = Math.max(1, Math.min(input.limit ?? 100, 500));
  const rows = await prisma.cantilapayAuditLog.findMany({
    where: { cantilapayAccountId: input.cantilapayAccountId },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    message: row.message,
    data: row.data ? safeParseJson(row.data) : null,
    apiKeyId: row.apiKeyId,
    createdAt: row.createdAt.toISOString(),
  }));
}

function safeParseJson(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
