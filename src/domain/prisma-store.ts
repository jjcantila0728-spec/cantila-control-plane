/* ============================================================
   Prisma-backed Store — the production persistence adapter.
   A drop-in replacement for InMemoryStore (src/domain/store.ts):
   the same Store port, backed by the PostgreSQL data model in
   prisma/schema.prisma. Selected with STORE=prisma (see config.ts).

   Prisma rows carry Date objects and a few columns the domain
   layer does not model; the mappers below translate each row to
   the Prisma-independent domain shape and back.
   ============================================================ */

import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  Account as DbAccount,
  Project as DbProject,
  Deployment as DbDeployment,
  ManagedDatabase as DbDatabase,
  Mailbox as DbMailbox,
  HostedMailbox as DbHostedMailbox,
  MailAlias as DbMailAlias,
  MailIpPool as DbMailIpPool,
  PhoneNumber as DbPhoneNumber,
  MarketplaceNumber as DbMarketplaceNumber,
  Node as DbNode,
  A2pRegistration as DbA2pRegistration,
  EnvVar as DbEnvVar,
  Domain as DbDomain,
  ApiKey as DbApiKey,
  Backup as DbBackup,
  DomainRegistration as DbDomainRegistration,
  StorageBucket as DbStorageBucket,
  ActivityEvent as DbActivityEvent,
  InboundMessage as DbInboundMessage,
  InboundMail as DbInboundMail,
  InboundCallRecord as DbInboundCallRecord,
  SmsEvent as DbSmsEvent,
  MailEvent as DbMailEvent,
  OtpChallenge as DbOtpChallenge,
  User as DbUser,
  Session as DbSession,
  Invite as DbInvite,
  Membership as DbMembership,
  Conversation as DbConversation,
  ProjectMessage as DbProjectMessage,
  AuditLog as DbAuditLog,
} from "@prisma/client";
import type {
  Store,
  StoredAgentAction,
  StoredSmsEvent,
  StoredMailEvent,
  StoredOtpChallenge,
} from "./store";
import type {
  Account,
  Project,
  ManagedDatabase,
  Mailbox,
  HostedMailbox,
  MailAlias,
  MailAliasKind,
  MailIpPool,
  PhoneNumber,
  MarketplaceNumber,
  NumberCapability,
  Node,
  A2pRegistration,
  EnvVar,
  Deployment,
  Domain,
  ApiKey,
  Backup,
  DomainRegistration,
  StorageBucket,
  ActivityEvent,
  InboundMessage,
  InboundCallRecord,
  InboundMail,
  TeamMember,
  MemberRole,
  AuthUser,
  Session,
  Invite,
  InviteStatus,
  Membership,
  Connection,
  ConnectionAuditEvent,
  WorkflowExecutionRecord,
  WorkflowExecutionEvent,
  Conversation,
  ProjectChatMessage,
  ProjectMessageRole,
  ProjectMessageKind,
  AuditLog,
  PlatformRole,
} from "./types";
import { getPrisma } from "../lib/prisma";

/* ----- row mappers: Prisma row -> domain shape ----- */

function toProject(r: DbProject): Project {
  return {
    id: r.id,
    accountId: r.accountId,
    slug: r.slug,
    name: r.name,
    runtime: r.runtime,
    region: r.region,
    status: r.status,
    vcpu: r.vcpu,
    memoryMb: r.memoryMb,
    diskGb: r.diskGb,
    alwaysOn: r.alwaysOn,
    autoSleep: r.autoSleep,
    desiredInstances: r.desiredInstances,
    minInstances: r.minInstances,
    maxInstances: r.maxInstances,
    repoUrl: r.repoUrl ?? undefined,
    repoHost: r.repoHost ?? undefined,
    branch: r.branch ?? undefined,
    autoDeploy: r.autoDeploy,
    webhookSecret: r.webhookSecret ?? undefined,
    automationKind: r.automationKind ?? undefined,
    automationConfig:
      r.automationConfig === null
        ? undefined
        : (r.automationConfig as Record<string, unknown>),
    coolifyAppUuid: r.coolifyAppUuid ?? undefined,
    platform: r.platform ?? false,
    createdAt: r.createdAt.toISOString(),
  };
}

function toDomain(r: DbDomain): Domain {
  return {
    id: r.id,
    projectId: r.projectId,
    hostname: r.hostname,
    kind: r.kind,
    sslActive: r.sslActive,
    primary: r.primary,
    createdAt: r.createdAt.toISOString(),
  };
}

function toDatabase(r: DbDatabase): ManagedDatabase {
  return {
    id: r.id,
    projectId: r.projectId,
    engine: r.engine,
    version: r.version,
    region: r.region,
    status: r.status,
    connectionUri: r.connectionUri,
    createdAt: r.createdAt.toISOString(),
  };
}

function toMailbox(r: DbMailbox): Mailbox {
  return {
    id: r.id,
    projectId: r.projectId,
    address: r.address,
    sendingDomain: r.sendingDomain,
    smtpHost: r.smtpHost,
    smtpUser: r.smtpUser,
    smtpPassword: r.smtpPassword,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  };
}

function toHostedMailbox(r: DbHostedMailbox): HostedMailbox {
  return {
    id: r.id,
    projectId: r.projectId,
    address: r.address,
    displayName: r.displayName,
    kind: r.kind,
    quotaMb: r.quotaMb,
    usedMb: r.usedMb,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  };
}

/* The Prisma enum cannot hold a hyphen so the DB stores `catch_all`;
 * the domain shape keeps the kebab-case `catch-all` that the Console's
 * existing alias vocabulary uses. The two helpers below translate at the
 * persistence boundary. */
function encodeAliasKind(k: MailAliasKind): "alias" | "forward" | "catch_all" | "parse" {
  return k === "catch-all" ? "catch_all" : k;
}
function decodeAliasKind(k: "alias" | "forward" | "catch_all" | "parse"): MailAliasKind {
  return k === "catch_all" ? "catch-all" : k;
}

function toMailAlias(r: DbMailAlias): MailAlias {
  return {
    id: r.id,
    projectId: r.projectId,
    address: r.address,
    target: r.target,
    kind: decodeAliasKind(r.kind),
    active: r.active,
    description: r.description ?? undefined,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toNode(r: DbNode): Node {
  return {
    id: r.id,
    accountId: r.accountId,
    kind: r.kind,
    label: r.label,
    region: r.region,
    host: r.host,
    sshUser: r.sshUser,
    enrollmentTokenHash: r.enrollmentTokenHash,
    enrollmentTokenPrefix: r.enrollmentTokenPrefix,
    publicKeyFingerprint: r.publicKeyFingerprint ?? undefined,
    capacityInstances: r.capacityInstances,
    status: r.status,
    reportedInstances: r.reportedInstances ?? undefined,
    reportedLoadPct: r.reportedLoadPct ?? undefined,
    enrolledAt: r.enrolledAt?.toISOString(),
    lastHeartbeatAt: r.lastHeartbeatAt?.toISOString(),
    retiredAt: r.retiredAt?.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}

function toMailIpPool(r: DbMailIpPool): MailIpPool {
  return {
    id: r.id,
    accountId: r.accountId,
    name: r.name,
    kind: r.kind,
    ips: r.ips.split(",").map((s) => s.trim()).filter(Boolean),
    reputation: r.reputation,
    active: r.active,
    isDefault: r.isDefault,
    description: r.description ?? undefined,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toMarketplaceNumber(r: DbMarketplaceNumber): MarketplaceNumber {
  return {
    id: r.id,
    accountId: r.accountId,
    e164: r.e164,
    country: r.country,
    numberType: r.numberType,
    capabilities: r.capabilities
      .split(",")
      .filter(Boolean) as NumberCapability[],
    setupPriceCents: r.setupPriceCents,
    monthlyPriceCents: r.monthlyPriceCents,
    status: r.status,
    providerId: r.providerId,
    projectId: r.projectId ?? undefined,
    stripeSubscriptionItemId: r.stripeSubscriptionItemId ?? undefined,
    purchasedAt: r.purchasedAt.toISOString(),
    releasedAt: r.releasedAt?.toISOString(),
  };
}

function toA2pRegistration(r: DbA2pRegistration): A2pRegistration {
  return {
    id: r.id,
    accountId: r.accountId,
    kind: r.kind,
    name: r.name,
    status: r.status,
    brandRegistrationId: r.brandRegistrationId ?? undefined,
    payload: (r.payload as Record<string, unknown>) ?? {},
    providerRegistrationId: r.providerRegistrationId ?? undefined,
    rejectionReason: r.rejectionReason ?? undefined,
    createdAt: r.createdAt.toISOString(),
    submittedAt: r.submittedAt?.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString(),
  };
}

function toPhoneNumber(r: DbPhoneNumber): PhoneNumber {
  return {
    id: r.id,
    projectId: r.projectId,
    e164: r.e164,
    region: r.region,
    status: r.status,
    apiKey: r.apiKey,
    marketplaceNumberId: r.marketplaceNumberId ?? undefined,
    capabilities: r.capabilities
      .split(",")
      .filter(Boolean) as NumberCapability[],
    callRoutingAction: r.callRoutingAction,
    callRoutingTarget: r.callRoutingTarget ?? undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

function toEnvVar(r: DbEnvVar): EnvVar {
  return {
    id: r.id,
    projectId: r.projectId,
    key: r.key,
    value: r.value,
    secret: r.secret,
    scope: r.scope,
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toDeployment(r: DbDeployment): Deployment {
  return {
    id: r.id,
    projectId: r.projectId,
    status: r.status,
    trigger: r.trigger,
    runtime: r.runtime,
    imageRef: r.imageRef ?? undefined,
    nodeId: r.nodeId ?? undefined,
    url: r.url ?? undefined,
    logs: r.logs,
    commitHash: r.commitHash ?? undefined,
    commitMessage: r.commitMessage ?? undefined,
    branch: r.branch ?? undefined,
    previewBranch: r.previewBranch ?? undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

/* ----- the adapter ----- */

export class PrismaStore implements Store {
  constructor(private readonly db: PrismaClient = getPrisma()) {}

  /* ----- accounts ----- */

  async createAccount(a: Account): Promise<Account> {
    const row = await this.db.account.create({
      data: {
        id: a.id,
        name: a.name,
        handle: a.handle,
        plan: a.plan,
        parentAccountId: a.parentAccountId,
        createdAt: new Date(a.createdAt),
      },
    });
    return toAccount(row);
  }

  async listChildAccounts(parentAccountId: string): Promise<Account[]> {
    const rows = await this.db.account.findMany({
      where: { parentAccountId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toAccount);
  }

  async getAccount(id: string): Promise<Account | null> {
    const row = await this.db.account.findUnique({ where: { id } });
    return row ? toAccount(row) : null;
  }

  async findAccountByHandle(handle: string): Promise<Account | null> {
    const row = await this.db.account.findUnique({
      where: { handle: handle.toLowerCase() },
    });
    return row ? toAccount(row) : null;
  }

  async findAccountByStripeCustomer(
    customerId: string,
  ): Promise<Account | null> {
    const row = await this.db.account.findUnique({
      where: { stripeCustomerId: customerId },
    });
    return row ? toAccount(row) : null;
  }

  async listAccounts(): Promise<Account[]> {
    const rows = await this.db.account.findMany({
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toAccount);
  }

  async countAccounts(): Promise<number> {
    return this.db.account.count();
  }

  async updateAccount(id: string, patch: Partial<Account>): Promise<Account> {
    const data: Prisma.AccountUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.handle !== undefined) data.handle = patch.handle;
    if (patch.plan !== undefined) data.plan = patch.plan;
    if (patch.stripeCustomerId !== undefined)
      data.stripeCustomerId = patch.stripeCustomerId;
    if (patch.stripeSubscriptionId !== undefined)
      data.stripeSubscriptionId = patch.stripeSubscriptionId;
    if (patch.anthropicApiKey !== undefined)
      data.anthropicApiKey = patch.anthropicApiKey;
    if (patch.billingStatus !== undefined)
      data.billingStatus = patch.billingStatus;
    if (patch.dunningAttempts !== undefined)
      data.dunningAttempts = patch.dunningAttempts;
    if (patch.dunningFailedAt !== undefined)
      data.dunningFailedAt = patch.dunningFailedAt;
    if (patch.dunningGraceEndsAt !== undefined)
      data.dunningGraceEndsAt = patch.dunningGraceEndsAt;
    if ("parentAccountId" in patch)
      data.parentAccountId = patch.parentAccountId ?? null;
    // Plan §5.5 — branding fields. `in patch` so an explicit
    // `undefined` clears the column (the "unset" semantic).
    if ("brandPrimaryColor" in patch)
      (data as { brandPrimaryColor?: string | null }).brandPrimaryColor =
        patch.brandPrimaryColor ?? null;
    if ("brandAccentColor" in patch)
      (data as { brandAccentColor?: string | null }).brandAccentColor =
        patch.brandAccentColor ?? null;
    if ("brandLogoUrl" in patch)
      (data as { brandLogoUrl?: string | null }).brandLogoUrl =
        patch.brandLogoUrl ?? null;
    if ("brandDisplayName" in patch)
      (data as { brandDisplayName?: string | null }).brandDisplayName =
        patch.brandDisplayName ?? null;
    if ("billedToAccountId" in patch)
      (data as { billedToAccountId?: string | null }).billedToAccountId =
        patch.billedToAccountId ?? null;
    const row = await this.db.account.update({ where: { id }, data });
    return toAccount(row);
  }

  /* ----- projects ----- */

  async createProject(p: Project): Promise<Project> {
    const row = await this.db.project.create({
      data: {
        id: p.id,
        slug: p.slug,
        name: p.name,
        runtime: p.runtime,
        region: p.region,
        status: p.status,
        vcpu: p.vcpu,
        memoryMb: p.memoryMb,
        diskGb: p.diskGb,
        alwaysOn: p.alwaysOn,
        autoSleep: p.autoSleep,
        desiredInstances: p.desiredInstances,
        minInstances: p.minInstances,
        maxInstances: p.maxInstances,
        repoUrl: p.repoUrl,
        repoHost: p.repoHost ?? "github",
        branch: p.branch,
        autoDeploy: p.autoDeploy,
        platform: p.platform ?? false,
        createdAt: new Date(p.createdAt),
        // The ControlPlane only carries an accountId. Connect to the owning
        // account — it must already exist. A missing account is a real FK
        // error, never auto-vivified into a placeholder "Demo Account".
        account: { connect: { id: p.accountId } },
      },
    });
    return toProject(row);
  }

  async getProject(id: string): Promise<Project | null> {
    const row = await this.db.project.findUnique({ where: { id } });
    return row ? toProject(row) : null;
  }

  async updateProject(id: string, patch: Partial<Project>): Promise<Project> {
    const data: Prisma.ProjectUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.slug !== undefined) data.slug = patch.slug;
    if (patch.runtime !== undefined) data.runtime = patch.runtime;
    if (patch.region !== undefined) data.region = patch.region;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.vcpu !== undefined) data.vcpu = patch.vcpu;
    if (patch.memoryMb !== undefined) data.memoryMb = patch.memoryMb;
    if (patch.diskGb !== undefined) data.diskGb = patch.diskGb;
    if (patch.alwaysOn !== undefined) data.alwaysOn = patch.alwaysOn;
    if (patch.autoSleep !== undefined) data.autoSleep = patch.autoSleep;
    if (patch.desiredInstances !== undefined) data.desiredInstances = patch.desiredInstances;
    if (patch.minInstances !== undefined) data.minInstances = patch.minInstances;
    if (patch.maxInstances !== undefined) data.maxInstances = patch.maxInstances;
    if (patch.repoUrl !== undefined) data.repoUrl = patch.repoUrl;
    if (patch.repoHost !== undefined) data.repoHost = patch.repoHost;
    if (patch.branch !== undefined) data.branch = patch.branch;
    if (patch.autoDeploy !== undefined) data.autoDeploy = patch.autoDeploy;
    if (patch.webhookSecret !== undefined) data.webhookSecret = patch.webhookSecret;
    if (patch.automationKind !== undefined) data.automationKind = patch.automationKind;
    if (patch.automationConfig !== undefined) {
      data.automationConfig =
        patch.automationConfig === null
          ? Prisma.JsonNull
          : (patch.automationConfig as Prisma.InputJsonValue);
    }
    if (patch.coolifyAppUuid !== undefined) data.coolifyAppUuid = patch.coolifyAppUuid;
    const row = await this.db.project.update({ where: { id }, data });
    return toProject(row);
  }

  async listProjects(accountId: string): Promise<Project[]> {
    const rows = await this.db.project.findMany({
      where: { accountId, platform: false },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toProject);
  }

  async listAllProjects(): Promise<Project[]> {
    const rows = await this.db.project.findMany({
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toProject);
  }

  async deleteProject(id: string): Promise<boolean> {
    // FK relations (database, mailbox, domains, env vars, deployments,
    // phone number, …) all declare `onDelete: Cascade`, so deleting the
    // project row removes them too. Append-only audit logs (ActivityEvent
    // etc.) have no FK relation and are intentionally retained.
    try {
      await this.db.project.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  /* ----- managed database ----- */

  async getDatabaseByProject(
    projectId: string,
  ): Promise<ManagedDatabase | null> {
    const row = await this.db.managedDatabase.findUnique({
      where: { projectId },
    });
    return row ? toDatabase(row) : null;
  }

  async createDatabase(d: ManagedDatabase): Promise<ManagedDatabase> {
    const row = await this.db.managedDatabase.create({
      data: {
        id: d.id,
        projectId: d.projectId,
        engine: d.engine,
        version: d.version,
        region: d.region,
        status: d.status,
        connectionUri: d.connectionUri,
        createdAt: new Date(d.createdAt),
      },
    });
    return toDatabase(row);
  }

  async deleteDatabase(projectId: string): Promise<boolean> {
    try {
      await this.db.managedDatabase.delete({ where: { projectId } });
      return true;
    } catch {
      return false;
    }
  }

  /* ----- mailbox ----- */

  async getMailboxByProject(projectId: string): Promise<Mailbox | null> {
    const row = await this.db.mailbox.findUnique({ where: { projectId } });
    return row ? toMailbox(row) : null;
  }

  async createMailbox(m: Mailbox): Promise<Mailbox> {
    const row = await this.db.mailbox.create({
      data: {
        id: m.id,
        projectId: m.projectId,
        address: m.address,
        sendingDomain: m.sendingDomain,
        smtpHost: m.smtpHost,
        smtpUser: m.smtpUser,
        smtpPassword: m.smtpPassword,
        status: m.status,
        createdAt: new Date(m.createdAt),
      },
    });
    return toMailbox(row);
  }

  async updateMailbox(
    id: string,
    patch: Partial<
      Pick<
        Mailbox,
        "address" | "sendingDomain" | "smtpHost" | "smtpUser" | "status"
      >
    >,
  ): Promise<Mailbox | null> {
    try {
      const row = await this.db.mailbox.update({
        where: { id },
        data: { ...patch },
      });
      return toMailbox(row);
    } catch {
      // No row with that id (P2025) — treat as a no-op miss.
      return null;
    }
  }

  /* ----- hosted mailboxes (plan §4.4) ----- */

  async createHostedMailbox(m: HostedMailbox): Promise<HostedMailbox> {
    const row = await this.db.hostedMailbox.create({
      data: {
        id: m.id,
        projectId: m.projectId,
        address: m.address,
        displayName: m.displayName,
        kind: m.kind,
        quotaMb: m.quotaMb,
        usedMb: m.usedMb,
        status: m.status,
        createdAt: new Date(m.createdAt),
      },
    });
    return toHostedMailbox(row);
  }

  async listHostedMailboxesByProject(
    projectId: string,
  ): Promise<HostedMailbox[]> {
    const rows = await this.db.hostedMailbox.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toHostedMailbox);
  }

  async listHostedMailboxes(accountId: string): Promise<HostedMailbox[]> {
    const rows = await this.db.hostedMailbox.findMany({
      where: { project: { accountId } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toHostedMailbox);
  }

  async getHostedMailbox(id: string): Promise<HostedMailbox | null> {
    const row = await this.db.hostedMailbox.findUnique({ where: { id } });
    return row ? toHostedMailbox(row) : null;
  }

  async findHostedMailboxByAddress(
    address: string,
  ): Promise<HostedMailbox | null> {
    const row = await this.db.hostedMailbox.findUnique({
      where: { address: address.trim().toLowerCase() },
    });
    return row ? toHostedMailbox(row) : null;
  }

  async deleteHostedMailbox(id: string): Promise<boolean> {
    try {
      await this.db.hostedMailbox.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  /* ----- mail aliases (plan §4.4) ----- */

  async createMailAlias(a: MailAlias): Promise<MailAlias> {
    const row = await this.db.mailAlias.create({
      data: {
        id: a.id,
        projectId: a.projectId,
        address: a.address,
        target: a.target,
        kind: encodeAliasKind(a.kind),
        active: a.active,
        description: a.description,
        createdAt: new Date(a.createdAt),
        updatedAt: new Date(a.updatedAt),
      },
    });
    return toMailAlias(row);
  }

  async listMailAliasesByProject(projectId: string): Promise<MailAlias[]> {
    const rows = await this.db.mailAlias.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toMailAlias);
  }

  async listMailAliases(accountId: string): Promise<MailAlias[]> {
    const rows = await this.db.mailAlias.findMany({
      where: { project: { accountId } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toMailAlias);
  }

  async getMailAlias(id: string): Promise<MailAlias | null> {
    const row = await this.db.mailAlias.findUnique({ where: { id } });
    return row ? toMailAlias(row) : null;
  }

  async findMailAliasByAddress(address: string): Promise<MailAlias | null> {
    const row = await this.db.mailAlias.findUnique({
      where: { address: address.trim().toLowerCase() },
    });
    return row ? toMailAlias(row) : null;
  }

  async updateMailAlias(
    id: string,
    patch: Partial<MailAlias>,
  ): Promise<MailAlias> {
    const data: Prisma.MailAliasUpdateInput = {};
    if (patch.target !== undefined) data.target = patch.target;
    if (patch.kind !== undefined) data.kind = encodeAliasKind(patch.kind);
    if (patch.active !== undefined) data.active = patch.active;
    if (patch.description !== undefined) data.description = patch.description;
    const row = await this.db.mailAlias.update({ where: { id }, data });
    return toMailAlias(row);
  }

  async deleteMailAlias(id: string): Promise<boolean> {
    try {
      await this.db.mailAlias.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  /* ----- mail IP pools (plan §4.4) ----- */

  async createMailIpPool(p: MailIpPool): Promise<MailIpPool> {
    const row = await this.db.mailIpPool.create({
      data: {
        id: p.id,
        accountId: p.accountId,
        name: p.name,
        kind: p.kind,
        ips: p.ips.join(","),
        reputation: p.reputation,
        active: p.active,
        isDefault: p.isDefault,
        description: p.description,
        createdAt: new Date(p.createdAt),
        updatedAt: new Date(p.updatedAt),
      },
    });
    return toMailIpPool(row);
  }

  async listMailIpPools(accountId: string): Promise<MailIpPool[]> {
    const rows = await this.db.mailIpPool.findMany({
      where: { accountId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toMailIpPool);
  }

  async getMailIpPool(id: string): Promise<MailIpPool | null> {
    const row = await this.db.mailIpPool.findUnique({ where: { id } });
    return row ? toMailIpPool(row) : null;
  }

  async updateMailIpPool(
    id: string,
    patch: Partial<MailIpPool>,
  ): Promise<MailIpPool> {
    const data: Prisma.MailIpPoolUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.kind !== undefined) data.kind = patch.kind;
    if (patch.ips !== undefined) data.ips = patch.ips.join(",");
    if (patch.reputation !== undefined) data.reputation = patch.reputation;
    if (patch.active !== undefined) data.active = patch.active;
    if (patch.isDefault !== undefined) data.isDefault = patch.isDefault;
    if ("description" in patch) data.description = patch.description ?? null;
    const row = await this.db.mailIpPool.update({ where: { id }, data });
    return toMailIpPool(row);
  }

  async deleteMailIpPool(id: string): Promise<boolean> {
    try {
      await this.db.mailIpPool.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  /* ----- compute nodes (plan §5.5 — Bring-Your-Own-VPS) ----- */

  async createNode(n: Node): Promise<Node> {
    const row = await this.db.node.create({
      data: {
        id: n.id,
        accountId: n.accountId,
        kind: n.kind,
        label: n.label,
        region: n.region,
        host: n.host,
        sshUser: n.sshUser,
        enrollmentTokenHash: n.enrollmentTokenHash,
        enrollmentTokenPrefix: n.enrollmentTokenPrefix,
        publicKeyFingerprint: n.publicKeyFingerprint,
        capacityInstances: n.capacityInstances,
        status: n.status,
        reportedInstances: n.reportedInstances,
        reportedLoadPct: n.reportedLoadPct,
        enrolledAt: n.enrolledAt ? new Date(n.enrolledAt) : null,
        lastHeartbeatAt: n.lastHeartbeatAt
          ? new Date(n.lastHeartbeatAt)
          : null,
        retiredAt: n.retiredAt ? new Date(n.retiredAt) : null,
        createdAt: new Date(n.createdAt),
      },
    });
    return toNode(row);
  }

  async getNode(id: string): Promise<Node | null> {
    const row = await this.db.node.findUnique({ where: { id } });
    return row ? toNode(row) : null;
  }

  async listNodes(accountId: string): Promise<Node[]> {
    const rows = await this.db.node.findMany({
      where: { accountId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toNode);
  }

  async listAllNodes(): Promise<Node[]> {
    const rows = await this.db.node.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map(toNode);
  }

  async updateNode(id: string, patch: Partial<Node>): Promise<Node> {
    const data: Prisma.NodeUpdateInput = {};
    if (patch.label !== undefined) data.label = patch.label;
    if (patch.region !== undefined) data.region = patch.region;
    if (patch.host !== undefined) data.host = patch.host;
    if (patch.sshUser !== undefined) data.sshUser = patch.sshUser;
    if (patch.kind !== undefined) data.kind = patch.kind;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.capacityInstances !== undefined) {
      data.capacityInstances = patch.capacityInstances;
    }
    if ("publicKeyFingerprint" in patch) {
      data.publicKeyFingerprint = patch.publicKeyFingerprint ?? null;
    }
    if ("reportedInstances" in patch) {
      data.reportedInstances = patch.reportedInstances ?? null;
    }
    if ("reportedLoadPct" in patch) {
      data.reportedLoadPct = patch.reportedLoadPct ?? null;
    }
    if ("enrolledAt" in patch) {
      data.enrolledAt = patch.enrolledAt ? new Date(patch.enrolledAt) : null;
    }
    if ("lastHeartbeatAt" in patch) {
      data.lastHeartbeatAt = patch.lastHeartbeatAt
        ? new Date(patch.lastHeartbeatAt)
        : null;
    }
    if ("retiredAt" in patch) {
      data.retiredAt = patch.retiredAt ? new Date(patch.retiredAt) : null;
    }
    const row = await this.db.node.update({ where: { id }, data });
    return toNode(row);
  }

  async findNodeByEnrollmentTokenHash(hash: string): Promise<Node | null> {
    const row = await this.db.node.findFirst({
      where: { enrollmentTokenHash: hash },
    });
    return row ? toNode(row) : null;
  }

  /* ----- number marketplace (plan §4.5) ----- */

  async createMarketplaceNumber(
    n: MarketplaceNumber,
  ): Promise<MarketplaceNumber> {
    const row = await this.db.marketplaceNumber.create({
      data: {
        id: n.id,
        accountId: n.accountId,
        e164: n.e164,
        country: n.country,
        numberType: n.numberType,
        capabilities: n.capabilities.join(","),
        setupPriceCents: n.setupPriceCents,
        monthlyPriceCents: n.monthlyPriceCents,
        status: n.status,
        providerId: n.providerId,
        projectId: n.projectId,
        stripeSubscriptionItemId: n.stripeSubscriptionItemId ?? null,
        purchasedAt: new Date(n.purchasedAt),
        releasedAt: n.releasedAt ? new Date(n.releasedAt) : null,
      },
    });
    return toMarketplaceNumber(row);
  }

  async listMarketplaceNumbers(
    accountId: string,
  ): Promise<MarketplaceNumber[]> {
    const rows = await this.db.marketplaceNumber.findMany({
      where: { accountId },
      orderBy: { purchasedAt: "desc" },
    });
    return rows.map(toMarketplaceNumber);
  }

  async getMarketplaceNumber(
    id: string,
  ): Promise<MarketplaceNumber | null> {
    const row = await this.db.marketplaceNumber.findUnique({ where: { id } });
    return row ? toMarketplaceNumber(row) : null;
  }

  async findMarketplaceNumberByE164(
    e164: string,
  ): Promise<MarketplaceNumber | null> {
    const row = await this.db.marketplaceNumber.findUnique({
      where: { e164: e164.trim() },
    });
    return row ? toMarketplaceNumber(row) : null;
  }

  async updateMarketplaceNumber(
    id: string,
    patch: Partial<MarketplaceNumber>,
  ): Promise<MarketplaceNumber> {
    const data: Prisma.MarketplaceNumberUpdateInput = {};
    if (patch.status !== undefined) data.status = patch.status;
    // Re-home the number to another account — `transferNumber` uses this.
    if (patch.accountId !== undefined) {
      data.account = { connect: { id: patch.accountId } };
    }
    // `"projectId" in patch` (not `!== undefined`) so an explicit
    // `projectId: undefined` — used by `transferNumber` to unassign —
    // actually clears the column rather than being skipped.
    if ("projectId" in patch) data.projectId = patch.projectId ?? null;
    // Same `"in"` check — `releaseOwnedNumber` and `transferNumber` pass an
    // explicit `undefined` to clear the Stripe subscription-item id.
    if ("stripeSubscriptionItemId" in patch) {
      data.stripeSubscriptionItemId = patch.stripeSubscriptionItemId ?? null;
    }
    if (patch.releasedAt !== undefined) {
      data.releasedAt = patch.releasedAt ? new Date(patch.releasedAt) : null;
    }
    const row = await this.db.marketplaceNumber.update({
      where: { id },
      data,
    });
    return toMarketplaceNumber(row);
  }

  /* ----- A2P/10DLC carrier registration (plan §4.5) ----- */

  async createA2pRegistration(
    r: A2pRegistration,
  ): Promise<A2pRegistration> {
    const row = await this.db.a2pRegistration.create({
      data: {
        id: r.id,
        accountId: r.accountId,
        kind: r.kind,
        name: r.name,
        status: r.status,
        brandRegistrationId: r.brandRegistrationId ?? null,
        payload: r.payload as Prisma.InputJsonValue,
        providerRegistrationId: r.providerRegistrationId ?? null,
        rejectionReason: r.rejectionReason ?? null,
        createdAt: new Date(r.createdAt),
        submittedAt: r.submittedAt ? new Date(r.submittedAt) : null,
        resolvedAt: r.resolvedAt ? new Date(r.resolvedAt) : null,
      },
    });
    return toA2pRegistration(row);
  }

  async listA2pRegistrations(
    accountId: string,
  ): Promise<A2pRegistration[]> {
    const rows = await this.db.a2pRegistration.findMany({
      where: { accountId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toA2pRegistration);
  }

  async getA2pRegistration(
    id: string,
  ): Promise<A2pRegistration | null> {
    const row = await this.db.a2pRegistration.findUnique({ where: { id } });
    return row ? toA2pRegistration(row) : null;
  }

  async updateA2pRegistration(
    id: string,
    patch: Partial<A2pRegistration>,
  ): Promise<A2pRegistration> {
    const data: Prisma.A2pRegistrationUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.payload !== undefined)
      data.payload = patch.payload as Prisma.InputJsonValue;
    if ("brandRegistrationId" in patch)
      data.brandRegistrationId = patch.brandRegistrationId ?? null;
    if ("providerRegistrationId" in patch)
      data.providerRegistrationId = patch.providerRegistrationId ?? null;
    if ("rejectionReason" in patch)
      data.rejectionReason = patch.rejectionReason ?? null;
    if (patch.submittedAt !== undefined)
      data.submittedAt = patch.submittedAt ? new Date(patch.submittedAt) : null;
    if (patch.resolvedAt !== undefined)
      data.resolvedAt = patch.resolvedAt ? new Date(patch.resolvedAt) : null;
    const row = await this.db.a2pRegistration.update({ where: { id }, data });
    return toA2pRegistration(row);
  }

  /* ----- phone number ----- */

  async getPhoneNumberByProject(
    projectId: string,
  ): Promise<PhoneNumber | null> {
    const row = await this.db.phoneNumber.findUnique({
      where: { projectId },
    });
    return row ? toPhoneNumber(row) : null;
  }

  async createPhoneNumber(n: PhoneNumber): Promise<PhoneNumber> {
    const row = await this.db.phoneNumber.create({
      data: {
        id: n.id,
        projectId: n.projectId,
        e164: n.e164,
        region: n.region,
        status: n.status,
        apiKey: n.apiKey,
        marketplaceNumberId: n.marketplaceNumberId ?? null,
        capabilities: n.capabilities.join(","),
        createdAt: new Date(n.createdAt),
      },
    });
    return toPhoneNumber(row);
  }

  async deletePhoneNumber(projectId: string): Promise<void> {
    await this.db.phoneNumber.deleteMany({ where: { projectId } });
  }

  async updatePhoneNumber(
    projectId: string,
    patch: Partial<PhoneNumber>,
  ): Promise<PhoneNumber> {
    const data: Prisma.PhoneNumberUpdateInput = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.callRoutingAction !== undefined) {
      data.callRoutingAction = patch.callRoutingAction;
    }
    // `"in"` (not `!== undefined`) so an explicit `undefined` clears the
    // target — `setCallRouting` to voicemail / reject clears it.
    if ("callRoutingTarget" in patch) {
      data.callRoutingTarget = patch.callRoutingTarget ?? null;
    }
    const row = await this.db.phoneNumber.update({
      where: { projectId },
      data,
    });
    return toPhoneNumber(row);
  }

  /* ----- env vars ----- */

  async listEnvVars(projectId: string): Promise<EnvVar[]> {
    const rows = await this.db.envVar.findMany({ where: { projectId } });
    return rows.map(toEnvVar);
  }

  async upsertEnvVar(v: EnvVar): Promise<EnvVar> {
    // unique by (projectId, key, scope) — see @@unique in schema.prisma.
    // `updatedAt` is @updatedAt, managed by Prisma, so it is never written.
    const row = await this.db.envVar.upsert({
      where: {
        projectId_key_scope: {
          projectId: v.projectId,
          key: v.key,
          scope: v.scope,
        },
      },
      create: {
        id: v.id,
        projectId: v.projectId,
        key: v.key,
        value: v.value,
        secret: v.secret,
        scope: v.scope,
      },
      update: {
        value: v.value,
        secret: v.secret,
      },
    });
    return toEnvVar(row);
  }

  async deleteEnvVar(projectId: string, key: string): Promise<void> {
    // Drops the var across every scope — the injected SMS vars use a
    // single `all` scope, but deleting by (projectId, key) is the safe
    // superset for deactivation.
    await this.db.envVar.deleteMany({ where: { projectId, key } });
  }

  /* ----- deployments ----- */

  async createDeployment(d: Deployment): Promise<Deployment> {
    const row = await this.db.deployment.create({
      data: {
        id: d.id,
        projectId: d.projectId,
        status: d.status,
        trigger: d.trigger,
        runtime: d.runtime,
        imageRef: d.imageRef,
        nodeId: d.nodeId,
        url: d.url,
        logs: d.logs,
        commitHash: d.commitHash,
        commitMessage: d.commitMessage,
        branch: d.branch,
        previewBranch: d.previewBranch,
        createdAt: new Date(d.createdAt),
      },
    });
    return toDeployment(row);
  }

  async updateDeployment(
    id: string,
    patch: Partial<Deployment>,
  ): Promise<Deployment> {
    const data: Prisma.DeploymentUpdateInput = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.trigger !== undefined) data.trigger = patch.trigger;
    if (patch.runtime !== undefined) data.runtime = patch.runtime;
    if (patch.imageRef !== undefined) data.imageRef = patch.imageRef;
    if (patch.nodeId !== undefined) data.nodeId = patch.nodeId;
    if (patch.url !== undefined) data.url = patch.url;
    if (patch.logs !== undefined) data.logs = patch.logs;
    if (patch.commitHash !== undefined) data.commitHash = patch.commitHash;
    if (patch.commitMessage !== undefined)
      data.commitMessage = patch.commitMessage;
    if (patch.branch !== undefined) data.branch = patch.branch;
    const row = await this.db.deployment.update({ where: { id }, data });
    return toDeployment(row);
  }

  async listDeployments(projectId: string): Promise<Deployment[]> {
    const rows = await this.db.deployment.findMany({ where: { projectId } });
    return rows.map(toDeployment);
  }

  /* ----- domains ----- */

  async listDomains(projectId: string): Promise<Domain[]> {
    const rows = await this.db.domain.findMany({ where: { projectId } });
    return rows.map(toDomain);
  }

  async createDomain(d: Domain): Promise<Domain> {
    const row = await this.db.domain.create({
      data: {
        id: d.id,
        projectId: d.projectId,
        hostname: d.hostname,
        kind: d.kind,
        sslActive: d.sslActive,
        primary: d.primary,
        createdAt: new Date(d.createdAt),
      },
    });
    return toDomain(row);
  }

  async findDomainByHostname(hostname: string): Promise<Domain | null> {
    const row = await this.db.domain.findUnique({ where: { hostname } });
    return row ? toDomain(row) : null;
  }

  async updateDomain(id: string, patch: Partial<Domain>): Promise<Domain> {
    const row = await this.db.domain.update({
      where: { id },
      data: {
        ...(patch.hostname !== undefined ? { hostname: patch.hostname } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.sslActive !== undefined ? { sslActive: patch.sslActive } : {}),
        ...(patch.primary !== undefined ? { primary: patch.primary } : {}),
      },
    });
    return toDomain(row);
  }

  /* ----- api keys ----- */

  async createApiKey(k: ApiKey): Promise<ApiKey> {
    const row = await this.db.apiKey.create({
      data: {
        id: k.id,
        accountId: k.accountId,
        name: k.name,
        scope: k.scope,
        prefix: k.prefix,
        hashedKey: k.hash,
        createdAt: new Date(k.createdAt),
      },
    });
    return toApiKey(row);
  }

  async listApiKeys(accountId: string): Promise<ApiKey[]> {
    const rows = await this.db.apiKey.findMany({
      where: { accountId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toApiKey);
  }

  async findApiKeyByHash(hash: string): Promise<ApiKey | null> {
    const row = await this.db.apiKey.findUnique({ where: { hashedKey: hash } });
    return row ? toApiKey(row) : null;
  }

  async findApiKeyById(id: string): Promise<ApiKey | null> {
    const row = await this.db.apiKey.findUnique({ where: { id } });
    return row ? toApiKey(row) : null;
  }

  async countApiKeys(): Promise<number> {
    return this.db.apiKey.count();
  }

  async touchApiKey(id: string, at: string): Promise<void> {
    await this.db.apiKey.update({
      where: { id },
      data: { lastUsedAt: new Date(at) },
    });
  }

  async deleteApiKey(id: string): Promise<boolean> {
    try {
      await this.db.apiKey.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  /* ----- backups (plan §5.5) ----- */

  async createBackup(b: Backup): Promise<Backup> {
    const row = await this.db.backup.create({
      data: {
        id: b.id,
        projectId: b.projectId,
        accountId: b.accountId,
        deploymentId: b.deploymentId,
        envVarsJson: b.envVars as unknown as Prisma.InputJsonValue,
        databaseSnapshotId: b.databaseSnapshotId,
        note: b.note,
        trigger: b.trigger === "auto-pre-deploy" ? "auto_pre_deploy" : "manual",
        createdAt: new Date(b.createdAt),
      },
    });
    return toBackup(row);
  }

  async listBackups(projectId: string): Promise<Backup[]> {
    const rows = await this.db.backup.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toBackup);
  }

  async getBackup(id: string): Promise<Backup | null> {
    const row = await this.db.backup.findUnique({ where: { id } });
    return row ? toBackup(row) : null;
  }

  async deleteBackup(id: string): Promise<boolean> {
    try {
      await this.db.backup.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  /* ----- team (plan §5.5) ----- */

  async listMembers(accountId: string): Promise<TeamMember[]> {
    const rows = await this.db.membership.findMany({
      where: { accountId },
      include: { user: true },
      orderBy: { id: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      userId: r.userId,
      email: r.user.email,
      name: r.user.name,
      avatarUrl: r.user.avatarUrl ?? undefined,
      role: r.role,
      joinedAt: r.user.createdAt.toISOString(),
    }));
  }

  async addMember(input: {
    accountId: string;
    email: string;
    name: string;
    role: MemberRole;
  }): Promise<TeamMember> {
    const email = input.email.trim().toLowerCase();
    // Upsert user by email — re-use across accounts.
    const user = await this.db.user.upsert({
      where: { email },
      create: { email, name: input.name },
      update: { name: input.name },
    });
    // The account must already exist — we do NOT auto-create a placeholder
    // here. The membership upsert below references `input.accountId`
    // directly, so a missing account surfaces as a real FK error rather
    // than silently vivifying a "Demo Account".
    // Upsert membership at the chosen role.
    const membership = await this.db.membership.upsert({
      where: {
        accountId_userId: { accountId: input.accountId, userId: user.id },
      },
      create: {
        accountId: input.accountId,
        userId: user.id,
        role: input.role,
      },
      update: { role: input.role },
    });
    return {
      id: membership.id,
      accountId: membership.accountId,
      userId: membership.userId,
      email: user.email,
      name: user.name,
      role: membership.role,
      joinedAt: user.createdAt.toISOString(),
    };
  }

  async updateMemberRole(
    membershipId: string,
    role: MemberRole,
  ): Promise<TeamMember> {
    const row = await this.db.membership.update({
      where: { id: membershipId },
      data: { role },
      include: { user: true },
    });
    return {
      id: row.id,
      accountId: row.accountId,
      userId: row.userId,
      email: row.user.email,
      name: row.user.name,
      role: row.role,
      joinedAt: row.user.createdAt.toISOString(),
    };
  }

  async removeMember(membershipId: string): Promise<boolean> {
    try {
      await this.db.membership.delete({ where: { id: membershipId } });
      return true;
    } catch {
      return false;
    }
  }

  /* ----- per-user auth: users & sessions (plan §5.4) ----- */

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    const row = await this.db.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    return row ? toAuthUser(row) : null;
  }

  async getUser(id: string): Promise<AuthUser | null> {
    const row = await this.db.user.findUnique({ where: { id } });
    return row ? toAuthUser(row) : null;
  }

  async createUser(u: AuthUser): Promise<AuthUser> {
    const row = await this.db.user.create({
      data: {
        id: u.id,
        email: u.email,
        name: u.name,
        passwordHash: u.passwordHash,
        twoFactorEnabled: u.twoFactorEnabled,
        accountId: u.accountId,
        avatarUrl: u.avatarUrl,
        platformRole: u.platformRole,
        createdAt: new Date(u.createdAt),
      },
    });
    return toAuthUser(row);
  }

  async updateUserPassword(
    userId: string,
    passwordHash: string,
  ): Promise<AuthUser> {
    const row = await this.db.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
    return toAuthUser(row);
  }

  async setUserAvatarUrl(
    userId: string,
    avatarUrl: string,
  ): Promise<AuthUser> {
    const row = await this.db.user.update({
      where: { id: userId },
      data: { avatarUrl },
    });
    return toAuthUser(row);
  }

  async setUserPlatformRole(
    userId: string,
    role: PlatformRole | null,
  ): Promise<AuthUser> {
    const row = await this.db.user.update({
      where: { id: userId },
      data: { platformRole: role },
    });
    return toAuthUser(row);
  }

  async listAllUsers(): Promise<AuthUser[]> {
    const rows = await this.db.user.findMany({
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toAuthUser);
  }

  async setUserEmailVerifiedAt(
    userId: string,
    verifiedAt: string,
  ): Promise<AuthUser> {
    const row = await this.db.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date(verifiedAt) },
    });
    return toAuthUser(row);
  }

  async createSession(s: Session): Promise<Session> {
    const row = await this.db.session.create({
      data: {
        id: s.id,
        userId: s.userId,
        tokenHash: s.tokenHash,
        expiresAt: new Date(s.expiresAt),
        createdAt: new Date(s.createdAt),
        currentAccountId: s.currentAccountId ?? null,
      },
    });
    return toSession(row);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<Session | null> {
    const row = await this.db.session.findUnique({ where: { tokenHash } });
    return row ? toSession(row) : null;
  }

  async deleteSession(id: string): Promise<boolean> {
    try {
      await this.db.session.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async deleteSessionsByUser(userId: string): Promise<number> {
    const res = await this.db.session.deleteMany({ where: { userId } });
    return res.count;
  }

  /* ----- invites (plan §5.4) ----- */

  async createInvite(i: Invite): Promise<Invite> {
    const row = await this.db.invite.create({
      data: {
        id: i.id,
        accountId: i.accountId,
        email: i.email,
        role: i.role,
        tokenHash: i.tokenHash,
        status: i.status,
        invitedByUserId: i.invitedByUserId,
        createdAt: new Date(i.createdAt),
        expiresAt: new Date(i.expiresAt),
        acceptedAt: i.acceptedAt ? new Date(i.acceptedAt) : null,
        acceptedByUserId: i.acceptedByUserId,
      },
    });
    return toInvite(row);
  }

  async getInvite(id: string): Promise<Invite | null> {
    const row = await this.db.invite.findUnique({ where: { id } });
    return row ? toInvite(row) : null;
  }

  async findInviteByTokenHash(tokenHash: string): Promise<Invite | null> {
    const row = await this.db.invite.findUnique({ where: { tokenHash } });
    return row ? toInvite(row) : null;
  }

  async findPendingInviteByAccountAndEmail(
    accountId: string,
    email: string,
  ): Promise<Invite | null> {
    const row = await this.db.invite.findFirst({
      where: {
        accountId,
        email: email.trim().toLowerCase(),
        status: "pending",
      },
    });
    return row ? toInvite(row) : null;
  }

  async listInvitesByAccount(accountId: string): Promise<Invite[]> {
    const rows = await this.db.invite.findMany({
      where: { accountId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toInvite);
  }

  async updateInvite(id: string, patch: Partial<Invite>): Promise<Invite> {
    const data: Prisma.InviteUpdateInput = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.acceptedAt !== undefined)
      data.acceptedAt = patch.acceptedAt ? new Date(patch.acceptedAt) : null;
    if (patch.acceptedByUserId !== undefined)
      data.acceptedByUserId = patch.acceptedByUserId;
    if (patch.expiresAt !== undefined)
      data.expiresAt = new Date(patch.expiresAt);
    if (patch.role !== undefined) data.role = patch.role;
    const row = await this.db.invite.update({ where: { id }, data });
    return toInvite(row);
  }

  /* ----- memberships (plan §18 — Option B multi-org tenancy) -----
     Mirrors the InMemoryStore implementation in store.ts. The `Membership`
     model already exists in prisma/schema.prisma; we leave the legacy
     1:1 binding (`User.accountId`) in place for migration purposes —
     control-plane code reads memberships first, falling back to the
     legacy column only for accounts that haven't been migrated yet. */

  async createMembership(m: Membership): Promise<Membership> {
    const row = await this.db.membership.create({
      data: {
        id: m.id,
        userId: m.userId,
        accountId: m.accountId,
        role: m.role,
        createdAt: new Date(m.createdAt),
      },
    });
    return toMembership(row);
  }

  async findMembership(
    userId: string,
    accountId: string,
  ): Promise<Membership | null> {
    const row = await this.db.membership.findFirst({
      where: { userId, accountId },
    });
    return row ? toMembership(row) : null;
  }

  async listMembershipsByUser(userId: string): Promise<Membership[]> {
    const rows = await this.db.membership.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toMembership);
  }

  async listMembershipsByAccount(accountId: string): Promise<Membership[]> {
    const rows = await this.db.membership.findMany({
      where: { accountId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toMembership);
  }

  async deleteMembership(id: string): Promise<boolean> {
    try {
      await this.db.membership.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async setSessionCurrentAccount(
    sessionId: string,
    accountId: string | null,
  ): Promise<Session> {
    // The `currentAccountId` column was added by the migration
    // `20260525240000_add_session_current_account`. Until `prisma generate`
    // is re-run the typed input shape may not include it — cast through
    // `as unknown` to defer the type error to verification time.
    const row = await this.db.session.update({
      where: { id: sessionId },
      data: { currentAccountId: accountId } as unknown as Prisma.SessionUpdateInput,
    });
    return toSession(row);
  }

  /* ----- activity feed ----- */

  async recordEvent(e: ActivityEvent): Promise<ActivityEvent> {
    // Plan §5.5 — `actorAccountId` is part of the unverified
    // 20260526010000_add_activity_actor migration. Until `prisma
    // generate` runs against it the Prisma client's type for
    // `activityEvent.create` doesn't include the new column. Cast
    // the data through `unknown` so this file type-checks against
    // both the OLD generated client (where the field is silently
    // dropped) and the NEW one (where it's persisted). Same pattern
    // as the defensive `toAccount` read at the bottom of this file.
    const data = {
      id: e.id,
      accountId: e.accountId,
      kind: e.kind,
      title: e.title,
      detail: e.detail,
      projectId: e.projectId,
      actorAccountId: e.actorAccountId,
      at: new Date(e.at),
    };
    const row = await this.db.activityEvent.create({
      data: data as unknown as Prisma.ActivityEventCreateInput,
    });
    return toEvent(row);
  }

  async listEvents(
    accountId: string,
    opts: { limit?: number } = {},
  ): Promise<ActivityEvent[]> {
    const rows = await this.db.activityEvent.findMany({
      where: { accountId },
      orderBy: { at: "desc" },
      take: opts.limit ?? 100,
    });
    return rows.map(toEvent);
  }

  /* ----- inbound SMS message history (plan §4.5) ----- */

  async createInboundMessage(m: InboundMessage): Promise<InboundMessage> {
    const row = await this.db.inboundMessage.create({
      data: {
        id: m.id,
        accountId: m.accountId,
        projectId: m.projectId,
        toE164: m.toE164,
        fromE164: m.fromE164,
        body: m.body,
        keyword: m.keyword ?? null,
        providerMessageId: m.providerMessageId,
        receivedAt: new Date(m.receivedAt),
      },
    });
    return toInboundMessage(row);
  }

  async listInboundMessages(query: {
    accountId: string;
    projectId?: string;
    limit?: number;
  }): Promise<InboundMessage[]> {
    const rows = await this.db.inboundMessage.findMany({
      where: {
        accountId: query.accountId,
        ...(query.projectId ? { projectId: query.projectId } : {}),
      },
      orderBy: { receivedAt: "desc" },
      take: query.limit ?? 100,
    });
    return rows.map(toInboundMessage);
  }

  /* ----- inbound mail history (plan §4.4 — two-way mail) ----- */

  async createInboundMail(m: InboundMail): Promise<InboundMail> {
    const row = await this.db.inboundMail.create({
      data: {
        id: m.id,
        accountId: m.accountId,
        projectId: m.projectId,
        toAddress: m.toAddress,
        fromAddress: m.fromAddress,
        subject: m.subject,
        body: m.body,
        providerMessageId: m.providerMessageId,
        matchedAliasId: m.matchedAliasId ?? null,
        routedTo: m.routedTo ?? null,
        receivedAt: new Date(m.receivedAt),
      },
    });
    return toInboundMail(row);
  }

  async listInboundMail(query: {
    accountId: string;
    projectId?: string;
    limit?: number;
  }): Promise<InboundMail[]> {
    const rows = await this.db.inboundMail.findMany({
      where: {
        accountId: query.accountId,
        ...(query.projectId ? { projectId: query.projectId } : {}),
      },
      orderBy: { receivedAt: "desc" },
      take: query.limit ?? 100,
    });
    return rows.map(toInboundMail);
  }

  async createInboundCall(
    c: InboundCallRecord,
  ): Promise<InboundCallRecord> {
    const row = await this.db.inboundCallRecord.create({
      data: {
        id: c.id,
        accountId: c.accountId,
        projectId: c.projectId,
        toE164: c.toE164,
        fromE164: c.fromE164,
        providerCallId: c.providerCallId,
        routingAction: c.routingAction,
        receivedAt: new Date(c.receivedAt),
      },
    });
    return toInboundCall(row);
  }

  async listInboundCalls(query: {
    accountId: string;
    projectId?: string;
    limit?: number;
  }): Promise<InboundCallRecord[]> {
    const rows = await this.db.inboundCallRecord.findMany({
      where: {
        accountId: query.accountId,
        ...(query.projectId ? { projectId: query.projectId } : {}),
      },
      orderBy: { receivedAt: "desc" },
      take: query.limit ?? 100,
    });
    return rows.map(toInboundCall);
  }

  /* ----- object storage ----- */

  async createBucket(b: StorageBucket): Promise<StorageBucket> {
    const row = await this.db.storageBucket.create({
      data: {
        id: b.id,
        projectId: b.projectId,
        name: b.name,
        region: b.region,
        publicRead: b.publicRead,
        cdn: b.cdn,
        objects: b.objects,
        sizeGb: b.sizeGb,
        createdAt: new Date(b.createdAt),
      },
    });
    return toBucket(row);
  }

  async listBuckets(accountId: string): Promise<StorageBucket[]> {
    const rows = await this.db.storageBucket.findMany({
      where: { project: { accountId } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toBucket);
  }

  async listBucketsByProject(projectId: string): Promise<StorageBucket[]> {
    const rows = await this.db.storageBucket.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toBucket);
  }

  async findBucketByName(name: string): Promise<StorageBucket | null> {
    const row = await this.db.storageBucket.findUnique({ where: { name } });
    return row ? toBucket(row) : null;
  }

  async deleteBucket(id: string): Promise<boolean> {
    try {
      await this.db.storageBucket.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  /* ----- registrar ----- */

  async createRegistration(
    r: DomainRegistration,
  ): Promise<DomainRegistration> {
    const row = await this.db.domainRegistration.create({
      data: {
        id: r.id,
        hostname: r.hostname,
        tld: r.tld,
        pricePerYearCents: r.pricePerYearCents,
        expiresAt: new Date(r.expiresAt),
        whoisPrivacy: r.whoisPrivacy,
        autoRenew: r.autoRenew,
        attachedProjectId: r.attachedProjectId,
        createdAt: new Date(r.createdAt),
        // The account must already exist — connect, never auto-create a
        // placeholder. A missing account surfaces as a real FK error.
        account: { connect: { id: r.accountId } },
      },
    });
    return toRegistration(row);
  }

  async listRegistrations(accountId: string): Promise<DomainRegistration[]> {
    const rows = await this.db.domainRegistration.findMany({
      where: { accountId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toRegistration);
  }

  async findRegistrationByHostname(
    hostname: string,
  ): Promise<DomainRegistration | null> {
    const row = await this.db.domainRegistration.findUnique({
      where: { hostname },
    });
    return row ? toRegistration(row) : null;
  }

  async updateRegistration(
    id: string,
    patch: Partial<DomainRegistration>,
  ): Promise<DomainRegistration> {
    const data: Prisma.DomainRegistrationUpdateInput = {};
    if (patch.hostname !== undefined) data.hostname = patch.hostname;
    if (patch.tld !== undefined) data.tld = patch.tld;
    if (patch.pricePerYearCents !== undefined)
      data.pricePerYearCents = patch.pricePerYearCents;
    if (patch.expiresAt !== undefined)
      data.expiresAt = new Date(patch.expiresAt);
    if (patch.whoisPrivacy !== undefined) data.whoisPrivacy = patch.whoisPrivacy;
    if (patch.autoRenew !== undefined) data.autoRenew = patch.autoRenew;
    if (patch.attachedProjectId !== undefined)
      data.attachedProjectId = patch.attachedProjectId;
    const row = await this.db.domainRegistration.update({
      where: { id },
      data,
    });
    return toRegistration(row);
  }

  /* ----- agent brain journal (plan §4.9) ----- */

  async recordAgentAction(action: StoredAgentAction): Promise<void> {
    // `verified` is stored as `n_a` on disk (Postgres-safe identifier);
    // the domain shape uses the more readable `n/a`. Translate here.
    await this.db.agentAction.create({
      data: {
        proposalId: action.proposalId,
        agent: action.agent,
        kind: action.kind,
        title: action.title,
        outcome: action.outcome,
        detail: action.detail,
        verified: encodeVerified(action.verified),
        verifiedAt: action.verifiedAt ? new Date(action.verifiedAt) : null,
        verifyDetail: action.verifyDetail,
        resultProjectId: action.resultProjectId,
        at: new Date(action.at),
      },
    });
  }

  async updateAgentActionVerification(
    proposalId: string,
    verification: {
      verified: "ok" | "failed";
      verifiedAt: string;
      verifyDetail: string;
    },
  ): Promise<void> {
    try {
      await this.db.agentAction.update({
        where: { proposalId },
        data: {
          verified: encodeVerified(verification.verified),
          verifiedAt: new Date(verification.verifiedAt),
          verifyDetail: verification.verifyDetail,
        },
      });
    } catch {
      // The action may have been pruned from the journal between execute
      // and verify (extremely long delay + heavy churn). Silently drop —
      // matches the in-memory behaviour.
    }
  }

  async listAgentActions(
    opts: { limit?: number } = {},
  ): Promise<StoredAgentAction[]> {
    const rows = await this.db.agentAction.findMany({
      orderBy: { at: "desc" },
      take: opts.limit ?? 100,
    });
    // Reverse so callers get oldest-first (matches the in-memory store's
    // append-only ordering, which buildLearnings depends on for `lastAt`).
    return rows.reverse().map((r) => ({
      proposalId: r.proposalId,
      agent: r.agent,
      kind: r.kind,
      title: r.title,
      outcome: r.outcome as "ok" | "failed",
      detail: r.detail,
      verified: decodeVerified(r.verified),
      verifiedAt: r.verifiedAt?.toISOString(),
      verifyDetail: r.verifyDetail ?? undefined,
      resultProjectId: r.resultProjectId ?? undefined,
      at: r.at.toISOString(),
    }));
  }

  /* ----- durable SMS telemetry + OTP challenges (plan §4.5) ----- */

  async appendSmsEvent(e: StoredSmsEvent): Promise<void> {
    await this.db.smsEvent.create({
      data: {
        at: new Date(e.at),
        kind: e.kind,
        projectId: e.projectId,
        accountId: e.accountId,
        phoneNumberId: e.phoneNumberId,
        fromE164: e.fromE164,
        messageId: e.messageId,
        toMasked: e.toMasked,
      },
    });
  }

  async listRecentSmsEvents(limit = 1000): Promise<StoredSmsEvent[]> {
    const rows = await this.db.smsEvent.findMany({
      orderBy: { at: "desc" },
      take: limit,
    });
    // Reverse to oldest-first so the rehydrated ring matches the
    // append-only ordering the deliverability rollup expects.
    return rows.reverse().map((r) => ({
      at: r.at.toISOString(),
      kind: r.kind,
      projectId: r.projectId,
      accountId: r.accountId,
      phoneNumberId: r.phoneNumberId,
      fromE164: r.fromE164,
      messageId: r.messageId,
      toMasked: r.toMasked,
    }));
  }

  /* ----- durable mail telemetry (plan §4.4) -----
   *
   * Same posture as the SMS event store above: append-only, bounded by
   * the in-memory ring on the read side, rehydrated from the most
   * recent rows on boot. */

  async appendMailEvent(e: StoredMailEvent): Promise<void> {
    await this.db.mailEvent.create({
      data: {
        at: new Date(e.at),
        kind: e.kind,
        projectId: e.projectId,
        accountId: e.accountId,
        mailboxId: e.mailboxId,
        mailboxAddress: e.mailboxAddress,
        sendingDomain: e.sendingDomain,
        messageId: e.messageId,
        toMasked: e.toMasked,
      },
    });
  }

  async listRecentMailEvents(limit = 1000): Promise<StoredMailEvent[]> {
    const rows = await this.db.mailEvent.findMany({
      orderBy: { at: "desc" },
      take: limit,
    });
    return rows.reverse().map((r) => ({
      at: r.at.toISOString(),
      kind: r.kind,
      projectId: r.projectId,
      accountId: r.accountId,
      mailboxId: r.mailboxId,
      mailboxAddress: r.mailboxAddress,
      sendingDomain: r.sendingDomain,
      messageId: r.messageId,
      toMasked: r.toMasked,
    }));
  }

  async upsertOtpChallenge(c: StoredOtpChallenge): Promise<void> {
    const data = {
      projectId: c.projectId,
      accountId: c.accountId,
      phone: c.phone,
      phoneMasked: c.phoneMasked,
      purpose: c.purpose,
      codeHash: c.codeHash,
      createdAt: new Date(c.createdAt),
      expiresAt: new Date(c.expiresAt),
      attempts: c.attempts,
      status: c.status,
    };
    await this.db.otpChallenge.upsert({
      where: { id: c.id },
      create: { id: c.id, ...data },
      update: data,
    });
  }

  async deleteOtpChallenge(id: string): Promise<void> {
    // `deleteMany` so a missing row is a no-op (best-effort delete).
    await this.db.otpChallenge.deleteMany({ where: { id } });
  }

  async listOtpChallenges(): Promise<StoredOtpChallenge[]> {
    const rows = await this.db.otpChallenge.findMany();
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      accountId: r.accountId,
      phone: r.phone,
      phoneMasked: r.phoneMasked,
      purpose: r.purpose,
      codeHash: r.codeHash,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      attempts: r.attempts,
      status: r.status,
    }));
  }

  /* ----- Cantila Connections (plan §4.11) -----
   *  Phase A of the Automations build (see ../../plans/…) lands the
   *  Store-port shape and the in-memory implementation; the Prisma table
   *  + migration are deferred to Phase B alongside OAuth. Until then this
   *  adapter holds connections in-process so the rail compiles and the
   *  Console renders against either Store. */
  private connections = new Map<string, Connection>();

  async createConnection(c: Connection): Promise<Connection> {
    this.connections.set(c.id, c);
    return c;
  }

  async getConnection(id: string): Promise<Connection | null> {
    return this.connections.get(id) ?? null;
  }

  async listConnections(accountId: string): Promise<Connection[]> {
    return [...this.connections.values()]
      .filter((c) => c.accountId === accountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updateConnection(
    id: string,
    patch: Partial<Connection>,
  ): Promise<Connection> {
    const existing = this.connections.get(id);
    if (!existing) throw new Error(`connection not found: ${id}`);
    const updated: Connection = { ...existing, ...patch, id: existing.id };
    this.connections.set(id, updated);
    return updated;
  }

  async deleteConnection(id: string): Promise<boolean> {
    return this.connections.delete(id);
  }

  /* ----- Cantila Automations — execution history (plan §15.5 Phase F) -----
   *  Same in-memory posture as Connection above: the Prisma table for
   *  workflow executions lands when the Connections migration does.
   *  Behaviour and lifecycle are otherwise identical to the in-memory
   *  store so the Console gets a consistent picture across stores. */
  private workflowExecutions = new Map<string, WorkflowExecutionRecord>();

  async createWorkflowExecution(
    r: WorkflowExecutionRecord,
  ): Promise<WorkflowExecutionRecord> {
    this.workflowExecutions.set(r.id, { ...r, events: [...r.events] });
    return r;
  }

  async appendExecutionEvent(
    executionId: string,
    event: WorkflowExecutionEvent,
  ): Promise<void> {
    const existing = this.workflowExecutions.get(executionId);
    if (!existing) return;
    existing.events = [...existing.events, event];
    this.workflowExecutions.set(executionId, existing);
  }

  async updateWorkflowExecution(
    executionId: string,
    patch: Partial<
      Pick<
        WorkflowExecutionRecord,
        "status" | "finishedAt" | "nodeStates" | "error"
      >
    >,
  ): Promise<WorkflowExecutionRecord | null> {
    const existing = this.workflowExecutions.get(executionId);
    if (!existing) return null;
    const updated: WorkflowExecutionRecord = { ...existing, ...patch };
    this.workflowExecutions.set(executionId, updated);
    return updated;
  }

  async getWorkflowExecution(
    executionId: string,
  ): Promise<WorkflowExecutionRecord | null> {
    return this.workflowExecutions.get(executionId) ?? null;
  }

  async listWorkflowExecutions(query: {
    automationId: string;
    workflowId?: string;
    limit?: number;
  }): Promise<WorkflowExecutionRecord[]> {
    const limit = query.limit ?? 50;
    return [...this.workflowExecutions.values()]
      .filter(
        (r) =>
          r.automationId === query.automationId &&
          (query.workflowId === undefined || r.workflowId === query.workflowId),
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  /* ----- Cantila Connections — credential-binding audit (plan §15.5 Phase F) ----- */

  private connectionAudits: ConnectionAuditEvent[] = [];

  async recordConnectionAudit(
    e: ConnectionAuditEvent,
  ): Promise<ConnectionAuditEvent> {
    this.connectionAudits.push(e);
    if (this.connectionAudits.length > 2000) {
      this.connectionAudits = this.connectionAudits.slice(-2000);
    }
    return e;
  }

  async listConnectionAudits(query: {
    accountId: string;
    connectionId?: string;
    limit?: number;
  }): Promise<ConnectionAuditEvent[]> {
    const limit = query.limit ?? 100;
    return this.connectionAudits
      .filter(
        (e) =>
          e.accountId === query.accountId &&
          (query.connectionId === undefined ||
            e.connectionId === query.connectionId),
      )
      .slice()
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
  }

  /* ----- multi-conversation chat history (conversations design 2026-05-30) ----- */

  async createConversation(c: Conversation): Promise<Conversation> {
    const row = await this.db.conversation.create({
      data: {
        id: c.id,
        projectId: c.projectId,
        title: c.title,
        createdAt: new Date(c.createdAt),
        updatedAt: new Date(c.updatedAt),
      },
    });
    return toConversation(row);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const row = await this.db.conversation.findUnique({ where: { id } });
    return row ? toConversation(row) : null;
  }

  async listConversations(projectId: string): Promise<Conversation[]> {
    const rows = await this.db.conversation.findMany({
      where: { projectId },
      // Most-recently-active first; tie-break on createdAt desc so the
      // ordering is stable even when two threads share a timestamp.
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
    return rows.map(toConversation);
  }

  async updateConversation(
    id: string,
    patch: Partial<Conversation>,
  ): Promise<Conversation> {
    const row = await this.db.conversation.update({
      where: { id },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        // Bump updatedAt explicitly when asked; otherwise Prisma's
        // @updatedAt handles it on any write.
        ...(patch.updatedAt !== undefined
          ? { updatedAt: new Date(patch.updatedAt) }
          : {}),
      },
    });
    return toConversation(row);
  }

  async deleteConversation(id: string): Promise<boolean> {
    // ProjectMessage.conversationId declares onDelete: Cascade, so deleting
    // the conversation row removes its messages too.
    try {
      await this.db.conversation.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async createChatMessage(
    m: ProjectChatMessage,
  ): Promise<ProjectChatMessage> {
    const row = await this.db.projectMessage.create({
      data: {
        id: m.id,
        projectId: m.projectId,
        conversationId: m.conversationId ?? null,
        role: m.role,
        agent: m.agent ?? null,
        kind: m.kind,
        content: m.content,
        metadata: (m.metadata ?? null) as Prisma.InputJsonValue,
        createdAt: new Date(m.createdAt),
      },
    });
    return toChatMessage(row);
  }

  async listChatMessages(
    conversationId: string,
  ): Promise<ProjectChatMessage[]> {
    const rows = await this.db.projectMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toChatMessage);
  }

  async listChatMessagesByProject(
    projectId: string,
  ): Promise<ProjectChatMessage[]> {
    const rows = await this.db.projectMessage.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toChatMessage);
  }

  async attachNullMessagesToConversation(
    projectId: string,
    conversationId: string,
  ): Promise<number> {
    const res = await this.db.projectMessage.updateMany({
      where: { projectId, conversationId: null },
      data: { conversationId },
    });
    return res.count;
  }

  /* ----- platform audit log (super-user management, slice 1) ----- */

  async recordAuditLog(e: AuditLog): Promise<AuditLog> {
    const row = await this.db.auditLog.create({
      data: {
        id: e.id,
        actorUserId: e.actorUserId,
        actorEmail: e.actorEmail,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        accountId: e.accountId,
        metadata: e.metadata as object,
        ip: e.ip,
        createdAt: new Date(e.createdAt),
      },
    });
    return toAuditLog(row);
  }

  async listAuditLogs(query: {
    actorUserId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    limit?: number;
  }): Promise<AuditLog[]> {
    const rows = await this.db.auditLog.findMany({
      where: {
        actorUserId: query.actorUserId,
        action: query.action,
        targetType: query.targetType,
        targetId: query.targetId,
      },
      orderBy: { createdAt: "desc" },
      take: query.limit ?? 100,
    });
    return rows.map(toAuditLog);
  }
}

function toConversation(r: DbConversation): Conversation {
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toChatMessage(r: DbProjectMessage): ProjectChatMessage {
  return {
    id: r.id,
    projectId: r.projectId,
    conversationId: r.conversationId ?? null,
    role: r.role as ProjectMessageRole,
    agent: r.agent ?? undefined,
    kind: r.kind as ProjectMessageKind,
    content: r.content,
    metadata:
      (r.metadata as Record<string, unknown> | null) ?? undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

function encodeVerified(v: StoredAgentAction["verified"]): string {
  return v === "n/a" ? "n_a" : v;
}
function decodeVerified(v: string): StoredAgentAction["verified"] {
  if (v === "n_a") return "n/a";
  if (v === "pending" || v === "ok" || v === "failed") return v;
  return "n/a";
}

function toEvent(r: DbActivityEvent): ActivityEvent {
  return {
    id: r.id,
    accountId: r.accountId,
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    projectId: r.projectId ?? undefined,
    actorAccountId: (r as { actorAccountId?: string | null }).actorAccountId ?? undefined,
    at: r.at.toISOString(),
  };
}

function toInboundMessage(r: DbInboundMessage): InboundMessage {
  return {
    id: r.id,
    accountId: r.accountId,
    projectId: r.projectId,
    toE164: r.toE164,
    fromE164: r.fromE164,
    body: r.body,
    keyword: (r.keyword ?? undefined) as InboundMessage["keyword"],
    providerMessageId: r.providerMessageId,
    receivedAt: r.receivedAt.toISOString(),
  };
}

function toInboundMail(r: DbInboundMail): InboundMail {
  return {
    id: r.id,
    accountId: r.accountId,
    projectId: r.projectId,
    toAddress: r.toAddress,
    fromAddress: r.fromAddress,
    subject: r.subject,
    body: r.body,
    providerMessageId: r.providerMessageId,
    matchedAliasId: r.matchedAliasId ?? undefined,
    routedTo: r.routedTo ?? undefined,
    receivedAt: r.receivedAt.toISOString(),
  };
}

function toInboundCall(r: DbInboundCallRecord): InboundCallRecord {
  return {
    id: r.id,
    accountId: r.accountId,
    projectId: r.projectId,
    toE164: r.toE164,
    fromE164: r.fromE164,
    providerCallId: r.providerCallId,
    routingAction: r.routingAction as InboundCallRecord["routingAction"],
    receivedAt: r.receivedAt.toISOString(),
  };
}

function toBucket(r: DbStorageBucket): StorageBucket {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    region: r.region,
    publicRead: r.publicRead,
    cdn: r.cdn,
    objects: r.objects,
    sizeGb: r.sizeGb,
    createdAt: r.createdAt.toISOString(),
  };
}

function toRegistration(r: DbDomainRegistration): DomainRegistration {
  return {
    id: r.id,
    accountId: r.accountId,
    hostname: r.hostname,
    tld: r.tld,
    pricePerYearCents: r.pricePerYearCents,
    expiresAt: r.expiresAt.toISOString(),
    whoisPrivacy: r.whoisPrivacy,
    autoRenew: r.autoRenew,
    attachedProjectId: r.attachedProjectId ?? undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

function toApiKey(r: DbApiKey): ApiKey {
  return {
    id: r.id,
    accountId: r.accountId,
    name: r.name,
    scope: r.scope,
    prefix: r.prefix,
    hash: r.hashedKey,
    lastUsedAt: r.lastUsedAt?.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}

function toAuthUser(r: DbUser): AuthUser {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    passwordHash: r.passwordHash ?? undefined,
    twoFactorEnabled: r.twoFactorEnabled,
    accountId: r.accountId ?? undefined,
    avatarUrl: r.avatarUrl ?? undefined,
    platformRole: (r.platformRole ?? undefined) as AuthUser["platformRole"],
    emailVerifiedAt: r.emailVerifiedAt?.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}

function toAuditLog(r: DbAuditLog): AuditLog {
  return {
    id: r.id,
    actorUserId: r.actorUserId,
    actorEmail: r.actorEmail,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId ?? undefined,
    accountId: r.accountId ?? undefined,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    ip: r.ip ?? undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

function toSession(r: DbSession): Session {
  return {
    id: r.id,
    userId: r.userId,
    tokenHash: r.tokenHash,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    // Plan §18 — Option B: per-session active account. The migration
    // `20260525240000_add_session_current_account` adds this column;
    // the generated Prisma client must be regenerated for `r.currentAccountId`
    // to be typed (TS may complain until then). Null/undefined = unscoped.
    currentAccountId: (r as DbSession & { currentAccountId?: string | null })
      .currentAccountId ?? undefined,
  };
}

function toMembership(r: DbMembership): Membership {
  // Plan §18 — Option B multi-org tenancy. The `Membership` model already
  // exists in schema.prisma (id, userId, accountId, role, createdAt).
  return {
    id: r.id,
    userId: r.userId,
    accountId: r.accountId,
    role: r.role as MemberRole,
    createdAt: r.createdAt.toISOString(),
  };
}

function toInvite(r: DbInvite): Invite {
  return {
    id: r.id,
    accountId: r.accountId,
    email: r.email,
    role: r.role,
    tokenHash: r.tokenHash,
    status: r.status as InviteStatus,
    invitedByUserId: r.invitedByUserId ?? undefined,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    acceptedAt: r.acceptedAt?.toISOString(),
    acceptedByUserId: r.acceptedByUserId ?? undefined,
  };
}

function toAccount(r: DbAccount): Account {
  // Plan §5.5 — branding columns. Read defensively from `r` so the
  // mapper survives a build against an older Prisma client (before
  // the 20260526020000_add_account_branding migration is generated).
  const rb = r as DbAccount & {
    brandPrimaryColor?: string | null;
    brandAccentColor?: string | null;
    brandLogoUrl?: string | null;
    brandDisplayName?: string | null;
    billedToAccountId?: string | null;
  };
  return {
    id: r.id,
    name: r.name,
    handle: r.handle,
    plan: r.plan,
    parentAccountId: r.parentAccountId ?? undefined,
    stripeCustomerId: r.stripeCustomerId ?? undefined,
    stripeSubscriptionId: r.stripeSubscriptionId ?? undefined,
    anthropicApiKey: r.anthropicApiKey ?? undefined,
    billingStatus: r.billingStatus,
    dunningAttempts: r.dunningAttempts,
    dunningFailedAt: r.dunningFailedAt?.toISOString(),
    dunningGraceEndsAt: r.dunningGraceEndsAt?.toISOString(),
    brandPrimaryColor: rb.brandPrimaryColor ?? undefined,
    brandAccentColor: rb.brandAccentColor ?? undefined,
    brandLogoUrl: rb.brandLogoUrl ?? undefined,
    brandDisplayName: rb.brandDisplayName ?? undefined,
    billedToAccountId: rb.billedToAccountId ?? undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

function toBackup(r: DbBackup): Backup {
  return {
    id: r.id,
    projectId: r.projectId,
    accountId: r.accountId,
    deploymentId: r.deploymentId,
    envVars: (r.envVarsJson ?? []) as Backup["envVars"],
    databaseSnapshotId: r.databaseSnapshotId ?? null,
    note: r.note ?? undefined,
    trigger: r.trigger === "auto_pre_deploy" ? "auto-pre-deploy" : "manual",
    createdAt: r.createdAt.toISOString(),
  };
}
