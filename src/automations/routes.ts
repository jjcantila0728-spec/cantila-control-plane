/* ============================================================
   /v1/automations/* — HTTP surface for Cantila Automations.

   The Console reads instance lifecycle + workflow graphs + run
   state through these routes. Workflows / runs are delegated to
   the engine adapter (kind-dispatched) so this module owns
   request/response shape, never engine-specific logic.

   Phase A (current): stub engine, no deploy-pipeline kick.
   Phase B swaps the n8n adapter for the real one and the same
   routes work unchanged.
   ============================================================ */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ControlPlane } from "../core/control-plane";
import type { Store } from "../domain/store";
import type { AutomationKind, Project } from "../domain/types";
import type { WorkflowGraph, AutomationEngineAdapter } from "./engine";
import { parseN8nWorkflowExport, N8nEngineAdapter } from "./engines/n8n";
import { OpenClawEngineAdapter } from "./engines/openclaw";
import type { DefaultEngineRegistry } from "./registry";
import type { WorkspaceProvisioner } from "../deploy/provisioning";

const automationKindSchema = z.enum(["n8n", "openclaw"]);

const createAutomationSchema = z.object({
  kind: automationKindSchema,
  name: z.string().min(1).max(64),
  region: z.enum(["fsn1", "hel1", "ash"]).optional(),
});

const saveWorkflowSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(120),
  nodes: z.array(z.unknown()),
  edges: z.array(z.unknown()),
  triggers: z.array(z.unknown()),
  meta: z.record(z.unknown()).optional(),
});

const importWorkflowSchema = z.object({
  /** Raw n8n workflow export JSON (n8n's *Download* / *Copy* output). The
   *  deep shape is validated by `parseN8nWorkflowExport`; here we only
   *  assert it's an object so a clearly-bad body 400s early. */
  workflow: z.record(z.unknown()),
  /** Optional name override — defaults to the export's own name. */
  name: z.string().min(1).max(120).optional(),
});

const runWorkflowSchema = z
  .object({
    input: z.unknown().optional(),
  })
  .optional();

interface RouteDeps {
  cp: ControlPlane;
  store: Store;
  registry: DefaultEngineRegistry;
  resolveAccountId: (req: FastifyRequest) => string;
  /** When present, new automation instances are provisioned eagerly
   *  (a real container is created) instead of waiting for a deploy. */
  workspaceProvisioner?: WorkspaceProvisioner;
}

/** Spawn a background "capture" task that re-iterates the adapter's
 *  execution stream and persists every event onto the captured
 *  `WorkflowExecutionRecord` (plan §15.5 Phase F). Fire-and-forget on
 *  purpose — the route returns 202 immediately and the capture finishes
 *  on its own clock. Errors are swallowed; the record's final status
 *  reflects whatever the engine reported when the iterator closed. */
function startExecutionCapture(args: {
  cp: ControlPlane;
  adapter: ReturnType<DefaultEngineRegistry["get"]>;
  automationId: string;
  executionId: string;
}): void {
  const { cp, adapter, automationId, executionId } = args;
  void (async () => {
    try {
      for await (const ev of adapter.streamExecution(automationId, executionId)) {
        await cp.appendCapturedExecutionEvent(executionId, ev);
        if (ev.kind === "execution_finished") break;
      }
      // Pull the engine's terminal state so we can record per-node
      // outcomes alongside the captured event tape.
      const exec = await adapter.getExecution(automationId, executionId);
      if (exec) {
        const status: "success" | "failed" =
          exec.status === "success" ? "success" : "failed";
        await cp.completeCapturedExecution(executionId, {
          status,
          finishedAt: exec.finishedAt,
          nodeStates: exec.nodeStates,
          error: exec.error,
        });
      } else {
        await cp.completeCapturedExecution(executionId, {
          status: "failed",
          error: "execution not found",
        });
      }
    } catch (err) {
      await cp.completeCapturedExecution(executionId, {
        status: "failed",
        error: err instanceof Error ? err.message : "capture failed",
      });
    }
  })();
}

interface AutomationSummary {
  id: string;
  kind: AutomationKind;
  name: string;
  slug: string;
  status: Project["status"];
  region: Project["region"];
  alwaysOn: boolean;
  createdAt: string;
  adminUrl: string;
  /** The workspace's native UI URL — set once the container is
   *  provisioned. Absent until provisioning completes. */
  workspaceUrl?: string;
  /** Admin username for the native workspace UI. */
  workspaceAdminUser?: string;
}

function toSummary(p: Project): AutomationSummary | null {
  if (!p.automationKind) return null;
  const cfg = p.automationConfig as Record<string, unknown> | undefined;
  const workspaceUrl = cfg?.workspaceUrl as string | undefined;
  return {
    id: p.id,
    kind: p.automationKind,
    name: p.name,
    slug: p.slug,
    status: p.status,
    region: p.region,
    alwaysOn: p.alwaysOn,
    createdAt: p.createdAt,
    // adminUrl uses the real workspace URL when provisioned; falls back
    // to the project subdomain for legacy rows without automationConfig.
    adminUrl: workspaceUrl ?? `https://${p.slug}.cantila.app`,
    workspaceUrl,
    workspaceAdminUser: cfg?.workspaceAdminUser as string | undefined,
  };
}

/** Build a per-project adapter using the workspace URL + API key stored
 *  in `automationConfig`. Falls back to the global registry adapter
 *  (which may be a stub) when no workspace has been provisioned yet. */
function adapterForProject(
  project: Project,
  registry: DefaultEngineRegistry,
): AutomationEngineAdapter {
  const cfg = project.automationConfig as Record<string, unknown> | undefined;
  const workspaceUrl = cfg?.workspaceUrl as string | undefined;
  const apiKey = cfg?.workspaceApiKey as string | undefined;
  if (workspaceUrl && apiKey && project.automationKind) {
    if (project.automationKind === "n8n") {
      return new N8nEngineAdapter({ baseUrl: workspaceUrl, apiKey });
    }
    if (project.automationKind === "openclaw") {
      return new OpenClawEngineAdapter({ baseUrl: workspaceUrl, apiKey });
    }
  }
  return registry.get(project.automationKind!);
}

export function registerAutomationRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): void {
  const { cp, store, registry, resolveAccountId, workspaceProvisioner } = deps;

  /* ----- info — which engine adapter is wired per kind ----- */

  app.get("/v1/automations/info", async () => {
    return {
      kinds: (["n8n", "openclaw"] as AutomationKind[]).map((k) => ({
        kind: k,
        label: registry.labels.get(k) ?? `${k}@unknown`,
        live: (registry.labels.get(k) ?? "").endsWith("@live"),
      })),
    };
  });

  /* ----- instances ----- */

  app.get("/v1/automations", async (request) => {
    const accountId = resolveAccountId(request);
    const projects = await cp.listProjects(accountId);
    const kindFilter = (request.query as { kind?: string }).kind;
    const summaries = projects
      .map(toSummary)
      .filter((s): s is AutomationSummary => s !== null)
      .filter((s) => !kindFilter || s.kind === kindFilter);
    return { automations: summaries };
  });

  app.post("/v1/automations", async (request, reply) => {
    const parsed = createAutomationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const accountId = resolveAccountId(request);
    const project = await cp.createProject({
      accountId,
      name: parsed.data.name,
      runtime: "docker",
      region: parsed.data.region ?? "fsn1",
    });
    // Tag the project as an automation instance, then eagerly provision
    // its workspace (real container) if a provisioner is wired. The
    // workspace URL + credentials land in automationConfig so the
    // per-instance adapter and the Console iframe can use them
    // immediately — no deploy step required.
    let automationConfig: Record<string, unknown> = {};
    if (workspaceProvisioner) {
      try {
        const ws = await workspaceProvisioner.createWorkspace(
          project,
          parsed.data.kind,
        );
        automationConfig = {
          workspaceUrl: ws.workspaceUrl,
          workspaceAdminUser: ws.adminUser,
          // The API key (= CANTILA_API_KEY injected into the container)
          // drives the per-instance engine adapter; not exposed to the
          // client summary.
          workspaceApiKey: ws.adminPassword,
        };
      } catch {
        // Provisioning failed (e.g. no Coolify creds in dev). Fall
        // through with empty config — the stub adapter handles it.
      }
    }
    const tagged = await store.updateProject(project.id, {
      automationKind: parsed.data.kind,
      automationConfig,
    });
    return reply.code(201).send({ automation: toSummary(tagged) });
  });

  app.get("/v1/automations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await cp.getProject(id);
    if (!project || !project.automationKind) {
      return reply.code(404).send({ error: "automation not found" });
    }
    if (project.accountId !== resolveAccountId(request)) {
      return reply.code(404).send({ error: "automation not found" });
    }
    return { automation: toSummary(project) };
  });

  app.delete("/v1/automations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await cp.getProject(id);
    if (!project || !project.automationKind) {
      return reply.code(404).send({ error: "automation not found" });
    }
    if (project.accountId !== resolveAccountId(request)) {
      return reply.code(404).send({ error: "automation not found" });
    }
    // Phase A: tombstone the row by flipping status — full project
    // teardown lands when the deploy-pipeline integration ships.
    await store.updateProject(id, { status: "paused" });
    return reply.code(204).send();
  });

  /* ----- node catalog (drives the canvas palette) ----- */

  app.get("/v1/automations/:id/node-types", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await cp.getProject(id);
    if (!project?.automationKind) {
      return reply.code(404).send({ error: "automation not found" });
    }
    if (project.accountId !== resolveAccountId(request)) {
      return reply.code(404).send({ error: "automation not found" });
    }
    const adapter = adapterForProject(project, registry);
    return { nodeTypes: await adapter.listNodeTypes() };
  });

  /* ----- workflows ----- */

  app.get("/v1/automations/:id/workflows", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await cp.getProject(id);
    if (!project?.automationKind) {
      return reply.code(404).send({ error: "automation not found" });
    }
    if (project.accountId !== resolveAccountId(request)) {
      return reply.code(404).send({ error: "automation not found" });
    }
    const adapter = adapterForProject(project, registry);
    return { workflows: await adapter.listWorkflows(id) };
  });

  app.post("/v1/automations/:id/workflows", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await cp.getProject(id);
    if (!project?.automationKind) {
      return reply.code(404).send({ error: "automation not found" });
    }
    if (project.accountId !== resolveAccountId(request)) {
      return reply.code(404).send({ error: "automation not found" });
    }
    const parsed = saveWorkflowSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const adapter = adapterForProject(project, registry);
    const saved = await adapter.saveWorkflow(id, {
      id: parsed.data.id ?? "",
      name: parsed.data.name,
      nodes: parsed.data.nodes as WorkflowGraph["nodes"],
      edges: parsed.data.edges as WorkflowGraph["edges"],
      triggers: parsed.data.triggers as WorkflowGraph["triggers"],
      meta: parsed.data.meta,
    });
    return reply.code(201).send({ workflow: saved });
  });

  /* ----- import an existing n8n workflow (n8n "Download" JSON) ----- */

  app.post("/v1/automations/:id/workflows/import", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await cp.getProject(id);
    if (!project?.automationKind) {
      return reply.code(404).send({ error: "automation not found" });
    }
    if (project.accountId !== resolveAccountId(request)) {
      return reply.code(404).send({ error: "automation not found" });
    }
    // The export format is n8n-specific — OpenClaw has no equivalent, so
    // refuse rather than mangle a graph the engine can't run.
    if (project.automationKind !== "n8n") {
      return reply
        .code(400)
        .send({ error: "import is only supported for n8n automations" });
    }
    const parsed = importWorkflowSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    let graph: WorkflowGraph;
    try {
      graph = parseN8nWorkflowExport(parsed.data.workflow);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : "invalid workflow export",
      });
    }
    if (parsed.data.name) graph = { ...graph, name: parsed.data.name };
    const adapter = adapterForProject(project, registry);
    const saved = await adapter.saveWorkflow(id, graph);
    return reply.code(201).send({ workflow: saved });
  });

  app.get(
    "/v1/automations/:id/workflows/:workflowId",
    async (request, reply) => {
      const { id, workflowId } = request.params as {
        id: string;
        workflowId: string;
      };
      const project = await cp.getProject(id);
      if (!project?.automationKind) {
        return reply.code(404).send({ error: "automation not found" });
      }
      if (project.accountId !== resolveAccountId(request)) {
        return reply.code(404).send({ error: "automation not found" });
      }
      const adapter = adapterForProject(project, registry);
      try {
        const wf = await adapter.loadWorkflow(id, workflowId);
        return { workflow: wf };
      } catch {
        return reply.code(404).send({ error: "workflow not found" });
      }
    },
  );

  app.post(
    "/v1/automations/:id/workflows/:workflowId/run",
    async (request, reply) => {
      const { id, workflowId } = request.params as {
        id: string;
        workflowId: string;
      };
      const project = await cp.getProject(id);
      if (!project?.automationKind) {
        return reply.code(404).send({ error: "automation not found" });
      }
      if (project.accountId !== resolveAccountId(request)) {
        return reply.code(404).send({ error: "automation not found" });
      }
      const parsed = runWorkflowSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const adapter = adapterForProject(project, registry);
      try {
        const result = await adapter.runWorkflow(
          id,
          workflowId,
          parsed.data?.input,
        );
        // Persist a captured run row + spawn the background capture
        // iterator. The Console's SSE stream is independent; the capture
        // is what backs "Runs list + Replay" (plan §15.5 Phase F).
        let workflowName: string | undefined;
        try {
          const wf = await adapter.loadWorkflow(id, workflowId);
          workflowName = wf?.name;
        } catch {
          // Engine may not be reachable on this code path; the captured
          // row can still land without a label.
        }
        await cp.recordWorkflowExecution({
          id: result.executionId,
          automationId: id,
          accountId: project.accountId,
          workflowId,
          workflowName,
        });
        startExecutionCapture({
          cp,
          adapter,
          automationId: id,
          executionId: result.executionId,
        });
        return reply.code(202).send(result);
      } catch {
        return reply.code(404).send({ error: "workflow not found" });
      }
    },
  );

  /* ----- captured execution history (plan §15.5 Phase F) ----- */

  app.get("/v1/automations/:id/executions", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await cp.getProject(id);
    if (!project?.automationKind) {
      return reply.code(404).send({ error: "automation not found" });
    }
    if (project.accountId !== resolveAccountId(request)) {
      return reply.code(404).send({ error: "automation not found" });
    }
    const q = request.query as { workflowId?: string; limit?: string };
    const limit = q.limit ? Number(q.limit) : undefined;
    const executions = await cp.listWorkflowExecutions({
      automationId: id,
      workflowId: q.workflowId,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    // Strip the events array off the list view — only the detail
    // endpoint returns the full tape so the list stays small over the
    // wire.
    return {
      executions: executions.map((r) => ({
        id: r.id,
        automationId: r.automationId,
        workflowId: r.workflowId,
        workflowName: r.workflowName,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        replayOfId: r.replayOfId,
        eventCount: r.events.length,
        nodeStates: r.nodeStates,
        error: r.error,
      })),
    };
  });

  app.get(
    "/v1/automations/:id/executions/:executionId/events",
    async (request, reply) => {
      const { id, executionId } = request.params as {
        id: string;
        executionId: string;
      };
      const project = await cp.getProject(id);
      if (!project?.automationKind) {
        return reply.code(404).send({ error: "automation not found" });
      }
      if (project.accountId !== resolveAccountId(request)) {
        return reply.code(404).send({ error: "automation not found" });
      }
      const record = await cp.getWorkflowExecution(executionId);
      if (!record || record.automationId !== id) {
        return reply.code(404).send({ error: "execution not found" });
      }
      return { execution: record };
    },
  );

  app.post(
    "/v1/automations/:id/executions/:executionId/replay",
    async (request, reply) => {
      const { id, executionId } = request.params as {
        id: string;
        executionId: string;
      };
      const project = await cp.getProject(id);
      if (!project?.automationKind) {
        return reply.code(404).send({ error: "automation not found" });
      }
      if (project.accountId !== resolveAccountId(request)) {
        return reply.code(404).send({ error: "automation not found" });
      }
      const source = await cp.getWorkflowExecution(executionId);
      if (!source || source.automationId !== id) {
        return reply.code(404).send({ error: "execution not found" });
      }
      const adapter = adapterForProject(project, registry);
      try {
        const result = await adapter.runWorkflow(id, source.workflowId);
        await cp.recordWorkflowExecution({
          id: result.executionId,
          automationId: id,
          accountId: project.accountId,
          workflowId: source.workflowId,
          workflowName: source.workflowName,
          replayOfId: source.id,
        });
        startExecutionCapture({
          cp,
          adapter,
          automationId: id,
          executionId: result.executionId,
        });
        return reply
          .code(202)
          .send({ executionId: result.executionId, replayOfId: source.id });
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : "replay failed",
        });
      }
    },
  );

  /* ----- credential broker (plan §15.5 Phase F) ----- */

  app.post(
    "/v1/automations/:id/connections/:connectionId/bind",
    async (request, reply) => {
      const { id, connectionId } = request.params as {
        id: string;
        connectionId: string;
      };
      const accountId = resolveAccountId(request);
      const project = await cp.getProject(id);
      if (
        !project?.automationKind ||
        project.accountId !== accountId
      ) {
        return reply.code(404).send({ error: "automation not found" });
      }
      const result = await cp.bindConnectionForRun({
        automationId: id,
        connectionId,
        accountId,
      });
      if ("error" in result) {
        const code =
          result.error === "connection not found" ||
          result.error === "automation not found"
            ? 404
            : 400;
        return reply.code(code).send({ error: result.error });
      }
      return reply.code(201).send(result);
    },
  );

  app.post(
    "/v1/automations/:id/credentials/:engineCredentialId/unbind",
    async (request, reply) => {
      const { id, engineCredentialId } = request.params as {
        id: string;
        engineCredentialId: string;
      };
      const body = (request.body ?? {}) as { connectionId?: string };
      const connectionId = body.connectionId ?? "unknown";
      const accountId = resolveAccountId(request);
      const project = await cp.getProject(id);
      if (
        !project?.automationKind ||
        project.accountId !== accountId
      ) {
        return reply.code(404).send({ error: "automation not found" });
      }
      const result = await cp.unbindConnectionForRun({
        automationId: id,
        connectionId,
        engineCredentialId,
        accountId,
      });
      if ("error" in result) {
        return reply.code(400).send({ error: result.error });
      }
      return reply.code(204).send();
    },
  );

  app.get(
    "/v1/automations/:id/executions/:executionId",
    async (request, reply) => {
      const { id, executionId } = request.params as {
        id: string;
        executionId: string;
      };
      const project = await cp.getProject(id);
      if (!project?.automationKind) {
        return reply.code(404).send({ error: "automation not found" });
      }
      if (project.accountId !== resolveAccountId(request)) {
        return reply.code(404).send({ error: "automation not found" });
      }
      const adapter = adapterForProject(project, registry);
      const exec = await adapter.getExecution(id, executionId);
      if (!exec) return reply.code(404).send({ error: "execution not found" });
      return { execution: exec };
    },
  );

  /* ----- execution event stream (SSE — plan §4.10 ExecutionFeed) ----- */

  app.get(
    "/v1/automations/:id/executions/:executionId/stream",
    async (request, reply) => {
      const { id, executionId } = request.params as {
        id: string;
        executionId: string;
      };
      const project = await cp.getProject(id);
      if (!project?.automationKind) {
        return reply.code(404).send({ error: "automation not found" });
      }
      if (project.accountId !== resolveAccountId(request)) {
        return reply.code(404).send({ error: "automation not found" });
      }
      const adapter = adapterForProject(project, registry);
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      reply.raw.write(`: open\n\n`);
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(`: ping\n\n`);
        } catch {
          // socket closed — interval cleared in close handler below.
        }
      }, 15_000);
      request.raw.on("close", () => {
        clearInterval(heartbeat);
      });
      try {
        for await (const event of adapter.streamExecution(id, executionId)) {
          if (reply.raw.writableEnded || request.raw.destroyed) break;
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : "stream error";
        try {
          reply.raw.write(`data: ${JSON.stringify({ kind: "execution_finished", detail, executionId, at: new Date().toISOString() })}\n\n`);
        } catch {
          // socket already closed.
        }
      } finally {
        clearInterval(heartbeat);
        reply.raw.end();
      }
    },
  );
}
