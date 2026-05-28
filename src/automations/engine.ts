/* ============================================================
   Cantila Automations — the engine adapter port (plan §4.10).

   The Console and the API talk only to this interface. Each
   `AutomationKind` has one real adapter (n8n, OpenClaw, …) and
   one in-memory stub that backs offline / test runs. Swapping
   engines is one adapter swap; no Console code knows the
   difference.
   ============================================================ */

import type { AutomationKind } from "../domain/types";

/** A connector users can drag onto the workflow canvas. Sourced from the
 *  underlying engine's catalog (n8n's `/rest/node-types`, OpenClaw's tool
 *  manifest) and normalised to one shape the Console renders. The
 *  `parameters` schema drives the side-rail parameter form — a single
 *  Console component renders every node type. */
export interface NodeTypeDescriptor {
  /** Globally unique within a kind, e.g. `n8n:slack` or `openclaw:webfetch`. */
  id: string;
  kind: AutomationKind;
  name: string;
  category: string;
  /** Short description shown under the palette entry. */
  blurb: string;
  /** Icon URL or short literal glyph for the palette tile. */
  glyph: string;
  /** JSON-schema shape driving the parameter editor. Loose Record<…> so
   *  adding a parameter type is data, not code. The form renderer reads
   *  `type`, `enum`, `default`, `description` etc. off each property. */
  parameters: Record<string, unknown>;
  /** When true, the node consumes a Cantila Connection. The Console's
   *  parameter form shows a Connection picker on top of the regular params. */
  requiresConnection: boolean;
  /** When `requiresConnection` is true, the providers this node accepts
   *  ("slack", "gmail", …). Optional — if absent the picker shows every
   *  connection in the account. */
  connectionProviders?: string[];
}

/** Cantila's canonical workflow shape. Engines have their own formats
 *  (n8n's nested workflow JSON, OpenClaw's chain config); adapters
 *  translate on save/load. Storing this shape means the canvas reads
 *  one model and is unaware of the engine. */
export interface WorkflowGraph {
  /** Stable across renames — assigned by the engine on first save. */
  id: string;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Triggers that start a run — webhook, schedule, manual. */
  triggers: GraphTrigger[];
  /** Engine-specific bag the adapter round-trips. Round-tripped opaque so
   *  fields the canvas doesn't model (n8n's `staticData`, OpenClaw's tool
   *  policies) survive a save / reload. */
  meta?: Record<string, unknown>;
}

export interface GraphNode {
  id: string;
  type: string; // matches a NodeTypeDescriptor.id
  position: { x: number; y: number };
  parameters: Record<string, unknown>;
  /** Cantila Connection id when the node uses an external integration.
   *  The engine adapter binds the credential at run time — the workflow
   *  document never contains the secret itself. */
  connectionId?: string;
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  /** Output port on the source node — defaults to "main" when omitted. */
  fromPort?: string;
}

export type TriggerKind = "manual" | "webhook" | "schedule";

export interface GraphTrigger {
  id: string;
  kind: TriggerKind;
  /** Schedule cron, webhook path, or undefined for manual. */
  config?: Record<string, unknown>;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  /** ISO timestamp — latest run, regardless of outcome. Absent if never run. */
  lastRunAt?: string;
  lastRunStatus?: "success" | "failed" | "running";
}

export type ExecutionStatus = "queued" | "running" | "success" | "failed";

export interface ExecutionState {
  id: string;
  workflowId: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt?: string;
  /** Per-node status keyed by `GraphNode.id`. */
  nodeStates: Record<string, "pending" | "running" | "success" | "failed">;
  error?: string;
}

/** One event emitted during a run. The Console streams these over SSE
 *  and lights up the canvas node-by-node as they arrive. */
export interface ExecutionEvent {
  at: string;
  executionId: string;
  /** When the event is scoped to a node — e.g. node started, node finished. */
  nodeId?: string;
  kind:
    | "execution_started"
    | "execution_finished"
    | "node_started"
    | "node_succeeded"
    | "node_failed";
  detail?: string;
}

/** Result of binding a Cantila Connection into the engine for one run.
 *  Adapters return the engine-side credential id; the run hook revokes
 *  it after the execution finishes so vendor engines never hold a
 *  long-lived credential. */
export interface BindConnectionResult {
  engineCredentialId: string;
  /** TTL the engine will honor — adapters set this short (5 min) so a
   *  forgotten run cannot leak the credential. */
  expiresAt: string;
  /** True when the adapter pushed real credential bytes into the engine
   *  (n8n's `/rest/credentials`, OpenClaw's `/api/credentials`). False
   *  when the adapter only minted a placeholder id — happens when no
   *  `BindConnectionContext` was supplied or when the engine doesn't
   *  yet expose a credentials API the adapter can target. The audit log
   *  records this flag so an operator can tell at a glance whether a
   *  bind reached the vendor or stayed Cantila-side. */
  pushed?: boolean;
}

/** Optional context passed to `bindConnection` when the caller already
 *  resolved the Cantila Connection + its secret payload. Adapters use
 *  this to push real credential bytes into the engine — without it they
 *  fall back to minting a placeholder id (Phase B posture). */
export interface BindConnectionContext {
  /** Provider id from the catalog ("slack", "gmail", "openai", …). */
  provider: string;
  /** Decrypted secret bag — keys are the provider manifest's field keys
   *  (`api_key`, `access_token`, `auth_token`, …). Adapters pick the
   *  fields they need; what they don't recognise is ignored. */
  payload: Record<string, string>;
  /** Human-friendly label the engine can show in its own UI when the
   *  vendor distinguishes credentials by name (n8n does). */
  name?: string;
}

/** Engine adapter — one implementation per `AutomationKind` (plan §4.10). */
export interface AutomationEngineAdapter {
  kind: AutomationKind;

  /* ----- catalog ----- */
  listNodeTypes(): Promise<NodeTypeDescriptor[]>;
  getNodeType(id: string): Promise<NodeTypeDescriptor | null>;

  /* ----- workflows ----- */
  listWorkflows(instanceId: string): Promise<WorkflowSummary[]>;
  loadWorkflow(instanceId: string, workflowId: string): Promise<WorkflowGraph>;
  saveWorkflow(instanceId: string, graph: WorkflowGraph): Promise<WorkflowGraph>;
  deleteWorkflow(instanceId: string, workflowId: string): Promise<boolean>;

  /* ----- execution ----- */
  runWorkflow(
    instanceId: string,
    workflowId: string,
    input?: unknown,
  ): Promise<{ executionId: string }>;
  getExecution(
    instanceId: string,
    executionId: string,
  ): Promise<ExecutionState | null>;
  streamExecution(
    instanceId: string,
    executionId: string,
  ): AsyncIterable<ExecutionEvent>;

  /* ----- credentials ----- */

  /** Push a Cantila Connection into the engine just-in-time. When the
   *  caller supplies `ctx`, adapters POST real credential bytes to the
   *  engine (n8n's `/rest/credentials`, OpenClaw's `/api/credentials`);
   *  without it they mint a placeholder engine credential id — the
   *  Phase B posture that survives until the secrets manager is wired
   *  end-to-end. Either way the engine credential id is returned for
   *  workflows to reference for this run. */
  bindConnection(
    instanceId: string,
    connectionId: string,
    ctx?: BindConnectionContext,
  ): Promise<BindConnectionResult>;

  /** Revoke a previously-bound credential. The run hook calls this after
   *  every execution; idempotent so retry is safe. */
  unbindConnection(
    instanceId: string,
    engineCredentialId: string,
  ): Promise<void>;
}

/** Registry of engine adapters by kind. The control plane builds one
 *  instance at boot and route handlers look adapters up here. */
export interface EngineRegistry {
  get(kind: AutomationKind): AutomationEngineAdapter;
}
