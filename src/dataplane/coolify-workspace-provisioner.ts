/* ============================================================
   Coolify-backed workspace provisioner (plan §4.10, Phase D).

   Each automation instance (n8n or OpenClaw) gets its own
   dedicated container provisioned on Coolify when the automation
   is created.

   For n8n: the upstream image, PINNED to the version whose REST
   surface the `N8nEngineAdapter` was verified against. The adapter
   signs in with the generated owner credentials (cookie session,
   lazy `POST /rest/owner/setup` on first contact), so the env here
   only has to make the editor reachable + embeddable.

   For OpenClaw: there is no upstream image — the engine is Cantila's
   own `cantila-openclaw` service, built by Coolify straight from its
   public Git repo (dockerfile build pack). This avoids needing a
   container registry entirely. `OPENCLAW_API_KEY` injected into the
   container is the SAME key returned to the caller, so the
   per-instance adapter authenticates first try.

   Frame embedding: the Console renders each workspace in an iframe,
   so n8n gets SameSite=None cookies (behind Traefik TLS) and the
   OpenClaw engine never sends X-Frame-Options.
   ============================================================ */

import { randomBytes } from "node:crypto";
import type { Project, AutomationKind } from "../domain/types";
import type { WorkspaceProvisioner } from "../deploy/provisioning";
import { stubWorkspaceProvisioner } from "./stub";

/** n8n version the adapter's REST calls were verified against
 *  (owner setup, cookie login, workflows CRUD, manual run,
 *  executions, credentials). Bump only after re-verifying. */
const N8N_PINNED_IMAGE = "docker.n8n.io/n8nio/n8n:2.25.7";

/** Public repo Coolify builds per-instance OpenClaw engines from. */
const OPENCLAW_DEFAULT_REPO =
  "https://github.com/jjcantila0728-spec/cantila-openclaw";
const OPENCLAW_DEFAULT_BRANCH = "main";

export interface CoolifyWorkspaceProvisionerOptions {
  apiUrl: string;
  apiToken: string;
  serverUuid: string;
  projectUuid: string;
  environmentName?: string;
  apexDomain?: string;
  /** Override the pinned n8n image (full `image:tag`). */
  n8nImage?: string;
  /** Override the OpenClaw engine Git repo / branch. */
  openClawRepo?: string;
  openClawBranch?: string;
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
  private readonly n8nImage: string;
  private readonly openClawRepo: string;
  private readonly openClawBranch: string;

  constructor(opts: CoolifyWorkspaceProvisionerOptions) {
    this.binding = {
      apiUrl: opts.apiUrl.replace(/\/+$/, ""),
      apiToken: opts.apiToken,
      serverUuid: opts.serverUuid,
      projectUuid: opts.projectUuid,
    };
    this.environmentName = opts.environmentName ?? "production";
    this.apexDomain = opts.apexDomain ?? "cantila.app";
    this.n8nImage =
      opts.n8nImage ?? process.env.N8N_DOCKER_IMAGE ?? N8N_PINNED_IMAGE;
    this.openClawRepo =
      opts.openClawRepo ?? process.env.OPENCLAW_GIT_REPO ?? OPENCLAW_DEFAULT_REPO;
    this.openClawBranch =
      opts.openClawBranch ??
      process.env.OPENCLAW_GIT_BRANCH ??
      OPENCLAW_DEFAULT_BRANCH;
  }

  async createWorkspace(
    project: Project,
    kind: AutomationKind,
  ): Promise<{
    workspaceUrl: string;
    adminUser: string;
    adminEmail: string;
    adminPassword: string;
    apiKey: string;
  }> {
    const adminUser = "admin";
    const adminEmail = "admin@cantila.app";
    // n8n's password policy wants length + a capital + a digit; the
    // fixed prefix guarantees policy compliance regardless of what the
    // random suffix contains.
    const adminPassword = `Cw9${randomBytes(18).toString("base64url")}`;
    const apiKey = randomBytes(32).toString("hex");

    const fqdn = `https://${kind}-${project.slug}.${this.apexDomain}`;
    const appName = `cantila-${project.id}-${kind}`;

    const created =
      kind === "n8n"
        ? await this.createN8nApp(appName, fqdn)
        : await this.createOpenClawApp(appName, fqdn);

    // Inject env vars (admin credentials + embed/auth settings) before
    // the first start so the first boot picks them up.
    const envVars =
      kind === "n8n"
        ? this.n8nEnv(fqdn, adminPassword, apiKey)
        : this.openClawEnv(adminPassword, apiKey);
    const data = Object.entries(envVars).map(([key, value]) => ({
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

    // Start — Coolify pulls the image (n8n) or clones + builds the
    // Dockerfile (OpenClaw) and brings up the container.
    await this.request(
      "POST",
      `/applications/${encodeURIComponent(created.uuid)}/start`,
      {},
    );

    return { workspaceUrl: fqdn, adminUser, adminEmail, adminPassword, apiKey };
  }

  /** n8n — plain Docker-image application from the pinned upstream image. */
  private async createN8nApp(
    appName: string,
    fqdn: string,
  ): Promise<{ uuid: string }> {
    const [image, tag = "latest"] = splitImageRef(this.n8nImage);
    return this.request<{ uuid: string }>("POST", "/applications/dockerimage", {
      project_uuid: this.binding.projectUuid,
      server_uuid: this.binding.serverUuid,
      environment_name: this.environmentName,
      name: appName,
      docker_registry_image_name: image,
      docker_registry_image_tag: tag,
      ports_exposes: "5678",
      domains: fqdn,
      instant_deploy: false,
    });
  }

  /** OpenClaw — public-repo application built from its Dockerfile.
   *  No registry involved: Coolify clones the repo on the server and
   *  builds the image locally per instance. */
  private async createOpenClawApp(
    appName: string,
    fqdn: string,
  ): Promise<{ uuid: string }> {
    return this.request<{ uuid: string }>("POST", "/applications/public", {
      project_uuid: this.binding.projectUuid,
      server_uuid: this.binding.serverUuid,
      environment_name: this.environmentName,
      name: appName,
      git_repository: this.openClawRepo,
      git_branch: this.openClawBranch,
      build_pack: "dockerfile",
      ports_exposes: "8080",
      domains: fqdn,
      instant_deploy: false,
    });
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

  private n8nEnv(
    fqdn: string,
    adminPassword: string,
    apiKey: string,
  ): Record<string, string> {
    const host = new URL(fqdn).hostname;
    return {
      N8N_HOST: host,
      N8N_EDITOR_BASE_URL: fqdn,
      WEBHOOK_URL: fqdn,
      // Traefik terminates TLS one hop in front of the container; this
      // makes express trust X-Forwarded-Proto so secure cookies work.
      N8N_PROXY_HOPS: "1",
      // The Console embeds the editor in an iframe (cross-origin), so
      // the auth cookie must be SameSite=None — which requires Secure.
      N8N_SECURE_COOKIE: "true",
      N8N_SAMESITE_COOKIE: "none",
      N8N_ENCRYPTION_KEY: randomBytes(24).toString("hex"),
      N8N_LOG_LEVEL: "info",
      N8N_HIDE_USAGE_PAGE: "true",
      N8N_DIAGNOSTICS_ENABLED: "false",
      N8N_PERSONALIZATION_ENABLED: "false",
      N8N_RUNNERS_ENABLED: "true",
      // Surfaced in the console "credentials" panel; n8n itself signs
      // in with the owner account the adapter creates via
      // `POST /rest/owner/setup` using these values.
      CANTILA_ADMIN_USER: "admin",
      CANTILA_ADMIN_EMAIL: "admin@cantila.app",
      CANTILA_ADMIN_PASSWORD: adminPassword,
      CANTILA_API_KEY: apiKey,
    };
  }

  private openClawEnv(
    adminPassword: string,
    apiKey: string,
  ): Record<string, string> {
    return {
      OPENCLAW_ADMIN_USER: "admin",
      OPENCLAW_ADMIN_PASSWORD: adminPassword,
      // The adapter authenticates with this exact key (Bearer).
      OPENCLAW_API_KEY: apiKey,
      // Allow iframe embedding from the Cantila console.
      OPENCLAW_ALLOW_IFRAME: "true",
      CANTILA_ADMIN_USER: "admin",
      CANTILA_ADMIN_PASSWORD: adminPassword,
      CANTILA_API_KEY: apiKey,
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

function splitImageRef(ref: string): [string, string | undefined] {
  // Split on the LAST colon only when it's a tag (no slash after it) —
  // registries may carry a port (`host:5000/img:tag`).
  const idx = ref.lastIndexOf(":");
  if (idx === -1 || ref.slice(idx + 1).includes("/")) return [ref, undefined];
  return [ref.slice(0, idx), ref.slice(idx + 1)];
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
        n8nImage: env.N8N_DOCKER_IMAGE?.trim() || undefined,
        openClawRepo: env.OPENCLAW_GIT_REPO?.trim() || undefined,
        openClawBranch: env.OPENCLAW_GIT_BRANCH?.trim() || undefined,
      }),
      live: true,
    };
  }
  return { provisioner: stubWorkspaceProvisioner, live: false };
}
