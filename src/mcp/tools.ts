/* ============================================================
   The Cantila MCP tool set — plan §4.3.2.
   Each tool is a thin wrapper over the shared ControlPlane service,
   so the HTTP API and the MCP server share one core implementation.
   ============================================================ */

import type { ControlPlane } from "../core/control-plane";
import { ownerAccountId } from "../lib/owner-account";
import { MobileError, type MobileService } from "../mobile/service";
import type { McpContext, ToolDefinition, ToolResult } from "./server";
import type {
  DbEngine,
  DeployTrigger,
  Region,
  Runtime,
} from "../domain/types";

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

function errorText(body: string): ToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

const TRIGGERS: readonly string[] = ["chat", "git", "cli", "mcp", "upload"];
const RUNTIMES: readonly string[] = [
  "static",
  "node",
  "python",
  "php",
  "go",
  "ruby",
  "docker",
];
const REGIONS: readonly string[] = ["fsn1", "hel1", "ash"];
const ENGINES: readonly string[] = ["postgres", "mysql", "mongodb", "redis"];

function asTrigger(value: unknown): DeployTrigger {
  return typeof value === "string" && TRIGGERS.includes(value)
    ? (value as DeployTrigger)
    : "mcp";
}

function asRuntime(value: unknown): Runtime {
  return typeof value === "string" && RUNTIMES.includes(value)
    ? (value as Runtime)
    : "node";
}

function asRegion(value: unknown): Region {
  return typeof value === "string" && REGIONS.includes(value)
    ? (value as Region)
    : "fsn1";
}

function asEngine(value: unknown): DbEngine {
  return typeof value === "string" && ENGINES.includes(value)
    ? (value as DbEngine)
    : "postgres";
}

/* Per-call tenant-isolation guard for the MCP surface.
 *
 * The tool defs below are written for the trusted local (stdio) case and
 * default account-scoped reads to the owner. Over HTTP (`POST /v1/mcp`)
 * the transport threads the authenticated `ctx.accountId`, and EVERY tool
 * must be confined to that account. Rather than sprinkle checks across ~28
 * handlers, we derive each tool's scope from its declared inputSchema and
 * enforce it in one place — fail-closed: a tool that declares neither
 * `projectId` nor `accountId` (e.g. the global agents brain) is owner-only
 * for remote callers, so future tools are safe by default too. */
function withTenantGuard(
  cp: ControlPlane,
  def: ToolDefinition,
): ToolDefinition {
  const props = (def.inputSchema?.properties ?? {}) as Record<string, unknown>;
  const scopesProject = "projectId" in props;
  const scopesAccount = "accountId" in props;
  const inner = def.handler;
  return {
    ...def,
    handler: async (args, ctx) => {
      // Trusted local stdio caller — legacy behavior, no confinement.
      if (ctx.accountId == null) return inner(args, ctx);
      const principal = ctx.accountId;

      if (scopesProject) {
        const projectId = String(args.projectId ?? "");
        if (projectId) {
          const project = await cp.getProject(projectId);
          if (!project) return errorText(`Project ${projectId} not found.`);
          if (
            project.accountId !== principal &&
            !(await cp.canActOnAccount(principal, project.accountId))
          ) {
            return errorText(
              `Project ${projectId} belongs to a different account.`,
            );
          }
        }
      } else if (scopesAccount) {
        const requested =
          args.accountId != null ? String(args.accountId) : principal;
        if (
          requested !== principal &&
          !(await cp.canActOnAccount(principal, requested))
        ) {
          return errorText(
            `Account ${requested} is not accessible from your account.`,
          );
        }
        // Pin the resolved account so the handler's `?? ownerAccountId()`
        // fallback can never widen scope for a remote caller.
        args = { ...args, accountId: requested };
      } else if (principal !== ownerAccountId()) {
        // Open/global tool (no project or account arg) — owner-only remotely.
        return errorText("This tool is not available to your account.");
      }

      return inner(args, ctx);
    },
  };
}

export function cantilaTools(
  cp: ControlPlane,
  extras: { mobile?: MobileService } = {},
): ToolDefinition[] {
  const defs: ToolDefinition[] = [
    /* ---------- cantila_deploy ---------- */
    {
      name: "cantila_deploy",
      description:
        "Deploy a project to Cantila. Runs the full pipeline — including auto-wiring the project's own database, email and SMS — and returns the live URL.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The Cantila project id to deploy.",
          },
          trigger: {
            type: "string",
            enum: ["chat", "git", "cli", "mcp", "upload"],
            description: "How the deploy was initiated. Defaults to mcp.",
          },
        },
        required: ["projectId"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        if (!projectId) return errorText("projectId is required.");
        try {
          const outcome = await cp.deploy(projectId, {
            trigger: asTrigger(args.trigger),
            source: { kind: "chat" },
          });
          const p = outcome.provisioned;
          const lines = [
            `Deploy ${outcome.status} — ${outcome.url}`,
            `Deployment: ${outcome.deploymentId}`,
            `Auto-wired this run — database: ${p.databaseCreated}, workspace: ${p.workspaceCreated}`,
            p.injectedEnv.length > 0
              ? `Injected env: ${p.injectedEnv.join(", ")}`
              : "Services already wired — no new env injected.",
            `Steps: ${outcome.steps.join(" -> ")}`,
          ];
          return text(lines.join("\n"));
        } catch (err) {
          return errorText(
            err instanceof Error ? err.message : "deploy failed",
          );
        }
      },
    },

    /* ---------- cantila_list_projects ---------- */
    {
      name: "cantila_list_projects",
      description:
        "List the user's Cantila projects with their status, runtime, region, and most recent deployment URL.",
      inputSchema: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description: "Account id to scope the listing to. Defaults to the configured owner account.",
          },
        },
      },
      handler: async (args) => {
        const accountId = String(args.accountId ?? ownerAccountId());
        const projects = await cp.listProjects(accountId);
        if (projects.length === 0) {
          return text(`No projects in account ${accountId}.`);
        }
        const lines = projects.map(
          (p) =>
            `${p.slug} (${p.id}) — ${p.status} · ${p.runtime} · ${p.region}`,
        );
        return text(
          `${projects.length} project(s) in ${accountId}:\n${lines.join("\n")}`,
        );
      },
    },

    /* ---------- cantila_status ---------- */
    {
      name: "cantila_status",
      description:
        "Report a Cantila project's status — its state, its auto-wired services (database, email, SMS), domains, and recent deployments.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The Cantila project id.",
          },
        },
        required: ["projectId"],
      },
      handler: async (args) => {
        const detail = await cp.getProjectDetail(String(args.projectId ?? ""));
        if (!detail) return errorText("project not found.");
        const { project, services, deployments, domains } = detail;
        const primary = domains.find((d) => d.primary) ?? domains[0];
        const lines = [
          `Project ${project.name} (${project.slug}) — status: ${project.status}`,
          `Runtime: ${project.runtime} · Region: ${project.region}`,
          `Resources: ${project.vcpu} vCPU · ${project.memoryMb} MB RAM · ${project.diskGb} GB disk · ${project.alwaysOn ? "always-on" : "auto-sleep"}`,
          `Primary URL: ${primary ? `https://${primary.hostname}` : "(none)"}`,
          `Database: ${services.database ? `${services.database.engine} ${services.database.version} (${services.database.status})` : "not provisioned"}`,
          `Email: ${services.mailbox ? `${services.mailbox.address} (${services.mailbox.status})` : "not provisioned"}`,
          `SMS: ${services.phoneNumber ? `${services.phoneNumber.e164} (${services.phoneNumber.status})` : "not provisioned"}`,
          `Domains: ${domains.length} · Deployments: ${deployments.length}`,
        ];
        return text(lines.join("\n"));
      },
    },

    /* ---------- cantila_get_logs ---------- */
    {
      name: "cantila_get_logs",
      description:
        "Fetch build and deploy logs for a Cantila project's deployments.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The Cantila project id.",
          },
        },
        required: ["projectId"],
      },
      handler: async (args) => {
        const logs = await cp.getLogs(String(args.projectId ?? ""));
        if (!logs) return errorText("project not found.");
        if (logs.length === 0) {
          return text("No deployments yet for this project.");
        }
        const blocks = logs.map(
          (d) => `# ${d.deploymentId} (${d.status})\n${d.logs.join("\n")}`,
        );
        return text(blocks.join("\n\n"));
      },
    },

    /* ---------- cantila_set_env ---------- */
    {
      name: "cantila_set_env",
      description:
        "Set or update an environment variable (or secret) on a Cantila project.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The Cantila project id.",
          },
          key: {
            type: "string",
            description: "The environment variable name.",
          },
          value: { type: "string", description: "The value to set." },
          secret: {
            type: "boolean",
            description:
              "Store as a secret (masked in logs). Defaults to true.",
          },
        },
        required: ["projectId", "key", "value"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        const key = String(args.key ?? "");
        const value = String(args.value ?? "");
        if (!projectId || !key) {
          return errorText("projectId and key are required.");
        }
        const result = await cp.setEnv(projectId, key, value, {
          secret: typeof args.secret === "boolean" ? args.secret : true,
        });
        if (!result) return errorText("project not found.");
        return text(
          `Set ${result.key} (${result.secret ? "secret" : "plain"}, scope ${result.scope}) = ${result.value}`,
        );
      },
    },

    /* ---------- cantila_provision_db ---------- */
    {
      name: "cantila_provision_db",
      description:
        "Provision (or report) the project's bundled managed database. Idempotent — returns the existing database if one is already wired.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The Cantila project id.",
          },
          engine: {
            type: "string",
            enum: ["postgres", "mysql", "mongodb", "redis"],
            description: "Engine — defaults to postgres.",
          },
        },
        required: ["projectId"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        if (!projectId) return errorText("projectId is required.");
        const result = await cp.provisionDb(projectId, asEngine(args.engine));
        if ("error" in result) return errorText(result.error);
        return text(
          [
            `Database ready — ${result.engine} ${result.version} (${result.status})`,
            `Connection: ${result.connectionUri}`,
            "DATABASE_URL has been injected as a secret on the project.",
          ].join("\n"),
        );
      },
    },

    /* ---------- cantila_delete_project ---------- */
    {
      name: "cantila_delete_project",
      description:
        "Permanently delete a Cantila project — tears down its app and managed database and removes all of its data. This cannot be undone.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The Cantila project id to delete.",
          },
        },
        required: ["projectId"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        if (!projectId) return errorText("projectId is required.");
        const result = await cp.deleteProject(projectId);
        if ("error" in result) return errorText(result.error);
        return text(
          `Deleted project ${result.slug} (${projectId}) — app and database torn down.`,
        );
      },
    },

    /* ---------- cantila_delete_database ---------- */
    {
      name: "cantila_delete_database",
      description:
        "Delete a Cantila project's managed database — tears down the Postgres and strips DATABASE_URL. The app is left in place; re-provision later with cantila_provision_db.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The Cantila project id.",
          },
        },
        required: ["projectId"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        if (!projectId) return errorText("projectId is required.");
        const result = await cp.deleteProjectDatabase(projectId);
        if ("error" in result) return errorText(result.error);
        return text(
          `Deleted the database on ${projectId} — DATABASE_URL removed. Re-provision with cantila_provision_db.`,
        );
      },
    },

    /* ---------- cantila_add_domain ---------- */
    {
      name: "cantila_add_domain",
      description:
        "Attach a custom domain to a Cantila project. Returns the DNS record the user must publish and the SSL status.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The Cantila project id.",
          },
          hostname: {
            type: "string",
            description: "The domain to attach (e.g. www.example.com).",
          },
        },
        required: ["projectId", "hostname"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        const hostname = String(args.hostname ?? "");
        if (!projectId || !hostname) {
          return errorText("projectId and hostname are required.");
        }
        const result = await cp.addDomain(projectId, hostname);
        if ("error" in result) return errorText(result.error);
        return text(
          [
            `Domain attached: ${result.domain.hostname} (${result.domain.kind})`,
            `SSL: ${result.ssl}`,
            `DNS: ${result.dns.type} ${result.dns.name} -> ${result.dns.value}`,
          ].join("\n"),
        );
      },
    },

    /* ---------- cantila_scale ---------- */
    {
      name: "cantila_scale",
      description:
        "Vertically and horizontally resize a Cantila project. CPU/RAM/disk + always-on apply on next deploy; instance counts (plan §5.2) take effect on the load balancer immediately.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The Cantila project id.",
          },
          vcpu: { type: "number", description: "Number of vCPUs." },
          memoryMb: { type: "number", description: "Memory in megabytes." },
          diskGb: { type: "number", description: "Disk size in gigabytes." },
          alwaysOn: {
            type: "boolean",
            description:
              "true = pin always-on; false = let it sleep on idle.",
          },
          desiredInstances: {
            type: "number",
            description:
              "Number of container instances the LB should target now (1–32). Clamped into [minInstances, maxInstances].",
          },
          minInstances: {
            type: "number",
            description: "Lower bound auto-scaling must respect (>= 1).",
          },
          maxInstances: {
            type: "number",
            description: "Upper bound auto-scaling must respect (<= 32).",
          },
        },
        required: ["projectId"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        if (!projectId) return errorText("projectId is required.");
        const spec = {
          vcpu: typeof args.vcpu === "number" ? args.vcpu : undefined,
          memoryMb:
            typeof args.memoryMb === "number" ? args.memoryMb : undefined,
          diskGb: typeof args.diskGb === "number" ? args.diskGb : undefined,
          alwaysOn:
            typeof args.alwaysOn === "boolean" ? args.alwaysOn : undefined,
          desiredInstances:
            typeof args.desiredInstances === "number"
              ? args.desiredInstances
              : undefined,
          minInstances:
            typeof args.minInstances === "number"
              ? args.minInstances
              : undefined,
          maxInstances:
            typeof args.maxInstances === "number"
              ? args.maxInstances
              : undefined,
        };
        const result = await cp.scale(projectId, spec);
        if (!result) return errorText("project not found.");
        if ("error" in result) return errorText(result.error);
        return text(
          `Scaled ${result.slug} → ${result.vcpu} vCPU · ${result.memoryMb} MB · ${result.diskGb} GB · ${result.alwaysOn ? "always-on" : "auto-sleep"} · instances ${result.desiredInstances} (${result.minInstances}–${result.maxInstances})`,
        );
      },
    },

    /* ---------- cantila_change_subdomain ---------- */
    {
      name: "cantila_change_subdomain",
      description:
        "Change a Cantila project's subdomain. Rewrites the project's free <slug>.cantila.app address (the slug is normalised and must be globally unique). The DNS/routing record updates immediately; the live URL switches on the project's next deploy. The old <slug>.cantila.app stops working, and the existing mailbox keeps its old address.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The Cantila project id.",
          },
          slug: {
            type: "string",
            description:
              "The new subdomain, without the .cantila.app suffix (e.g. \"homes-prod\"). Normalised server-side: lowercased, non-alphanumerics become hyphens.",
          },
        },
        required: ["projectId", "slug"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        if (!projectId) return errorText("projectId is required.");
        const slug = String(args.slug ?? "");
        if (!slug) return errorText("slug is required.");
        const result = await cp.renameSlug(projectId, slug);
        if ("error" in result) return errorText(result.error);
        return text(
          `Subdomain changed → ${result.slug}.cantila.app (live on the next deploy). The old URL no longer resolves.`,
        );
      },
    },

    /* ---------- cantila_list_instances ---------- */
    {
      name: "cantila_list_instances",
      description:
        "List the project's container instances — per-instance node, region and health. (Plan §5.2 — horizontal scaling)",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "The Cantila project id." },
        },
        required: ["projectId"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        if (!projectId) return errorText("projectId is required.");
        const list = await cp.listInstances(projectId);
        if (list.length === 0) {
          return text(`No instances on ${projectId} — deploy the project first.`);
        }
        const lines = list.map(
          (i) =>
            `- [${i.index}] ${i.id} · ${i.nodeId} (${i.region}) · ${i.status}`,
        );
        return text(
          `${list.length} instance(s) on ${projectId}:\n${lines.join("\n")}`,
        );
      },
    },

    /* ---------- cantila_agents_status ---------- */
    {
      name: "cantila_agents_status",
      description:
        "Snapshot the Cantila Agents brain — pending proposals, recent automated actions, and per-agent stats. (Plan §4.9)",
      inputSchema: {
        type: "object",
        properties: {
          fresh: {
            type: "boolean",
            description: "Force one synchronous tick first.",
          },
        },
      },
      handler: async (args) => {
        if (args.fresh === true) await cp.tickAgents();
        const snap = cp.agentsStatus();
        const lines = [
          `Brain — ${snap.paused ? "PAUSED" : "running"}`,
          `Pending proposals: ${snap.pendingProposals.length}`,
          ...snap.pendingProposals.map(
            (p) =>
              `  [${p.confidence}/${p.actionClass}] ${p.title}\n     ${p.body}`,
          ),
          "",
          `Recent actions: ${snap.recentActions.length}`,
          ...snap.recentActions
            .slice(0, 10)
            .map((a) => `  ${a.outcome === "ok" ? "✓" : "✗"} ${a.title} — ${a.detail}`),
        ];
        return text(lines.join("\n"));
      },
    },

    /* ---------- cantila_optimise_cost ---------- */
    {
      name: "cantila_optimise_cost",
      description:
        "Scan the account for over-provisioned resources and idle services; return concrete right-sizing recommendations with estimated monthly savings (plan §5.6).",
      inputSchema: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description: "Account id (defaults to the configured owner account).",
          },
        },
      },
      handler: async (args) => {
        const accountId = String(args.accountId ?? ownerAccountId());
        const report = await cp.getCostOptimisation(accountId);
        if (report.recommendations.length === 0) {
          return text(
            "No cost-optimisation recommendations — looks well-sized.",
          );
        }
        const lines = [
          `${report.recommendations.length} recommendation(s) · est. savings $${(report.totalSavingsCentsPerMonth / 100).toFixed(2)} / month`,
          "",
          ...report.recommendations.map(
            (r, i) =>
              `${i + 1}. [${r.confidence}] ${r.title} (~$${(r.savingsCentsPerMonth / 100).toFixed(2)}/mo)\n   ${r.body}${
                r.actions && r.actions.length > 0
                  ? "\n   " +
                    r.actions
                      .map((a) => `→ ${a.label}: ${a.hint}`)
                      .join("\n   ")
                  : ""
              }`,
          ),
        ];
        return text(lines.join("\n"));
      },
    },

    /* ---------- cantila_troubleshoot ---------- */
    {
      name: "cantila_troubleshoot",
      description:
        "Diagnose a failing deployment — returns a plain-language explanation and concrete remediation steps (plan §5.6).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The Cantila project id.",
          },
          deploymentId: {
            type: "string",
            description: "The deployment to analyse.",
          },
        },
        required: ["projectId", "deploymentId"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        const deploymentId = String(args.deploymentId ?? "");
        if (!projectId || !deploymentId) {
          return errorText("projectId and deploymentId are required.");
        }
        const result = await cp.troubleshootDeploy(projectId, deploymentId);
        if ("error" in result) return errorText(result.error);
        const lines = [
          `Deploy ${deploymentId} — ${result.failed ? "FAILED" : "ok"} · last step ${result.lastStep ?? "(none)"}`,
          "",
          ...result.suggestions.map(
            (s, i) =>
              `${i + 1}. [${s.confidence}] ${s.title}\n   ${s.body}${
                s.actions && s.actions.length > 0
                  ? "\n   " +
                    s.actions
                      .map((a) => `→ ${a.label}: ${a.hint}`)
                      .join("\n   ")
                  : ""
              }`,
          ),
        ];
        return text(lines.join("\n"));
      },
    },

    /* ---------- cantila_connect_git ---------- */
    {
      name: "cantila_connect_git",
      description:
        "Connect a git repository to a Cantila project. Pushes to the configured branch auto-deploy via the webhook receiver.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "The Cantila project id." },
          repoUrl: {
            type: "string",
            description: "https URL of the repository, e.g. https://github.com/owner/name.",
          },
          branch: {
            type: "string",
            description: "Branch to auto-deploy. Defaults to main.",
          },
          autoDeploy: {
            type: "boolean",
            description: "Auto-deploy on push? Defaults to true.",
          },
        },
        required: ["projectId", "repoUrl"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        const repoUrl = String(args.repoUrl ?? "");
        if (!projectId || !repoUrl) {
          return errorText("projectId and repoUrl are required.");
        }
        const result = await cp.connectGit(projectId, {
          repoUrl,
          branch: typeof args.branch === "string" ? args.branch : undefined,
          autoDeploy:
            typeof args.autoDeploy === "boolean" ? args.autoDeploy : undefined,
        });
        if ("error" in result) return errorText(result.error);
        const p = result.project;
        return text(
          [
            `Connected ${p.repoUrl} to ${p.slug}`,
            `Branch: ${p.branch} · Auto-deploy: ${p.autoDeploy ? "on" : "off"}`,
            "",
            `Webhook URL: ${result.webhookUrl}`,
            `Webhook secret (shown once, store securely):`,
            `  ${result.webhookSecret}`,
            "",
            `Set header X-Hub-Signature-256: sha256=<HMAC-SHA256 of body, hex> on every push.`,
          ].join("\n"),
        );
      },
    },

    /* ---------- cantila_bootstrap_repo ---------- */
    {
      name: "cantila_bootstrap_repo",
      description:
        "Bootstrap-clone source code into a Cantila project's git: Cantila's git backend pulls the repo from a source URL (GitHub etc.) server-to-server with full history — no local git push needed. Detects the stack (Node, Python, Go, Docker, static, …) so backend apps deploy with the right build pack and port, and wires auto-deploy on push.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "The Cantila project id." },
          sourceUrl: {
            type: "string",
            description:
              "https URL of the SOURCE repository to clone from, e.g. https://github.com/owner/name.",
          },
          sourceToken: {
            type: "string",
            description:
              "Auth token for the source host if the repo is private. Used once for the clone, never stored.",
          },
          branch: {
            type: "string",
            description: "Branch to track. Defaults to the source's default branch.",
          },
        },
        required: ["projectId", "sourceUrl"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        const sourceUrl = String(args.sourceUrl ?? "");
        if (!projectId || !sourceUrl) {
          return errorText("projectId and sourceUrl are required.");
        }
        const result = await cp.bootstrapGit(projectId, {
          sourceUrl,
          sourceToken:
            typeof args.sourceToken === "string" ? args.sourceToken : undefined,
          branch: typeof args.branch === "string" ? args.branch : undefined,
        });
        if ("error" in result) return errorText(result.error);
        const p = result.project;
        return text(
          [
            `Bootstrapped ${sourceUrl} into ${p.repoUrl}`,
            `Stack: ${result.stack.label} · build pack ${result.stack.buildPack} · port ${result.stack.port}`,
            `Branch: ${p.branch} · Auto-deploy: ${p.autoDeploy ? "on" : "off"}`,
            "",
            `Webhook URL: ${result.webhookUrl}`,
            `Webhook secret (shown once, store securely):`,
            `  ${result.webhookSecret}`,
            "",
            `Run cantila_deploy to take it live.`,
          ].join("\n"),
        );
      },
    },

    /* ---------- cantila_rollback ---------- */
    {
      name: "cantila_rollback",
      description:
        "Roll a Cantila project back to a previous deployment. Reuses the prior image — no rebuild needed.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The Cantila project id.",
          },
          deploymentId: {
            type: "string",
            description: "The deployment to roll back to.",
          },
        },
        required: ["projectId", "deploymentId"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        const deploymentId = String(args.deploymentId ?? "");
        if (!projectId || !deploymentId) {
          return errorText("projectId and deploymentId are required.");
        }
        const result = await cp.rollback(projectId, deploymentId);
        if ("error" in result) return errorText(result.error);
        return text(
          [
            `Rolled back to ${deploymentId}`,
            `New deployment: ${result.id} (status ${result.status})`,
            result.url ? `URL: ${result.url}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    },

    /* ---------- cantila_deploy_preview ---------- */
    {
      name: "cantila_deploy_preview",
      description:
        "Spin up a branch preview environment at {slug}-{branch}.cantila.app. The preview is fully isolated from production — a failed preview does not crash the live URL.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "The Cantila project id." },
          branch: {
            type: "string",
            description:
              "The git branch to deploy as a preview. The preview URL is derived as {project-slug}-{branch-slug}.cantila.app.",
          },
          commitHash: { type: "string" },
          commitMessage: { type: "string" },
        },
        required: ["projectId", "branch"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        const branch = String(args.branch ?? "").trim();
        if (!projectId || !branch) {
          return errorText("projectId and branch are required.");
        }
        const result = await cp.deployPreview(projectId, branch, {
          trigger: "mcp",
          commit: {
            hash:
              typeof args.commitHash === "string" ? args.commitHash : undefined,
            message:
              typeof args.commitMessage === "string"
                ? args.commitMessage
                : undefined,
          },
        });
        if ("error" in result) return errorText(result.error);
        return text(
          [
            `Preview deployed for branch ${branch}`,
            `URL: ${result.url}`,
            `Deployment: ${result.deploymentId} (status ${result.status})`,
            "Production URL is untouched — both coexist.",
          ].join("\n"),
        );
      },
    },

    /* ---------- cantila_list_previews ---------- */
    {
      name: "cantila_list_previews",
      description:
        "List a project's live preview deployments. Each preview lives on its own subdomain — see the `url` field per entry.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "The Cantila project id." },
        },
        required: ["projectId"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        if (!projectId) return errorText("projectId is required.");
        const previews = await cp.listPreviews(projectId);
        if (previews.length === 0) {
          return text(`No live preview deployments on ${projectId}.`);
        }
        const lines = previews.map(
          (p) =>
            `- ${p.previewBranch ?? "?"} → ${p.url ?? "(no url)"}  [${p.id}]`,
        );
        return text(
          `${previews.length} live preview(s) on ${projectId}:\n${lines.join("\n")}`,
        );
      },
    },

    /* ---------- cantila_destroy_preview ---------- */
    {
      name: "cantila_destroy_preview",
      description:
        "Tear down a preview environment. Marks the deployment superseded so the URL stops serving; the row stays for audit.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "The Cantila project id." },
          deploymentId: {
            type: "string",
            description: "The preview deployment id to destroy.",
          },
        },
        required: ["projectId", "deploymentId"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        const deploymentId = String(args.deploymentId ?? "");
        if (!projectId || !deploymentId) {
          return errorText("projectId and deploymentId are required.");
        }
        const result = await cp.destroyPreview(projectId, deploymentId);
        if ("error" in result) return errorText(result.error);
        return text(
          `Destroyed preview ${result.id} (${result.previewBranch ?? "?"}) — status now ${result.status}`,
        );
      },
    },

    /* ---------- cantila_create_backup ---------- */
    {
      name: "cantila_create_backup",
      description:
        "Capture a point-in-time backup of a Cantila project — the current live deployment id + a snapshot of every env var. Restore later with `cantila_restore_backup`.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "The Cantila project id." },
          note: {
            type: "string",
            description:
              "Optional free-text note shown in the backup list (e.g. 'pre-migration checkpoint').",
          },
        },
        required: ["projectId"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        if (!projectId) return errorText("projectId is required.");
        const note = typeof args.note === "string" ? args.note : undefined;
        const result = await cp.createBackup(projectId, { note });
        if ("error" in result) return errorText(result.error);
        return text(
          [
            `Backup ${result.id} captured`,
            `Deployment: ${result.deploymentId} · Env vars: ${result.envVars.length}`,
            result.databaseSnapshotId
              ? `Database snapshot: ${result.databaseSnapshotId}`
              : "",
            result.note ? `Note: ${result.note}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    },

    /* ---------- cantila_list_backups ---------- */
    {
      name: "cantila_list_backups",
      description: "List a project's point-in-time backups, newest first.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "The Cantila project id." },
        },
        required: ["projectId"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        if (!projectId) return errorText("projectId is required.");
        const list = await cp.listBackups(projectId);
        if (list.length === 0) return text(`No backups for ${projectId}.`);
        const lines = list.map(
          (b) =>
            `- ${b.id} · ${b.createdAt} · deployment ${b.deploymentId} · ${b.envVars.length} env vars${b.note ? ` · ${b.note}` : ""}`,
        );
        return text(
          `${list.length} backup(s) for ${projectId}:\n${lines.join("\n")}`,
        );
      },
    },

    /* ---------- cantila_restore_backup ---------- */
    {
      name: "cantila_restore_backup",
      description:
        "Restore a Cantila project to a backup — re-applies the env vars captured at backup time AND rolls the deployment back to the captured one. Returns the new live deployment.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "The Cantila project id." },
          backupId: {
            type: "string",
            description: "The backup to restore from.",
          },
        },
        required: ["projectId", "backupId"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        const backupId = String(args.backupId ?? "");
        if (!projectId || !backupId) {
          return errorText("projectId and backupId are required.");
        }
        const result = await cp.restoreBackup(projectId, backupId);
        if ("error" in result) return errorText(result.error);
        return text(
          [
            `Restored ${projectId} from ${backupId}`,
            `New deployment: ${result.id} (status ${result.status})`,
            result.url ? `URL: ${result.url}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    },

    /* ---------- cantila_create_project ---------- */
    {
      name: "cantila_create_project",
      description:
        "Create a new Cantila project. Services (database, email, SMS) are auto-wired on the first deploy.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Project name." },
          runtime: {
            type: "string",
            enum: ["static", "node", "python", "php", "go", "ruby", "docker"],
            description: "Runtime — defaults to node.",
          },
          region: {
            type: "string",
            enum: ["fsn1", "hel1", "ash"],
            description: "Region — defaults to fsn1.",
          },
          accountId: {
            type: "string",
            description: "Owning account id. Defaults to the configured owner account.",
          },
        },
        required: ["name"],
      },
      handler: async (args) => {
        const name = String(args.name ?? "").trim();
        if (!name) return errorText("name is required.");
        const project = await cp.createProject({
          name,
          accountId: String(args.accountId ?? ownerAccountId()),
          runtime: asRuntime(args.runtime),
          region: asRegion(args.region),
        });
        return text(
          [
            `Created ${project.name} (${project.id})`,
            `Slug: ${project.slug} · Runtime: ${project.runtime} · Region: ${project.region}`,
            `Subdomain: https://${project.slug}.cantila.app (live after first deploy)`,
          ].join("\n"),
        );
      },
    },

    /* ---------- cantila_create_automation (plan §4.10) ---------- */
    {
      name: "cantila_create_automation",
      description:
        "Create a Cantila Automations instance (n8n or OpenClaw). Auto-wires it as a typed Project and returns the slug + region.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Display name." },
          kind: {
            type: "string",
            enum: ["n8n", "openclaw"],
            description: "Which engine to spin up.",
          },
          region: {
            type: "string",
            enum: ["fsn1", "hel1", "ash"],
            description: "Region — defaults to fsn1.",
          },
          accountId: {
            type: "string",
            description: "Owning account id. Defaults to the configured owner account.",
          },
        },
        required: ["name", "kind"],
      },
      handler: async (args) => {
        const name = String(args.name ?? "").trim();
        const kindRaw = String(args.kind ?? "").trim();
        if (!name) return errorText("name is required.");
        if (kindRaw !== "n8n" && kindRaw !== "openclaw") {
          return errorText("kind must be 'n8n' or 'openclaw'.");
        }
        const project = await cp.createAutomation({
          accountId: String(args.accountId ?? ownerAccountId()),
          name,
          kind: kindRaw,
          region: asRegion(args.region),
        });
        return text(
          [
            `Created ${kindRaw} automation ${project.name} (${project.id})`,
            `Slug: ${project.slug} · Region: ${project.region}`,
            `Open the canvas at: /automations/${project.id}`,
          ].join("\n"),
        );
      },
    },

    /* ---------- cantila_list_automations (plan §4.10) ---------- */
    {
      name: "cantila_list_automations",
      description:
        "List Cantila Automations instances in the account — n8n + OpenClaw, with their status.",
      inputSchema: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description: "Account id. Defaults to the configured owner account.",
          },
        },
      },
      handler: async (args) => {
        const accountId = String(args.accountId ?? ownerAccountId());
        const list = await cp.listAutomations(accountId);
        if (list.length === 0) {
          return text(`No automations in account ${accountId}.`);
        }
        return text(
          list
            .map(
              (a) =>
                `${a.automationKind} · ${a.name} (${a.id}) · ${a.status} · ${a.region}`,
            )
            .join("\n"),
        );
      },
    },

    /* ---------- cantila_list_connections (plan §4.11) ---------- */
    {
      name: "cantila_list_connections",
      description:
        "List Cantila Connections (account-wide credentials) — provider, auth kind, status.",
      inputSchema: {
        type: "object",
        properties: {
          accountId: {
            type: "string",
            description: "Account id. Defaults to the configured owner account.",
          },
        },
      },
      handler: async (args) => {
        const accountId = String(args.accountId ?? ownerAccountId());
        const list = await cp.listConnections(accountId);
        if (list.length === 0) {
          return text(`No connections in account ${accountId}.`);
        }
        return text(
          list
            .map(
              (c) =>
                `${c.provider} · ${c.name} (${c.id}) · ${c.authKind} · ${c.status}`,
            )
            .join("\n"),
        );
      },
    },

    /* ---------- cantila_create_connection (plan §4.11) ---------- */
    {
      name: "cantila_create_connection",
      description:
        "Create an API-key or basic-auth Cantila Connection. For OAuth providers, point the user at /connections/new in the Console instead — the consent step requires a browser redirect.",
      inputSchema: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "Provider id (e.g. openai, stripe, sendgrid).",
          },
          name: { type: "string", description: "Display label for the connection." },
          fields: {
            type: "object",
            description:
              "Provider-specific field values keyed by the manifest's `field.key` — e.g. {api_key: 'sk-...'}.",
          },
          accountId: {
            type: "string",
            description: "Account id. Defaults to the configured owner account.",
          },
        },
        required: ["provider", "name", "fields"],
      },
      handler: async (args) => {
        const provider = String(args.provider ?? "").trim();
        const name = String(args.name ?? "").trim();
        if (!provider || !name) {
          return errorText("provider and name are required.");
        }
        const fieldsArg = args.fields;
        if (!fieldsArg || typeof fieldsArg !== "object") {
          return errorText("fields must be an object.");
        }
        // Use the shared secret-mint + connection-create CP method.
        // For Phase E MCP we don't reach into the secrets manager
        // directly — we pass `secretRef = secret(...)` and rely on the
        // HTTP route's in-memory secret store / future secrets manager
        // to resolve it at run time.
        const conn = await cp.createApiKeyConnection({
          accountId: String(args.accountId ?? ownerAccountId()),
          provider,
          name,
          authKind: "api_key",
          secretRef: `sec_mcp_${Date.now().toString(36)}`,
          metadata: {
            // Non-secret fields land in metadata so the canvas can read
            // them. Secret fields are out of scope for the MCP tool —
            // the route does the field-by-field secret/metadata split
            // because it knows the provider's manifest; MCP callers
            // shouldn't bypass that for OAuth or compound credentials.
            fields: Object.fromEntries(
              Object.entries(fieldsArg as Record<string, unknown>).filter(
                ([k]) => !/^(api_key|password|signing_secret|auth_token)$/i.test(k),
              ),
            ),
          },
        });
        return text(
          [
            `Created connection ${conn.name} (${conn.id})`,
            `Provider: ${conn.provider} · Auth: ${conn.authKind} · Status: ${conn.status}`,
            `Workflow nodes reference it by id: ${conn.id}`,
          ].join("\n"),
        );
      },
    },

    /* ---------- cantila_push_files ---------- */
    {
      name: "cantila_push_files",
      description:
        "Commit a set of files into a project's own Cantila git repo (auto-created if the project has none) and deploy. Lets an agent ship an app with no public repo and no GitHub credentials — files land in the project's git.cantila.app repo and go live.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "The Cantila project id.",
          },
          files: {
            type: "array",
            description:
              "Files to commit. Each entry: { path, content, encoding?, message? }.",
            items: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "Repo-relative path, e.g. src/app/page.tsx.",
                },
                content: { type: "string", description: "File contents." },
                encoding: {
                  type: "string",
                  enum: ["utf-8", "base64"],
                  description:
                    "Content encoding. Use base64 for binary assets. Defaults to utf-8.",
                },
                message: {
                  type: "string",
                  description: "Optional per-file commit message.",
                },
              },
              required: ["path", "content"],
            },
          },
          message: {
            type: "string",
            description:
              "Default commit message for files that don't carry their own.",
          },
          deploy: {
            type: "boolean",
            description: "Deploy after committing. Defaults to true.",
          },
        },
        required: ["projectId", "files"],
      },
      handler: async (args) => {
        const projectId = String(args.projectId ?? "");
        if (!projectId) return errorText("projectId is required.");
        const rawFiles = Array.isArray(args.files) ? args.files : [];
        if (rawFiles.length === 0) {
          return errorText("files must be a non-empty array.");
        }

        // Validate + normalise every entry before any side effect.
        const files: { path: string; content: string; message?: string }[] = [];
        for (const f of rawFiles) {
          if (!f || typeof f !== "object") {
            return errorText("each file must be an object.");
          }
          const rec = f as Record<string, unknown>;
          const path = String(rec.path ?? "").trim();
          if (!path) return errorText("each file needs a non-empty path.");
          if (typeof rec.content !== "string") {
            return errorText(`file ${path}: content must be a string.`);
          }
          let content = rec.content;
          if (rec.encoding === "base64") {
            try {
              content = Buffer.from(rec.content, "base64").toString("utf-8");
            } catch {
              return errorText(`file ${path}: invalid base64 content.`);
            }
          }
          files.push({
            path,
            content,
            message:
              typeof rec.message === "string" ? rec.message : undefined,
          });
        }

        // Ensure the project has a Cantila git repo.
        const ensured = await cp.ensureProjectRepo(projectId);
        if (!ensured) return errorText("project not found.");
        if (!ensured.repoUrl) {
          return errorText(
            "Cantila git backend not configured (GITEA_URL unset) — cannot host files for this project.",
          );
        }

        // Look up existing blob shas so re-pushed paths update instead of failing.
        const listing = await cp.listProjectFiles(projectId);
        const shaByPath = new Map<string, string>();
        if (listing && "files" in listing) {
          for (const node of listing.files) {
            if (node.sha) shaByPath.set(node.path, node.sha);
          }
        }

        const defaultMessage =
          typeof args.message === "string" && args.message.trim()
            ? args.message.trim()
            : "Push files via Cantila MCP";

        let committed = 0;
        let lastCommitSha = "";
        for (const file of files) {
          const result = await cp.writeProjectFile(projectId, {
            path: file.path,
            content: file.content,
            sha: shaByPath.get(file.path),
            message: file.message ?? defaultMessage,
          });
          if (!result || "error" in result) {
            const reason =
              result && "error" in result ? result.error : "unknown";
            return errorText(
              `Committed ${committed}/${files.length} file(s); failed on ${file.path}: ${reason}.`,
            );
          }
          committed += 1;
          lastCommitSha = result.commitSha;
        }

        const lines = [
          `Committed ${committed} file(s) to ${ensured.repoUrl} (${ensured.branch ?? "main"})`,
          `Last commit: ${lastCommitSha}`,
        ];

        if (args.deploy === false) {
          lines.push(
            "Skipped deploy (deploy:false) — run cantila_deploy when ready.",
          );
          return text(lines.join("\n"));
        }

        try {
          const outcome = await cp.deploy(projectId, {
            trigger: "mcp",
            source: { kind: "chat" },
          });
          lines.push(
            `Deploy ${outcome.status} — ${outcome.url}`,
            `Deployment: ${outcome.deploymentId}`,
            `Steps: ${outcome.steps.join(" -> ")}`,
          );
        } catch (err) {
          lines.push(
            `Files committed, but deploy failed: ${
              err instanceof Error ? err.message : "deploy failed"
            }. Retry with cantila_deploy.`,
          );
          return errorText(lines.join("\n"));
        }
        return text(lines.join("\n"));
      },
    },
  ];

  /* ---------- mobile builds + store publishing (spec 2026-06-11) ---------- */
  if (extras.mobile) {
    const mobile = extras.mobile;
    const handleMobileError = (err: unknown): ToolResult => {
      if (err instanceof MobileError) return errorText(err.message);
      throw err;
    };

    defs.push(
      {
        name: "cantila_build_mobile",
        description:
          "Build the project's mobile app into a store-ready artifact. Android (.aab/.apk) is available today; iOS is coming soon. Detects the mobile stack (Expo, React Native, Flutter, Capacitor, native Android) automatically. Returns the queued build — poll cantila_list_mobile_builds for completion.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: {
              type: "string",
              description: "The Cantila project id to build.",
            },
            platform: {
              type: "string",
              enum: ["android", "ios"],
              description: 'Target platform. Use "android" (iOS is coming soon).',
            },
            artifactKind: {
              type: "string",
              enum: ["aab", "apk"],
              description:
                'Artifact type — "aab" (Play Store, default) or "apk" (direct install).',
            },
            versionName: {
              type: "string",
              description: 'Human version label, e.g. "1.2.0". Defaults to 1.0.<versionCode>.',
            },
          },
          required: ["projectId", "platform"],
        },
        handler: async (args) => {
          try {
            const build = await mobile.buildMobileApp(String(args.projectId), {
              platform: args.platform === "ios" ? "ios" : "android",
              artifactKind:
                args.artifactKind === "apk" ? "apk" : args.artifactKind === "aab" ? "aab" : undefined,
              versionName:
                typeof args.versionName === "string" ? args.versionName : undefined,
            });
            return text(
              `Mobile build queued: ${build.id}\nStack: ${build.mobileStack} · ${build.artifactKind} · versionCode ${build.versionCode} (${build.versionName})\nApplication id: ${build.applicationId}\nPoll cantila_list_mobile_builds to follow it; publish with cantila_publish_mobile once it succeeds.`,
            );
          } catch (err) {
            return handleMobileError(err);
          }
        },
      },
      {
        name: "cantila_list_mobile_builds",
        description:
          "List a project's mobile builds (newest first) with status, version and artifact info, plus its store releases.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: {
              type: "string",
              description: "The Cantila project id.",
            },
          },
          required: ["projectId"],
        },
        handler: async (args) => {
          const projectId = String(args.projectId);
          const builds = await mobile.listBuilds(projectId);
          const releases = await mobile.listReleases(projectId);
          if (builds.length === 0) {
            return text(
              "No mobile builds yet. Run cantila_build_mobile to create one.",
            );
          }
          const buildLines = builds.map(
            (b) =>
              `${b.id} — ${b.status} · ${b.platform}/${b.mobileStack} · v${b.versionName} (code ${b.versionCode}) · ${b.artifactKind}${b.artifactSize ? ` · ${b.artifactSize} bytes` : ""}${b.error ? ` · error: ${b.error.slice(0, 200)}` : ""}`,
          );
          const releaseLines = releases.map(
            (r) =>
              `${r.id} — ${r.status} · ${r.store} · track ${r.track} · build ${r.buildId}${r.error ? ` · error: ${r.error.slice(0, 200)}` : ""}`,
          );
          return text(
            `${builds.length} build(s):\n${buildLines.join("\n")}${releases.length ? `\n\n${releases.length} release(s):\n${releaseLines.join("\n")}` : ""}`,
          );
        },
      },
      {
        name: "cantila_publish_mobile",
        description:
          "Publish a succeeded mobile build to an app store under Cantila's developer account. Google Play is available today (tracks: internal, alpha, beta, production); the App Store is coming soon.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: {
              type: "string",
              description: "The Cantila project id.",
            },
            buildId: {
              type: "string",
              description: "A succeeded build id from cantila_list_mobile_builds.",
            },
            store: {
              type: "string",
              enum: ["google_play", "app_store"],
              description: 'Target store. Use "google_play" (App Store is coming soon).',
            },
            track: {
              type: "string",
              enum: ["internal", "alpha", "beta", "production"],
              description: "Play release track. Defaults to internal.",
            },
          },
          required: ["projectId", "buildId", "store"],
        },
        handler: async (args) => {
          try {
            const release = await mobile.publishRelease(String(args.projectId), {
              buildId: String(args.buildId),
              store: args.store === "app_store" ? "app_store" : "google_play",
              track: typeof args.track === "string" ? args.track : undefined,
            });
            const note =
              release.status === "stubbed"
                ? "\nNote: the Google Play publisher is offline on this environment — the release was recorded; set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON to publish for real."
                : "";
            return text(
              `Release ${release.id}: ${release.status} — ${release.store} (${release.track} track)${release.externalRef ? `\nProvider ref: ${release.externalRef}` : ""}${release.error ? `\nError: ${release.error}` : ""}${note}`,
            );
          } catch (err) {
            return handleMobileError(err);
          }
        },
      },
    );
  }

  return defs.map((def) => withTenantGuard(cp, def));
}
