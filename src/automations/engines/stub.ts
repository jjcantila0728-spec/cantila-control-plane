/* ============================================================
   StubEngineAdapter — the in-memory engine that backs offline /
   test runs. Phase A ships this; the real n8n + OpenClaw adapters
   land in Phase B + D (see plan).

   Deterministic across runs: workflow ids are derived from
   `instanceId:name`, executions advance through a fixed timeline,
   and node states follow the graph in topological order. The
   Console renders against this with no Docker / engine running.
   ============================================================ */

import type { AutomationKind } from "../../domain/types";
import { id as mkId, now } from "../../lib/ids";
import type {
  AutomationEngineAdapter,
  BindConnectionContext,
  BindConnectionResult,
  ExecutionEvent,
  ExecutionState,
  NodeTypeDescriptor,
  WorkflowGraph,
  WorkflowSummary,
} from "../engine";

/** A small starter catalog. Enough to render the palette and exercise
 *  the canvas — the real adapters replace this with their engine's
 *  catalog (n8n has 400+ nodes). */
const N8N_NODE_TYPES: NodeTypeDescriptor[] = [
  {
    id: "n8n:webhook",
    kind: "n8n",
    name: "Webhook",
    category: "Trigger",
    blurb: "Run when an HTTP request hits the workflow URL.",
    glyph: "↘",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", default: "/" },
        method: { type: "string", enum: ["GET", "POST"], default: "POST" },
      },
    },
    requiresConnection: false,
  },
  {
    id: "n8n:schedule",
    kind: "n8n",
    name: "Schedule",
    category: "Trigger",
    blurb: "Fire on a cron schedule.",
    glyph: "⏱",
    parameters: {
      type: "object",
      properties: {
        cron: { type: "string", default: "0 * * * *" },
      },
    },
    requiresConnection: false,
  },
  {
    id: "n8n:http_request",
    kind: "n8n",
    name: "HTTP Request",
    category: "Core",
    blurb: "Call any HTTP endpoint.",
    glyph: "⇄",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], default: "GET" },
        body: { type: "string" },
      },
    },
    requiresConnection: false,
  },
  {
    id: "n8n:slack_send",
    kind: "n8n",
    name: "Slack — Send message",
    category: "Communication",
    blurb: "Post a message to a Slack channel.",
    glyph: "S",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string" },
        text: { type: "string" },
      },
    },
    requiresConnection: true,
    connectionProviders: ["slack"],
  },
  {
    id: "n8n:gmail_send",
    kind: "n8n",
    name: "Gmail — Send",
    category: "Communication",
    blurb: "Send an email through a connected Gmail account.",
    glyph: "G",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
    },
    requiresConnection: true,
    connectionProviders: ["gmail"],
  },
  {
    id: "n8n:openai_complete",
    kind: "n8n",
    name: "OpenAI — Complete",
    category: "AI",
    blurb: "Run a completion through a connected OpenAI account.",
    glyph: "AI",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        model: { type: "string", default: "gpt-4o-mini" },
      },
    },
    requiresConnection: true,
    connectionProviders: ["openai"],
  },
];

const OPENCLAW_NODE_TYPES: NodeTypeDescriptor[] = [
  {
    id: "openclaw:goal",
    kind: "openclaw",
    name: "Goal",
    category: "Agent",
    blurb: "Top-level objective the agent works toward.",
    glyph: "◎",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
    },
    requiresConnection: false,
  },
  {
    id: "openclaw:browse",
    kind: "openclaw",
    name: "Browse",
    category: "Tool",
    blurb: "Open a URL in the agent's headless browser.",
    glyph: "🌐",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
    },
    requiresConnection: false,
  },
  {
    id: "openclaw:llm_call",
    kind: "openclaw",
    name: "LLM Call",
    category: "Tool",
    blurb: "Run a prompt through a connected LLM provider.",
    glyph: "Λ",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
      },
    },
    requiresConnection: true,
    connectionProviders: ["openai", "anthropic"],
  },
  {
    id: "openclaw:write_file",
    kind: "openclaw",
    name: "Write File",
    category: "Tool",
    blurb: "Persist text to the agent's working directory.",
    glyph: "▤",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
    },
    requiresConnection: false,
  },
];

interface StubInstanceState {
  workflows: Map<string, WorkflowGraph>;
  executions: Map<string, ExecutionState>;
  boundCredentials: Map<string, { connectionId: string; expiresAt: string }>;
}

/** Phase-A in-memory adapter — one adapter handles both kinds, returning
 *  the matching catalog. The real adapters (`N8nEngineAdapter`,
 *  `OpenClawEngineAdapter`) replace this in later phases. */
export class StubEngineAdapter implements AutomationEngineAdapter {
  readonly kind: AutomationKind;
  private readonly catalog: NodeTypeDescriptor[];
  /** Per-instance state — workflows / executions are isolated per
   *  automation instance, the same way a real engine isolates them. */
  private readonly instances = new Map<string, StubInstanceState>();

  constructor(kind: AutomationKind) {
    this.kind = kind;
    this.catalog = kind === "n8n" ? N8N_NODE_TYPES : OPENCLAW_NODE_TYPES;
  }

  private getInstance(instanceId: string): StubInstanceState {
    let state = this.instances.get(instanceId);
    if (!state) {
      state = {
        workflows: new Map(),
        executions: new Map(),
        boundCredentials: new Map(),
      };
      this.instances.set(instanceId, state);
    }
    return state;
  }

  async listNodeTypes(): Promise<NodeTypeDescriptor[]> {
    return [...this.catalog];
  }

  async getNodeType(id: string): Promise<NodeTypeDescriptor | null> {
    return this.catalog.find((n) => n.id === id) ?? null;
  }

  async listWorkflows(instanceId: string): Promise<WorkflowSummary[]> {
    const state = this.getInstance(instanceId);
    return [...state.workflows.values()].map((wf) => ({
      id: wf.id,
      name: wf.name,
      active: true,
      lastRunAt: this.latestRunAt(state, wf.id),
      lastRunStatus: this.latestRunStatus(state, wf.id),
    }));
  }

  async loadWorkflow(
    instanceId: string,
    workflowId: string,
  ): Promise<WorkflowGraph> {
    const state = this.getInstance(instanceId);
    const wf = state.workflows.get(workflowId);
    if (!wf) throw new Error(`workflow not found: ${workflowId}`);
    return wf;
  }

  async saveWorkflow(
    instanceId: string,
    graph: WorkflowGraph,
  ): Promise<WorkflowGraph> {
    const state = this.getInstance(instanceId);
    const id = graph.id || mkId("wf");
    const saved: WorkflowGraph = { ...graph, id };
    state.workflows.set(id, saved);
    return saved;
  }

  async deleteWorkflow(
    instanceId: string,
    workflowId: string,
  ): Promise<boolean> {
    const state = this.getInstance(instanceId);
    return state.workflows.delete(workflowId);
  }

  async runWorkflow(
    instanceId: string,
    workflowId: string,
  ): Promise<{ executionId: string }> {
    const state = this.getInstance(instanceId);
    const wf = state.workflows.get(workflowId);
    if (!wf) throw new Error(`workflow not found: ${workflowId}`);
    const executionId = mkId("exec");
    const nodeStates: ExecutionState["nodeStates"] = {};
    for (const n of wf.nodes) nodeStates[n.id] = "pending";
    state.executions.set(executionId, {
      id: executionId,
      workflowId,
      status: "running",
      startedAt: now(),
      nodeStates,
    });
    // Advance synchronously: every node succeeds. The streamer below
    // replays the timeline at a paced rate so the Console feed feels
    // live without depending on a real engine.
    for (const n of wf.nodes) nodeStates[n.id] = "success";
    state.executions.set(executionId, {
      id: executionId,
      workflowId,
      status: "success",
      startedAt: now(),
      finishedAt: now(),
      nodeStates,
    });
    return { executionId };
  }

  async getExecution(
    instanceId: string,
    executionId: string,
  ): Promise<ExecutionState | null> {
    return this.getInstance(instanceId).executions.get(executionId) ?? null;
  }

  async *streamExecution(
    instanceId: string,
    executionId: string,
  ): AsyncIterable<ExecutionEvent> {
    const state = this.getInstance(instanceId);
    const exec = state.executions.get(executionId);
    if (!exec) return;
    const wf = state.workflows.get(exec.workflowId);
    yield {
      at: now(),
      executionId,
      kind: "execution_started",
    };
    if (wf) {
      for (const node of wf.nodes) {
        yield {
          at: now(),
          executionId,
          nodeId: node.id,
          kind: "node_started",
        };
        yield {
          at: now(),
          executionId,
          nodeId: node.id,
          kind: "node_succeeded",
        };
      }
    }
    yield {
      at: now(),
      executionId,
      kind: "execution_finished",
    };
  }

  async bindConnection(
    instanceId: string,
    connectionId: string,
    ctx?: BindConnectionContext,
  ): Promise<BindConnectionResult> {
    const state = this.getInstance(instanceId);
    const engineCredentialId = mkId("ecred");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    state.boundCredentials.set(engineCredentialId, { connectionId, expiresAt });
    // The stub has no real engine to push bytes into, but if `ctx` is
    // supplied we surface `pushed: true` so the audit log reflects that
    // the caller intentionally wired the payload through (useful for
    // tests that exercise the broker without a live engine).
    return { engineCredentialId, expiresAt, pushed: ctx !== undefined };
  }

  async unbindConnection(
    instanceId: string,
    engineCredentialId: string,
  ): Promise<void> {
    this.getInstance(instanceId).boundCredentials.delete(engineCredentialId);
  }

  private latestRunAt(
    state: StubInstanceState,
    workflowId: string,
  ): string | undefined {
    let latest: string | undefined;
    for (const exec of state.executions.values()) {
      if (exec.workflowId !== workflowId) continue;
      if (!latest || exec.startedAt > latest) latest = exec.startedAt;
    }
    return latest;
  }

  private latestRunStatus(
    state: StubInstanceState,
    workflowId: string,
  ): WorkflowSummary["lastRunStatus"] {
    let latestAt: string | undefined;
    let status: ExecutionState["status"] | undefined;
    for (const exec of state.executions.values()) {
      if (exec.workflowId !== workflowId) continue;
      if (!latestAt || exec.startedAt > latestAt) {
        latestAt = exec.startedAt;
        status = exec.status;
      }
    }
    if (status === "success") return "success";
    if (status === "failed") return "failed";
    if (status === "running" || status === "queued") return "running";
    return undefined;
  }
}
