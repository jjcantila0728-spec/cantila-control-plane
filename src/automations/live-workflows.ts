/* ============================================================
   Live automation workflow listing — talks to the REAL deployed
   n8n + OpenClaw instances (not the canvas engine adapters, whose
   API shape differs from what's currently deployed).

   - n8n:     GET {base}/api/v1/workflows   header X-N8N-API-KEY
   - openclaw GET {base}/api/runs           header Authorization: Bearer

   Config comes from env (set on the control plane):
     N8N_BASE_URL / N8N_API_KEY
     OPENCLAW_BASE_URL / OPENCLAW_API_KEY
   When a kind isn't configured we return {configured:false} so the
   Console can render a "connect this instance" state instead of
   fake data. `fetchImpl` is injected for tests.
   ============================================================ */

export type LiveAutomationKind = "n8n" | "openclaw";

export interface LiveWorkflow {
  id: string;
  name: string;
  /** Whether the workflow/run is active/running (best-effort per engine). */
  active: boolean;
  /** ISO timestamp of last update/run, when the engine provides one. */
  updatedAt?: string;
}

export interface LiveWorkflowsResult {
  configured: boolean;
  workflows: LiveWorkflow[];
  /** Set when configured but the upstream call failed (so the UI can show
   *  "instance unreachable" rather than "no workflows"). */
  error?: string;
}

type FetchImpl = typeof fetch;

interface LiveEnv {
  n8nBase?: string;
  n8nKey?: string;
  openclawBase?: string;
  openclawKey?: string;
}

export function liveEnvFromProcess(env = process.env): LiveEnv {
  return {
    n8nBase: env.N8N_BASE_URL?.trim(),
    n8nKey: env.N8N_API_KEY?.trim(),
    openclawBase: env.OPENCLAW_BASE_URL?.trim(),
    openclawKey: env.OPENCLAW_API_KEY?.trim(),
  };
}

export async function listLiveWorkflows(
  kind: LiveAutomationKind,
  env: LiveEnv,
  fetchImpl: FetchImpl = fetch,
): Promise<LiveWorkflowsResult> {
  if (kind === "n8n") {
    if (!env.n8nBase || !env.n8nKey) return { configured: false, workflows: [] };
    return fetchN8n(env.n8nBase, env.n8nKey, fetchImpl);
  }
  if (!env.openclawBase || !env.openclawKey) return { configured: false, workflows: [] };
  return fetchOpenClaw(env.openclawBase, env.openclawKey, fetchImpl);
}

async function fetchN8n(
  base: string,
  apiKey: string,
  fetchImpl: FetchImpl,
): Promise<LiveWorkflowsResult> {
  try {
    const res = await fetchImpl(`${trim(base)}/api/v1/workflows`, {
      headers: { "X-N8N-API-KEY": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { configured: true, workflows: [], error: `n8n ${res.status}` };
    const body: any = await res.json();
    const rows: any[] = Array.isArray(body) ? body : body?.data ?? [];
    return {
      configured: true,
      workflows: rows.map((w) => ({
        id: String(w.id),
        name: String(w.name ?? "Untitled workflow"),
        active: Boolean(w.active),
        updatedAt: w.updatedAt ?? w.createdAt,
      })),
    };
  } catch (err) {
    return { configured: true, workflows: [], error: errMsg(err) };
  }
}

async function fetchOpenClaw(
  base: string,
  token: string,
  fetchImpl: FetchImpl,
): Promise<LiveWorkflowsResult> {
  try {
    const res = await fetchImpl(`${trim(base)}/api/runs`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { configured: true, workflows: [], error: `openclaw ${res.status}` };
    const body: any = await res.json();
    const rows: any[] = Array.isArray(body) ? body : body?.runs ?? body?.data ?? [];
    return {
      configured: true,
      // An OpenClaw "workflow" is an agent run/goal.
      workflows: rows.map((r) => ({
        id: String(r.id ?? r.execution_id ?? r.run_id),
        name: String(r.goal ?? r.name ?? "Agent run"),
        active: r.status === "running" || r.status === "active",
        updatedAt: r.updatedAt ?? r.updated_at ?? r.createdAt ?? r.created_at,
      })),
    };
  } catch (err) {
    return { configured: true, workflows: [], error: errMsg(err) };
  }
}

const trim = (s: string) => s.replace(/\/$/, "");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
