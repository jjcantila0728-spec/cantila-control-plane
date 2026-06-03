/* ============================================================
   Coolify-backed service provisioner (plan §4.2).

   Replaces `stubProvisioner` when COOLIFY_API_URL + COOLIFY_API_TOKEN
   + the single-region server/project pair are set. `createDatabase`
   stands up a REAL standalone Postgres on the same Coolify server +
   project the tenant app deploys onto, so the two share Coolify's
   `coolify` Docker network and the app can reach the DB by its
   container hostname.

   Coolify's `POST /databases/postgresql` returns an `internal_db_url`
   at create time — `postgres://postgres:<pw>@<db-uuid>:5432/postgres`
   — whose host is the DB container's network alias. That is exactly
   the value the app needs as `DATABASE_URL`; no external port, no
   public exposure.

   Mailbox provisioning stays delegated to the stub for now — Cantila
   Mail is wired separately (dedicated Mailcow box) and is not part of
   this Coolify path.
   ============================================================ */

import type { Project, DbEngine, Region } from "../domain/types";
import type { ServiceProvisioner } from "../deploy/provisioning";
import { stubProvisioner } from "./stub";
import { createLiveMailboxServiceProvisioner } from "../mail/mailbox-service-provisioner";

/** Per-region Coolify binding for database provisioning — the DB must
 *  land on the SAME server + project as the tenant app so they share a
 *  network. Mirrors the data plane's region map; today Cantila runs a
 *  single region so the default pair covers every project. */
export interface CoolifyProvisionerRegion {
  serverUuid: string;
  projectUuid: string;
  apiUrl?: string;
  apiToken?: string;
}

export interface CoolifyProvisionerOptions {
  apiUrl: string;
  apiToken: string;
  /** Default server UUID (single-region back-compat). */
  serverUuid: string;
  /** Default project UUID (single-region back-compat). */
  projectUuid: string;
  /** Coolify environment name within the project, default `production`. */
  environmentName?: string;
  /** Optional per-region overrides. When a project's region has an
   *  entry, the DB is created against that server/project instead of
   *  the default pair. */
  regions?: Partial<Record<Region, CoolifyProvisionerRegion>>;
  /** Provisioner that handles mailbox creation — defaults to the stub
   *  (Cantila Mail is a separate backend). */
  mailbox?: ServiceProvisioner;
}

interface ResolvedBinding {
  apiUrl: string;
  apiToken: string;
  serverUuid: string;
  projectUuid: string;
}

interface CoolifyDbCreateResponse {
  uuid: string;
  internal_db_url?: string;
}

export class CoolifyServiceProvisioner implements ServiceProvisioner {
  private readonly defaultApiUrl: string;
  private readonly defaultApiToken: string;
  private readonly environmentName: string;
  private readonly serverUuid: string;
  private readonly projectUuid: string;
  private readonly regions?: Partial<Record<Region, CoolifyProvisionerRegion>>;
  private readonly mailbox: ServiceProvisioner;

  constructor(opts: CoolifyProvisionerOptions) {
    this.defaultApiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.defaultApiToken = opts.apiToken;
    this.environmentName = opts.environmentName ?? "production";
    this.serverUuid = opts.serverUuid;
    this.projectUuid = opts.projectUuid;
    this.regions = opts.regions;
    this.mailbox = opts.mailbox ?? stubProvisioner;
  }

  private bindingFor(project: Project): ResolvedBinding {
    const region = this.regions?.[project.region];
    return {
      apiUrl: (region?.apiUrl ?? this.defaultApiUrl).replace(/\/+$/, ""),
      apiToken: region?.apiToken ?? this.defaultApiToken,
      serverUuid: region?.serverUuid ?? this.serverUuid,
      projectUuid: region?.projectUuid ?? this.projectUuid,
    };
  }

  async createDatabase(project: Project): Promise<{
    engine: DbEngine;
    version: string;
    connectionUri: string;
  }> {
    const binding = this.bindingFor(project);
    // Coolify resource names must be DNS-ish; the project id is already
    // `prj_<hex>` so this is safe. Suffix keeps it distinct from the app
    // (`cantila-<id>`) in the Coolify dashboard.
    const name = `cantila-${project.id}-db`;
    const res = await this.request<CoolifyDbCreateResponse>(
      "POST",
      "/databases/postgresql",
      {
        server_uuid: binding.serverUuid,
        project_uuid: binding.projectUuid,
        environment_name: this.environmentName,
        name,
        // Start the container now so the DB is accepting connections by
        // the time the app's first deploy boots against it.
        instant_deploy: true,
      },
      binding,
    );
    if (!res.internal_db_url) {
      throw new Error(
        `Coolify created database ${res.uuid} but returned no internal_db_url`,
      );
    }
    return {
      engine: "postgres",
      version: "16",
      // The in-network URL — host is the DB container's alias on the
      // shared `coolify` network, reachable by the tenant app.
      connectionUri: res.internal_db_url,
    };
  }

  async createMailbox(project: Project): ReturnType<
    ServiceProvisioner["createMailbox"]
  > {
    return this.mailbox.createMailbox(project);
  }

  async destroyDatabase(connectionUri: string): Promise<void> {
    const uuid = coolifyDbUuidFromUri(connectionUri);
    // Stub / unknown URIs (e.g. the dotted `db-x.int.cantila.cloud` host)
    // have no Coolify resource behind them — nothing to delete.
    if (!uuid) return;
    await this.request(
      "DELETE",
      `/databases/${encodeURIComponent(uuid)}?cleanup=true`,
      undefined,
      {
        apiUrl: this.defaultApiUrl,
        apiToken: this.defaultApiToken,
        serverUuid: this.serverUuid,
        projectUuid: this.projectUuid,
      },
    );
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    binding: ResolvedBinding,
  ): Promise<T> {
    const url = `${binding.apiUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${binding.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Coolify ${method} ${path} → ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      );
    }
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }
}

/** Extract the Coolify database uuid from a connection URI. Coolify's
 *  `internal_db_url` uses the DB container's uuid as the host
 *  (`postgres://postgres:pw@<uuid>:5432/postgres`), so the uuid is just
 *  the hostname. Returns null for stub URIs (dotted `*.int.cantila.cloud`
 *  hosts) and anything unparseable — the caller then skips Coolify
 *  teardown. */
export function coolifyDbUuidFromUri(uri: string): string | null {
  try {
    const host = new URL(uri).hostname;
    return /^[a-z0-9]{16,}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/**
 * Select the service provisioner the same way `selectDataPlane` picks a
 * data plane: a real Coolify provisioner when the API creds + the
 * single-region server/project pair are present, else the stub. Mailbox
 * creation always delegates to the stub for now (Cantila Mail is a
 * separate backend), so only `createDatabase` goes live.
 */
export function selectProvisioner(
  env: NodeJS.ProcessEnv = process.env,
): { provisioner: ServiceProvisioner; live: boolean } {
  const apiUrl = env.COOLIFY_API_URL?.trim();
  const apiToken = env.COOLIFY_API_TOKEN?.trim();
  const serverUuid = env.COOLIFY_SERVER_UUID?.trim();
  const projectUuid = env.COOLIFY_PROJECT_UUID?.trim();

  if (apiUrl && apiToken && serverUuid && projectUuid) {
    const liveMailbox = createLiveMailboxServiceProvisioner();
    return {
      provisioner: new CoolifyServiceProvisioner({
        apiUrl,
        apiToken,
        serverUuid,
        projectUuid,
        environmentName: env.COOLIFY_ENVIRONMENT_NAME?.trim() || undefined,
        // Real Mailcow mailbox creation when MAILCOW_* is set; else the
        // constructor default (stubProvisioner) keeps mail record-only.
        mailbox: liveMailbox
          ? ({ ...stubProvisioner, createMailbox: liveMailbox.createMailbox } as ServiceProvisioner)
          : undefined,
      }),
      live: true,
    };
  }
  return { provisioner: stubProvisioner, live: false };
}
