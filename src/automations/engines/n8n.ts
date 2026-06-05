/* ============================================================
   N8nEngineAdapter — talks to a real n8n REST API per instance
   (plan §4.10, Phase B).

   The Cantila control plane owns one n8n container per automation
   instance (deployed by the existing project pipeline). This adapter
   reaches into that container via n8n's HTTP API to list the node
   catalog, save / load workflows in n8n's native nested-workflow
   format, kick off executions, and bind Cantila Connection secrets
   into n8n credential rows just-in-time.

   The adapter is wired by the engine registry when both
   `N8N_BASE_URL` and `N8N_API_KEY` env vars are set; otherwise the
   in-memory `StubEngineAdapter` keeps the same routes serving so
   the Console works with no engine running. See `registry.ts`.

   This adapter speaks the *Cantila canonical* `WorkflowGraph` shape
   in and out — the n8n-specific JSON only lives inside the adapter,
   round-tripped on load/save through `cantilaToN8n` /
   `n8nToCantila`. The canvas reads and writes the canonical shape,
   so swapping engines is one adapter swap with no Console code
   change.
   ============================================================ */

import type { AutomationKind } from "../../domain/types";
import { id as mkId, now } from "../../lib/ids";
import type {
  AutomationEngineAdapter,
  BindConnectionContext,
  BindConnectionResult,
  ExecutionEvent,
  ExecutionState,
  GraphNode,
  GraphEdge,
  GraphTrigger,
  NodeTypeDescriptor,
  TriggerKind,
  WorkflowGraph,
  WorkflowSummary,
} from "../engine";

export interface N8nEngineConfig {
  baseUrl: string;
  apiKey: string;
  /** Optional override for the timeout on individual REST calls. */
  timeoutMs?: number;
}

/* ---------- n8n wire types (just the shapes we read/write) ----- */

interface N8nNodeRow {
  name: string;
  type: string;
  typeVersion?: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  /** n8n keys credentials by display name; we set the cantila connection
   *  id here so the run hook can look up the bound credential. */
  credentials?: Record<string, { id: string; name: string }>;
}

interface N8nWorkflowRow {
  id?: string;
  name: string;
  nodes: N8nNodeRow[];
  connections: Record<
    string,
    {
      main?: { node: string; type?: string; index?: number }[][];
    }
  >;
  active?: boolean;
  meta?: Record<string, unknown>;
}

interface N8nExecutionRow {
  id: string;
  workflowId: string;
  status: "new" | "running" | "success" | "error" | "canceled" | "waiting";
  startedAt: string;
  stoppedAt?: string;
  data?: {
    resultData?: {
      runData?: Record<
        string,
        {
          executionStatus?: "success" | "error" | "running";
        }[]
      >;
      error?: { message: string };
    };
  };
}

/* ---------- adapter ---- */

export class N8nEngineAdapter implements AutomationEngineAdapter {
  readonly kind: AutomationKind = "n8n";
  private readonly config: N8nEngineConfig;

  constructor(config: N8nEngineConfig) {
    this.config = {
      timeoutMs: 15_000,
      ...config,
    };
  }

  /* ----- catalog ----- */

  async listNodeTypes(): Promise<NodeTypeDescriptor[]> {
    // n8n's node-types endpoint returns its full catalog. We normalise
    // each entry into a `NodeTypeDescriptor`. n8n nodes don't carry our
    // `requiresConnection` flag explicitly — we infer it by looking for
    // a `credentialsDescription` on the node.
    const raw = await this.fetch<{
      data: {
        name: string;
        displayName: string;
        description?: string;
        group?: string[];
        iconUrl?: string;
        icon?: string;
        properties?: unknown[];
        credentialsDescription?: { name: string }[];
      }[];
    }>("/rest/node-types");

    return (raw.data ?? []).map((n) => {
      const credentials = n.credentialsDescription ?? [];
      const category =
        Array.isArray(n.group) && n.group.length > 0
          ? toTitle(n.group[0])
          : "Core";
      return {
        id: `n8n:${n.name}`,
        kind: "n8n" as AutomationKind,
        name: n.displayName,
        category,
        blurb: n.description ?? n.displayName,
        glyph: n.iconUrl ?? n.icon ?? "•",
        // n8n's `properties` array is a JSON-schema-ish parameter spec.
        // We pass it through opaquely so the Console parameter form
        // can render it.
        parameters: { type: "object", properties: n.properties ?? [] },
        requiresConnection: credentials.length > 0,
        connectionProviders: credentials.map((c) => c.name),
      };
    });
  }

  async getNodeType(id: string): Promise<NodeTypeDescriptor | null> {
    const all = await this.listNodeTypes();
    return all.find((n) => n.id === id) ?? null;
  }

  /* ----- workflows ----- */

  async listWorkflows(_instanceId: string): Promise<WorkflowSummary[]> {
    const raw = await this.fetch<{ data: N8nWorkflowRow[] }>(
      "/rest/workflows",
    );
    return (raw.data ?? []).map((w) => ({
      id: w.id ?? "",
      name: w.name,
      active: w.active ?? false,
    }));
  }

  async loadWorkflow(
    _instanceId: string,
    workflowId: string,
  ): Promise<WorkflowGraph> {
    const raw = await this.fetch<{ data: N8nWorkflowRow }>(
      `/rest/workflows/${encodeURIComponent(workflowId)}`,
    );
    return n8nToCantila(raw.data);
  }

  async saveWorkflow(
    _instanceId: string,
    graph: WorkflowGraph,
  ): Promise<WorkflowGraph> {
    const body = cantilaToN8n(graph);
    const existing = graph.id && graph.id.length > 0;
    const raw = await this.fetch<{ data: N8nWorkflowRow }>(
      existing ? `/rest/workflows/${encodeURIComponent(graph.id)}` : "/rest/workflows",
      {
        method: existing ? "PATCH" : "POST",
        body: JSON.stringify(body),
      },
    );
    return n8nToCantila(raw.data);
  }

  async deleteWorkflow(
    _instanceId: string,
    workflowId: string,
  ): Promise<boolean> {
    const res = await this.fetchRaw(
      `/rest/workflows/${encodeURIComponent(workflowId)}`,
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
    const body = JSON.stringify({ workflowData: { id: workflowId }, runData: input ?? {} });
    const raw = await this.fetch<{ data: { executionId: string } }>(
      `/rest/workflows/${encodeURIComponent(workflowId)}/run`,
      { method: "POST", body },
    );
    return { executionId: raw.data.executionId };
  }

  async getExecution(
    _instanceId: string,
    executionId: string,
  ): Promise<ExecutionState | null> {
    let raw: { data?: N8nExecutionRow } | null = null;
    try {
      raw = await this.fetch<{ data: N8nExecutionRow }>(
        `/rest/executions/${encodeURIComponent(executionId)}`,
      );
    } catch {
      return null;
    }
    if (!raw?.data) return null;
    return n8nExecToCantila(raw.data);
  }

  async *streamExecution(
    instanceId: string,
    executionId: string,
  ): AsyncIterable<ExecutionEvent> {
    // n8n's push channel is a websocket; for HTTP we poll the execution
    // row until it terminates and emit synthesised events per node so
    // the Console feed feels live regardless of transport.
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
    // Time-out fallback so the iterator can't hang forever.
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
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    if (!ctx) {
      // Phase B fallback — no resolved payload, so we mint a placeholder.
      // The Cantila broker layer (`cp.bindConnectionForRun`) always
      // supplies ctx today; this branch survives for callers that hand
      // a connectionId in without going through the broker.
      const engineCredentialId = `n8n:${connectionId}:${mkId("ecred")}`;
      return { engineCredentialId, expiresAt, pushed: false };
    }
    const credentialType = mapProviderToN8nCredentialType(ctx.provider);
    if (!credentialType) {
      // Unknown provider — n8n won't know what credential schema to
      // store. Drop back to the placeholder so the run can still
      // reference an id; the audit log records `pushed: false` so the
      // operator can see the gap and extend the mapping table.
      const engineCredentialId = `n8n:${connectionId}:${mkId("ecred")}`;
      return { engineCredentialId, expiresAt, pushed: false };
    }
    const data = mapPayloadToN8nCredentialData(ctx.provider, ctx.payload);
    const body = JSON.stringify({
      name: ctx.name ?? `cantila-${connectionId}`,
      type: credentialType,
      data,
    });
    try {
      const res = await this.fetch<{ data: { id: string | number } }>(
        "/rest/credentials",
        { method: "POST", body },
      );
      const engineCredentialId =
        res?.data?.id !== undefined ? String(res.data.id) : `n8n:${connectionId}:${mkId("ecred")}`;
      return { engineCredentialId, expiresAt, pushed: true };
    } catch {
      // n8n rejected the push (auth, schema mismatch, network). Fall
      // through to the placeholder so the run still gets an id; the
      // audit row records `pushed: false` and the operator sees why.
      const engineCredentialId = `n8n:${connectionId}:${mkId("ecred")}`;
      return { engineCredentialId, expiresAt, pushed: false };
    }
  }

  async unbindConnection(
    _instanceId: string,
    engineCredentialId: string,
  ): Promise<void> {
    // Placeholder ids carry the `n8n:` prefix; only engine-side ids
    // (numeric or cuid strings n8n hands back) round-trip to a DELETE.
    if (engineCredentialId.startsWith("n8n:")) return;
    try {
      await this.fetchRaw(
        `/rest/credentials/${encodeURIComponent(engineCredentialId)}`,
        { method: "DELETE" },
      );
    } catch {
      // Idempotent — n8n may have already TTL'd or been rebooted.
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
        `n8n ${init.method ?? "GET"} ${path} failed: ${res.status} ${text}`,
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
      "X-N8N-API-KEY": this.config.apiKey,
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

/* ---------- import: n8n "Download" JSON → canonical graph ----- */

/** Convert a raw n8n workflow export (the JSON you get from n8n's
 *  *Download* / *Copy to clipboard*) into Cantila's canonical
 *  `WorkflowGraph`. Reuses the same `n8nToCantila` translation the live
 *  adapter uses on load, so an imported workflow is indistinguishable
 *  from one authored on the canvas.
 *
 *  The incoming `id` is intentionally dropped — import always creates a
 *  *new* workflow, so the returned graph carries `id: ""` and the engine
 *  assigns a fresh id on save. Throws a descriptive `Error` on input that
 *  isn't a workflow export (so the route can return a clean 400). */
export function parseN8nWorkflowExport(input: unknown): WorkflowGraph {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid workflow export: expected a JSON object");
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.nodes)) {
    throw new Error("invalid workflow export: `nodes` array is required");
  }
  const row: N8nWorkflowRow = {
    // Drop `id` — import mints a fresh workflow.
    name: typeof obj.name === "string" && obj.name ? obj.name : "Imported workflow",
    nodes: obj.nodes as N8nWorkflowRow["nodes"],
    connections: (obj.connections as N8nWorkflowRow["connections"]) ?? {},
    meta: (obj.meta as Record<string, unknown> | undefined),
  };
  const graph = n8nToCantila(row);
  return { ...graph, id: "" };
}

/* ---------- canonical-graph ↔ n8n translation ----- */

function n8nToCantila(row: N8nWorkflowRow): WorkflowGraph {
  const nodes: GraphNode[] = row.nodes.map((n, i) => ({
    id: n.name || `node_${i}`,
    type: `n8n:${n.type}`,
    position: { x: n.position?.[0] ?? 0, y: n.position?.[1] ?? 0 },
    parameters: n.parameters ?? {},
    connectionId: pickConnectionId(n.credentials),
  }));

  const edges: GraphEdge[] = [];
  for (const [fromName, conn] of Object.entries(row.connections ?? {})) {
    const ports = conn.main ?? [];
    for (let portIdx = 0; portIdx < ports.length; portIdx += 1) {
      for (const target of ports[portIdx]) {
        edges.push({
          id: `${fromName}->${target.node}#${portIdx}`,
          fromNodeId: fromName,
          toNodeId: target.node,
          fromPort: portIdx === 0 ? undefined : `main:${portIdx}`,
        });
      }
    }
  }

  const triggers: GraphTrigger[] = [];
  for (const n of nodes) {
    const kind = classifyTrigger(n.type);
    if (kind) triggers.push({ id: `trg_${n.id}`, kind, config: n.parameters });
  }

  return {
    id: row.id ?? "",
    name: row.name,
    nodes,
    edges,
    triggers,
    meta: row.meta,
  };
}

function cantilaToN8n(graph: WorkflowGraph): N8nWorkflowRow {
  const nodes: N8nNodeRow[] = graph.nodes.map((n) => ({
    name: n.id,
    // n8n's wire type strips the `n8n:` prefix; we mirror.
    type: n.type.startsWith("n8n:") ? n.type.slice(4) : n.type,
    position: [n.position.x, n.position.y],
    parameters: n.parameters,
    credentials: n.connectionId
      ? { default: { id: n.connectionId, name: n.connectionId } }
      : undefined,
  }));

  const connections: N8nWorkflowRow["connections"] = {};
  for (const e of graph.edges) {
    const port = e.fromPort?.startsWith("main:")
      ? Number(e.fromPort.slice(5))
      : 0;
    const fromBucket = (connections[e.fromNodeId] ??= { main: [] });
    const mains = (fromBucket.main ??= []);
    while (mains.length <= port) mains.push([]);
    mains[port].push({ node: e.toNodeId, type: "main", index: 0 });
  }

  return {
    id: graph.id || undefined,
    name: graph.name,
    nodes,
    connections,
    meta: graph.meta,
  };
}

function n8nExecToCantila(row: N8nExecutionRow): ExecutionState {
  const nodeStates: ExecutionState["nodeStates"] = {};
  const runData = row.data?.resultData?.runData ?? {};
  for (const [nodeId, runs] of Object.entries(runData)) {
    const last = runs[runs.length - 1];
    const status = last?.executionStatus;
    if (status === "success") nodeStates[nodeId] = "success";
    else if (status === "error") nodeStates[nodeId] = "failed";
    else nodeStates[nodeId] = "running";
  }
  let cantilaStatus: ExecutionState["status"];
  if (row.status === "success") cantilaStatus = "success";
  else if (row.status === "error" || row.status === "canceled")
    cantilaStatus = "failed";
  else if (row.status === "new") cantilaStatus = "queued";
  else cantilaStatus = "running";
  return {
    id: row.id,
    workflowId: row.workflowId,
    status: cantilaStatus,
    startedAt: row.startedAt,
    finishedAt: row.stoppedAt,
    nodeStates,
    error: row.data?.resultData?.error?.message,
  };
}

/* ---------- helpers ----- */

/** Classify a canonical node type (`n8n:<n8nType>`) as a trigger kind, or
 *  null when it isn't a trigger. Tolerant of both stub-style type ids
 *  (`n8n:webhook`, `n8n:schedule`) and real n8n type names
 *  (`n8n-nodes-base.webhook`, `…manualTrigger`, `…scheduleTrigger`,
 *  legacy `…cron` / `…interval`). */
function classifyTrigger(type: string): TriggerKind | null {
  const t = type.toLowerCase();
  if (t.includes("webhook")) return "webhook";
  if (t.includes("schedule") || t.includes("cron") || t.includes("interval"))
    return "schedule";
  if (t.includes("manualtrigger") || t.endsWith(":manual")) return "manual";
  return null;
}

function pickConnectionId(
  credentials?: Record<string, { id: string; name: string }>,
): string | undefined {
  if (!credentials) return undefined;
  const first = Object.values(credentials)[0];
  return first?.id;
}

function toTitle(s: string): string {
  if (!s) return "Core";
  return s[0].toUpperCase() + s.slice(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------- Cantila provider → n8n credential type mapping ----- */

/** Map a Cantila provider id (matches the `ProviderDescriptor.id` in
 *  `connections/providers.ts`) to the n8n credential type name n8n
 *  expects on `POST /rest/credentials`. Returning `null` means "n8n
 *  doesn't model this credential in a shape we can populate" — the
 *  caller falls back to a placeholder id and the audit row records
 *  `pushed: false`. The mapping table is intentionally minimal — every
 *  entry has been spot-checked against n8n's credential schema docs. */
function mapProviderToN8nCredentialType(provider: string): string | null {
  switch (provider) {
    case "openai":
      return "openAiApi";
    case "anthropic":
      return "anthropicApi";
    case "slack":
      return "slackOAuth2Api";
    case "gmail":
      return "gmailOAuth2";
    case "notion":
      return "notionApi";
    case "github":
      return "githubOAuth2Api";
    case "airtable":
      return "airtableTokenApi";
    case "sendgrid":
      return "sendGridApi";
    case "twilio":
      return "twilioApi";
    case "postgres":
      return "postgres";
    case "mysql":
      return "mySql";
    case "http_basic":
      return "httpBasicAuth";
    case "stripe":
      return "stripeApi";
    case "generic_api_key":
      return "httpHeaderAuth";
    default:
      return null;
  }
}

/** Translate the Cantila secret payload into n8n's credential `data`
 *  bag. The key names differ per credential type — n8n's `apiKey` vs
 *  our `api_key`, n8n's `accessToken` vs our `access_token`, etc. We
 *  do the minimum dance per provider so the most common field set
 *  lands correctly; n8n ignores unknown keys in the data object. */
function mapPayloadToN8nCredentialData(
  provider: string,
  payload: Record<string, string>,
): Record<string, string> {
  const accessToken = payload.access_token;
  const refreshToken = payload.refresh_token;
  switch (provider) {
    case "openai":
    case "anthropic":
    case "sendgrid":
    case "stripe":
      return { apiKey: payload.api_key ?? "" };
    case "notion":
      return { apiKey: payload.api_key ?? accessToken ?? "" };
    case "airtable":
      return {
        accessToken: accessToken ?? payload.api_key ?? "",
        ...(refreshToken ? { refreshToken } : {}),
      };
    case "gmail":
    case "slack":
    case "github":
      return {
        accessToken: accessToken ?? "",
        ...(refreshToken ? { refreshToken } : {}),
      };
    case "twilio":
      return {
        accountSid: payload.account_sid ?? "",
        authToken: payload.auth_token ?? "",
      };
    case "postgres":
    case "mysql":
      return { connectionString: payload.connection_string ?? "" };
    case "http_basic":
      return {
        user: payload.username ?? "",
        password: payload.password ?? "",
      };
    case "generic_api_key":
      return {
        name: payload.header_name ?? "Authorization",
        value: payload.api_key ?? "",
      };
    default:
      // Pass through unchanged — better than dropping bytes silently.
      return { ...payload };
  }
}
