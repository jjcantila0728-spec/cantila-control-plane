/* ============================================================
   Coolify-backed workspace provisioner (plan §4.10, Phase D).

   Each automation instance (n8n or OpenClaw) gets its own
   dedicated container provisioned on Coolify when the automation
   is created. The container is a plain Docker image application —
   same Coolify primitive as tenant app slots, just a different
   image and port.

   For n8n: docker.n8n.io/n8nio/n8n:latest on port 5678.
   For OpenClaw: OPENCLAW_DOCKER_IMAGE (env-configurable) on port 8080.

   Frame-options are cleared on both so the Console can embed the
   native UI in an iframe. The generated admin password and API key
   are stored in `automationConfig` by the routes layer so per-
   instance adapters can use them without a round-trip to Coolify.
   ============================================================ */

import { randomBytes } from "node:crypto";
import type { Project, AutomationKind } from "../domain/types";
import type { WorkspaceProvisioner } from "../deploy/provisioning";
import { stubWorkspaceProvisioner } from "./stub";

export interface CoolifyWorkspaceProvisionerOptions {
  apiUrl: string;
  apiToken: string;
  serverUuid: string;
  projectUuid: string;
  environmentName?: string;
  apexDomain?: string;
  /** Docker image for OpenClaw (full `image:tag` string).
   *  Defaults to OPENCLAW_DOCKER_IMAGE env var or
   *  'ghcr.io/cantila/openclaw:latest'. */
  openClawImage?: string;
}

interface CoolifyBinding {
  apiUrl: string;
  apiToken: string;
  serverUuid: string;
  projectUuid: string;
}

export class CoolifyWorkspaceProvisioner implements WorkspaceProvisioner {
  private readonly binding: CoolifyBinding;
  private readonly environmentName: string;
  private readonly apexDomain: string;
  private readonly openClawImage: string;

  constructor(opts: CoolifyWorkspaceProvisionerOptions) {
    this.binding = {
      apiUrl: opts.apiUrl.replace(/\/+$/, ""),
      apiToken: opts.apiToken,
      serverUuid: opts.serverUuid,
      projectUuid: opts.projectUuid,
    };
    this.environmentName = opts.environmentName ?? "production";
    this.apexDomain = opts.apexDomain ?? "cantila.app";
    this.openClawImage =
      opts.openClawImage ??
      process.env.OPENCLAW_DOCKER_IMAGE ??
      "ghcr.io/cantila/openclaw:latest";
  }

  async createWorkspace(
    project: Project,
    kind: AutomationKind,
  ): Promise<{ workspaceUrl: string; adminUser: string; adminPassword: string }> {
    const adminUser = "admin";
    const adminPassword = randomBytes(24).toString("base64url");
    const apiKey = randomBytes(32).toString("hex");

    const fqdn = `https://${kind}-${project.slug}.${this.apexDomain}`;
    const appName = `cantila-${project.id}-${kind}`;

    const cfg =
      kind === "n8n"
        ? this.n8nConfig(fqdn, adminPassword, apiKey)
        : this.openClawConfig(adminPassword, apiKey);

    // 1. Create the Coolify Docker-image application (no instant deploy yet —
    //    we inject env vars first so the first boot picks them up).
    const created = await this.request<{ uuid: string }>(
      "POST",
      "/applications/dockerimage",
      {
        project_uuid: this.binding.projectUuid,
        server_uuid: this.binding.serverUuid,
        environment_name: this.environmentName,
        name: appName,
        docker_registry_image_name: cfg.image,
        docker_registry_image_tag: cfg.tag,
        ports_exposes: String(cfg.port),
        domains: fqdn,
        instant_deploy: false,
      },
    );

    // 2. Inject env vars (admin credentials + frame-allow settings).
    const data = Object.entries(cfg.envVars).map(([key, value]) => ({
      key,
      value,
      is_preview: false,
      is_build_time: false,
      is_literal: true,
    }));
    await this.request(
      "PATCH",
      `/applications/${encodeURIComponent(created.uuid)}/envs/bulk`,
      { data },
    );

    // 3. Start — Coolify pulls the image and brings up the container.
    await this.request(
      "POST",
      `/applications/${encodeURIComponent(created.uuid)}/start`,
      {},
    );

    return { workspaceUrl: fqdn, adminUser, adminPassword };
  }

  async destroyWorkspace(workspaceUrl: string): Promise<void> {
    // Best-effort: find the Coolify app by its FQDN and delete it.
    // If the lookup fails (e.g., already deleted), swallow the error.
    try {
      const list = await this.request<{ uuid: string; fqdn?: string }[]>(
        "GET",
        "/applications",
        undefined,
      );
      const found = list.find((a) => a.fqdn?.includes(new URL(workspaceUrl).hostname));
      if (found) {
        await this.request(
          "DELETE",
          `/applications/${encodeURIComponent(found.uuid)}?cleanup=true`,
          undefined,
        );
      }
    } catch {
      /* best-effort */
    }
  }

  private n8nConfig(
    webhookUrl: string,
    adminPassword: string,
    apiKey: string,
  ): { image: string; tag: string; port: number; envVars: Record<string, string> } {
    return {
      image: "docker.n8n.io/n8nio/n8n",
      tag: "latest",
      port: 5678,
      envVars: {
        // Allow the Cantila console to embed n8n in an iframe.
        N8N_SECURITY_HEADER_X_FRAME_OPTIONS: "",
        N8N_SECURE_COOKIE: "false",
        WEBHOOK_URL: webhookUrl,
        N8N_LOG_LEVEL: "info",
        N8N_HIDE_USAGE_PAGE: "true",
        N8N_ENCRYPTION_KEY: randomBytes(24).toString("hex"),
        // REST API key — used by the per-instance N8nEngineAdapter.
        N8N_API_KEY: apiKey,
        // Surfaced in the console "credentials" panel.
        CANTILA_ADMIN_USER: "admin",
        CANTILA_ADMIN_PASSWORD: adminPassword,
        CANTILA_API_KEY: apiKey,
      },
    };
  }

  private openClawConfig(
    adminPassword: string,
    apiKey: string,
  ): { image: string; tag: string; port: number; envVars: Record<string, string> } {
    const [image = "ghcr.io/cantila/openclaw", tag = "latest"] =
      this.openClawImage.split(":") as [string, string];
    return {
      image,
      tag,
      port: 8080,
      envVars: {
        OPENCLAW_ADMIN_USER: "admin",
        OPENCLAW_ADMIN_PASSWORD: adminPassword,
        OPENCLAW_API_KEY: apiKey,
        // Allow iframe embedding from the Cantila console.
        OPENCLAW_ALLOW_IFRAME: "true",
        CANTILA_ADMIN_USER: "admin",
        CANTILA_ADMIN_PASSWORD: adminPassword,
        CANTILA_API_KEY: apiKey,
      },
    };
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.binding.apiUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.binding.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Coolify workspace ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`,
      );
    }
    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }
}

/** Auto-select the workspace provisioner the same way selectProvisioner
 *  picks the DB provisioner: real Coolify when the four env vars are
 *  present, otherwise the stub. */
export function selectWorkspaceProvisioner(
  env: NodeJS.ProcessEnv = process.env,
): { provisioner: WorkspaceProvisioner; live: boolean } {
  const apiUrl = env.COOLIFY_API_URL?.trim();
  const apiToken = env.COOLIFY_API_TOKEN?.trim();
  const serverUuid = env.COOLIFY_SERVER_UUID?.trim();
  const projectUuid = env.COOLIFY_PROJECT_UUID?.trim();

  if (apiUrl && apiToken && serverUuid && projectUuid) {
    return {
      provisioner: new CoolifyWorkspaceProvisioner({
        apiUrl,
        apiToken,
        serverUuid,
        projectUuid,
        environmentName: env.COOLIFY_ENVIRONMENT_NAME?.trim() || undefined,
        apexDomain: env.CANTILA_APEX_DOMAIN?.trim() || undefined,
        openClawImage: env.OPENCLAW_DOCKER_IMAGE?.trim() || undefined,
      }),
      live: true,
    };
  }
  return { provisioner: stubWorkspaceProvisioner, live: false };
}
