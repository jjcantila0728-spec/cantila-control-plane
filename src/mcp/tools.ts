/* ============================================================
   The Cantila MCP tool set — plan §4.3.2.
   Each tool is a thin wrapper over the shared ControlPlane service,
   so the HTTP API and the MCP server share one core implementation.
   ============================================================ */

import type { ControlPlane } from "../core/control-plane";
import { ownerAccountId } from "../lib/owner-account";
import type { ToolDefinition, ToolResult } from "./server";
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

export function cantilaTools(cp: ControlPlane): ToolDefinition[] {
  return [
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
            `Auto-wired this run — database: ${p.databaseCreated}, email: ${p.mailboxCreated}`,
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
  ];
}
