/* ============================================================
   OpenClawEngineAdapter — talks to a real OpenClaw HTTP API per
   instance (plan §4.10, Phase D).

   OpenClaw's runtime model is different from n8n's — instead of
   a node graph, it composes goals + tools into a single agent
   loop. The adapter translates Cantila's canonical `WorkflowGraph`
   into OpenClaw's "chain config" on save (one chain per workflow,
   with each canonical node becoming a tool entry whose `type`
   maps to the OpenClaw tool catalog), and reverses on load.

   Selected by the engine registry when `OPENCLAW_BASE_URL` and
   `OPENCLAW_API_KEY` are set; otherwise the deterministic stub
   keeps the same surface serving. The Console renders the same
   palette + canvas no matter which adapter is wired.
   ============================================================ */

import type { AutomationKind } from "../../domain/types";
import { id as mkId, now } from "../../lib/ids";
import type {
  AutomationEngineAdapter,
  BindConnectionContext,
  BindConnectionResult,
  ExecutionEvent,
  ExecutionState,
  GraphEdge,
  GraphNode,
  NodeTypeDescriptor,
  WorkflowGraph,
  WorkflowSummary,
} from "../engine";

export interface OpenClawEngineConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

/* ---------- OpenClaw wire types (just what we read/write) ---- */

interface OcToolRow {
  /** Cantila node id — preserved through round-trip. */
  id: string;
  /** OpenClaw tool name (without the `openclaw:` prefix). */
  tool: string;
  /** Visual position the canvas owns; OpenClaw doesn't use it for
   *  execution but stores it opaquely. */
  position?: { x: number; y: number };
  inputs?: Record<string, unknown>;
  /** Cantila Connection id when the tool needs a credential. */
  credential_id?: string;
}

interface OcChainRow {
  id?: string;
  name: string;
  /** OpenClaw expects the top-level "goal" string up front. We store it
   *  in canonical-graph `meta.goal` and surface it back here. */
  goal: string;
  tools: OcToolRow[];
  /** Source→target ordering of tools — OpenClaw's `next_steps` map. */
  edges?: { from: string; to: string }[];
  meta?: Record<string, unknown>;
}

interface OcExecutionRow {
  id: string;
  chain_id: string;
  status: "queued" | "running" | "success" | "failed" | "canceled";
  started_at: string;
  finished_at?: string;
  step_states?: Record<string, "pending" | "running" | "success" | "failed">;
  error?: string;
}

/* ---------- adapter ---- */

export class OpenClawEngineAdapter implements AutomationEngineAdapter {
  readonly kind: AutomationKind = "openclaw";
  private readonly config: OpenClawEngineConfig;

  constructor(config: OpenClawEngineConfig) {
    this.config = { timeoutMs: 15_000, ...config };
  }

  /* ----- catalog ----- */

  async listNodeTypes(): Promise<NodeTypeDescriptor[]> {
    const raw = await this.fetch<{
      tools: {
        name: string;
        display_name?: string;
        description?: string;
        category?: string;
        glyph?: string;
        parameters?: Record<string, unknown>;
        credential_provider?: string;
      }[];
    }>("/api/tools");
    return (raw.tools ?? []).map((t) => ({
      id: `openclaw:${t.name}`,
      kind: "openclaw" as AutomationKind,
      name: t.display_name ?? t.name,
      category: t.category ?? "Tool",
      blurb: t.description ?? t.name,
      glyph: t.glyph ?? "◎",
      parameters: t.parameters ?? { type: "object", properties: {} },
      requiresConnection: Boolean(t.credential_provider),
      connectionProviders: t.credential_provider ? [t.credential_provider] : undefined,
    }));
  }

  async getNodeType(id: string): Promise<NodeTypeDescriptor | null> {
    const all = await this.listNodeTypes();
    return all.find((n) => n.id === id) ?? null;
  }

  /* ----- workflows ----- */

  async listWorkflows(_instanceId: string): Promise<WorkflowSummary[]> {
    const raw = await this.fetch<{ chains: OcChainRow[] }>("/api/chains");
    return (raw.chains ?? []).map((c) => ({
      id: c.id ?? "",
      name: c.name,
      active: true,
    }));
  }

  async loadWorkflow(
    _instanceId: string,
    workflowId: string,
  ): Promise<WorkflowGraph> {
    const raw = await this.fetch<{ chain: OcChainRow }>(
      `/api/chains/${encodeURIComponent(workflowId)}`,
    );
    return openclawToCantila(raw.chain);
  }

  async saveWorkflow(
    _instanceId: string,
    graph: WorkflowGraph,
  ): Promise<WorkflowGraph> {
    const body = cantilaToOpenclaw(graph);
    const existing = graph.id && graph.id.length > 0;
    const raw = await this.fetch<{ chain: OcChainRow }>(
      existing ? `/api/chains/${encodeURIComponent(graph.id)}` : "/api/chains",
      {
        method: existing ? "PATCH" : "POST",
        body: JSON.stringify(body),
      },
    );
    return openclawToCantila(raw.chain);
  }

  async deleteWorkflow(
    _instanceId: string,
    workflowId: string,
  ): Promise<boolean> {
    const res = await this.fetchRaw(
      `/api/chains/${encodeURIComponent(workflowId)}`,
      { method: "DELETE" },
    );
    return res.ok;
  }

  /* ----- execution ----- */

  async runWorkflow(
    _instanceId: string,
    workflowId: string,
    input?: unknown,
  ): Promise<{ executionId: string }> {
    const raw = await this.fetch<{ execution_id: string }>(
      `/api/chains/${encodeURIComponent(workflowId)}/run`,
      {
        method: "POST",
        body: JSON.stringify({ input: input ?? {} }),
      },
    );
    return { executionId: raw.execution_id };
  }

  async getExecution(
    _instanceId: string,
    executionId: string,
  ): Promise<ExecutionState | null> {
    let raw: { execution?: OcExecutionRow } | null = null;
    try {
      raw = await this.fetch<{ execution: OcExecutionRow }>(
        `/api/executions/${encodeURIComponent(executionId)}`,
      );
    } catch {
      return null;
    }
    if (!raw?.execution) return null;
    return openclawExecToCantila(raw.execution);
  }

  async *streamExecution(
    instanceId: string,
    executionId: string,
  ): AsyncIterable<ExecutionEvent> {
    yield { at: now(), executionId, kind: "execution_started" };
    const emitted = new Set<string>();
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const exec = await this.getExecution(instanceId, executionId);
      if (!exec) {
        yield {
          at: now(),
          executionId,
          kind: "execution_finished",
          detail: "execution not found",
        };
        return;
      }
      for (const [nodeId, state] of Object.entries(exec.nodeStates)) {
        const tag = `${nodeId}:${state}`;
        if (emitted.has(tag)) continue;
        emitted.add(tag);
        if (state === "running") {
          yield { at: now(), executionId, nodeId, kind: "node_started" };
        } else if (state === "success") {
          yield { at: now(), executionId, nodeId, kind: "node_succeeded" };
        } else if (state === "failed") {
          yield { at: now(), executionId, nodeId, kind: "node_failed" };
        }
      }
      if (exec.status === "success" || exec.status === "failed") {
        yield {
          at: now(),
          executionId,
          kind: "execution_finished",
          detail: exec.error,
        };
        return;
      }
      await sleep(1000);
    }
    yield {
      at: now(),
      executionId,
      kind: "execution_finished",
      detail: "stream timed out after 5 min",
    };
  }

  /* ----- credentials ----- */

  async bindConnection(
    _instanceId: string,
    connectionId: string,
    ctx?: BindConnectionContext,
  ): Promise<BindConnectionResult> {
    // OpenClaw's credential surface is still in flux upstream — when ctx
    // arrives we POST the payload as a generic credential record and
    // return the engine-side id; without it we mint a placeholder so the
    // route stays exercised. The n8n adapter is the canonical real-push
    // path; OpenClaw will mirror its shape once the upstream API
    // stabilises.
    if (ctx) {
      try {
        const body = JSON.stringify({
          name: ctx.name ?? `cantila-${connectionId}`,
          provider: ctx.provider,
          data: ctx.payload,
          ttl_seconds: 300,
        });
        const res = await this.fetch<{ data: { id: string; expires_at?: string } }>(
          "/api/credentials",
          { method: "POST", body },
        );
        const engineCredentialId = res?.data?.id ?? `openclaw:${connectionId}:${mkId("ecred")}`;
        const expiresAt =
          res?.data?.expires_at ??
          new Date(Date.now() + 5 * 60 * 1000).toISOString();
        return { engineCredentialId, expiresAt, pushed: true };
      } catch {
        // Fall through to the placeholder so the broker still produces
        // an id; the audit row will record `pushed: false`.
      }
    }
    const engineCredentialId = `openclaw:${connectionId}:${mkId("ecred")}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    return { engineCredentialId, expiresAt, pushed: false };
  }

  async unbindConnection(
    _instanceId: string,
    engineCredentialId: string,
  ): Promise<void> {
    // Only attempt the DELETE for ids that look engine-side — placeholder
    // ids minted by the fallback branch above carry the `openclaw:` prefix
    // and the DELETE would 404. Engine-side ids land verbatim.
    if (engineCredentialId.startsWith("openclaw:")) return;
    try {
      await this.fetchRaw(
        `/api/credentials/${encodeURIComponent(engineCredentialId)}`,
        { method: "DELETE" },
      );
    } catch {
      // Idempotent — engine may have already TTL'd the row.
    }
  }

  /* ----- HTTP plumbing ----- */

  private async fetch<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const res = await this.fetchRaw(path, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `openclaw ${init.method ?? "GET"} ${path} failed: ${res.status} ${text}`,
      );
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) {
      return undefined as unknown as T;
    }
    return (await res.json()) as T;
  }

  private async fetchRaw(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.apiKey}`,
      accept: "application/json",
      ...((init.headers ?? {}) as Record<string, string>),
    };
    if (init.body && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    const ctl = new AbortController();
    const timer = setTimeout(
      () => ctl.abort(),
      this.config.timeoutMs ?? 15_000,
    );
    try {
      return await fetch(url, { ...init, headers, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ---------- canonical-graph ↔ openclaw translation ---- */

function openclawToCantila(row: OcChainRow): WorkflowGraph {
  const nodes: GraphNode[] = (row.tools ?? []).map((t) => ({
    id: t.id,
    type: `openclaw:${t.tool}`,
    position: t.position ?? { x: 0, y: 0 },
    parameters: t.inputs ?? {},
    connectionId: t.credential_id,
  }));
  const edges: GraphEdge[] = (row.edges ?? []).map((e, i) => ({
    id: `${e.from}->${e.to}#${i}`,
    fromNodeId: e.from,
    toNodeId: e.to,
  }));
  return {
    id: row.id ?? "",
    name: row.name,
    nodes,
    edges,
    triggers: [], // OpenClaw chains are agent-driven, not trigger-driven.
    meta: { ...(row.meta ?? {}), goal: row.goal },
  };
}

function cantilaToOpenclaw(graph: WorkflowGraph): OcChainRow {
  const goal =
    typeof graph.meta?.goal === "string" ? (graph.meta.goal as string) : "";
  const tools: OcToolRow[] = graph.nodes.map((n) => ({
    id: n.id,
    tool: n.type.startsWith("openclaw:") ? n.type.slice(9) : n.type,
    position: n.position,
    inputs: n.parameters,
    credential_id: n.connectionId,
  }));
  const edges = graph.edges.map((e) => ({ from: e.fromNodeId, to: e.toNodeId }));
  // Don't double-write `goal` into both meta and the top-level field.
  const rest = { ...(graph.meta ?? {}) };
  delete rest.goal;
  return {
    id: graph.id || undefined,
    name: graph.name,
    goal,
    tools,
    edges,
    meta: rest,
  };
}

function openclawExecToCantila(row: OcExecutionRow): ExecutionState {
  let status: ExecutionState["status"];
  if (row.status === "success") status = "success";
  else if (row.status === "failed" || row.status === "canceled")
    status = "failed";
  else if (row.status === "queued") status = "queued";
  else status = "running";
  return {
    id: row.id,
    workflowId: row.chain_id,
    status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    nodeStates: row.step_states ?? {},
    error: row.error,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
