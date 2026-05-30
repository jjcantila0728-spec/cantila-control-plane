/* ============================================================
   Persistence port + in-memory implementation.
   The scaffold runs on InMemoryStore so no Postgres is needed.
   A Prisma-backed Store (against prisma/schema.prisma) is the
   production implementation and a drop-in replacement.
   ============================================================ */

import type {
  Account,
  Project,
  ManagedDatabase,
  Mailbox,
  HostedMailbox,
  MailAlias,
  MailIpPool,
  PhoneNumber,
  A2pRegistration,
  MarketplaceNumber,
  Node,
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
  Membership,
  Connection,
  ConnectionAuditEvent,
  WorkflowExecutionRecord,
  WorkflowExecutionEvent,
} from "./types";

/** Durable shape of one entry in the agent brain's action journal (plan
 *  §4.9 — continuous learning). Structurally compatible with
 *  `ActionRecord` in `../agents/types.ts`, but declared here with `string`
 *  agent/kind so the Store layer doesn't pull a dependency on the agents
 *  layer. The brain casts between the two at the persistence boundary. */
export interface StoredAgentAction {
  at: string;
  proposalId: string;
  agent: string;
  kind: string;
  title: string;
  outcome: "ok" | "failed";
  detail: string;
  verified: "n/a" | "pending" | "ok" | "failed";
  verifiedAt?: string;
  verifyDetail?: string;
  resultProjectId?: string;
}

/** Durable shape of one SMS telemetry event (plan §4.5). Structurally
 *  compatible with `SmsEventRecord` in `core/control-plane.ts`; declared
 *  here with a `string` kind so the Store layer carries no dependency on
 *  the control-plane module. The control plane casts at the boundary. */
export interface StoredSmsEvent {
  at: string;
  kind: string;
  projectId: string;
  accountId: string;
  phoneNumberId: string;
  fromE164: string;
  messageId: string;
  toMasked: string;
}

/** Durable shape of one mail telemetry event (plan §4.4). Structurally
 *  compatible with `MailEventRecord` in `core/control-plane.ts`; the
 *  Store layer keeps `kind` as a loose `string` so it carries no
 *  dependency on the control-plane module — the control plane casts at
 *  the persistence boundary. */
export interface StoredMailEvent {
  at: string;
  kind: string;
  projectId: string;
  accountId: string;
  mailboxId: string;
  mailboxAddress: string;
  sendingDomain: string;
  messageId: string;
  toMasked: string;
}

/** Durable shape of one OTP challenge (plan §4.5). Structurally
 *  compatible with `OtpChallenge` in `auth/otp.ts`; `purpose` / `status`
 *  are `string` here so the Store layer stays decoupled. */
export interface StoredOtpChallenge {
  id: string;
  projectId: string;
  accountId: string;
  phone: string;
  phoneMasked: string;
  purpose: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  attempts: number;
  status: string;
}

export interface Store {
  /* ----- accounts (plan §5.4 — multi-tenant tenant root) ----- */

  createAccount(a: Account): Promise<Account>;
  getAccount(id: string): Promise<Account | null>;
  findAccountByHandle(handle: string): Promise<Account | null>;
  findAccountByStripeCustomer(customerId: string): Promise<Account | null>;
  listAccounts(): Promise<Account[]>;
  /** Sub-accounts under an agency / reseller parent (plan §5.5 —
   *  white-label). Returns `[]` for an account with no children. */
  listChildAccounts(parentAccountId: string): Promise<Account[]>;
  countAccounts(): Promise<number>;
  /** Partial update — used by the Stripe rail to set `stripeCustomerId`
   *  after `createCustomer` succeeds, and to flip `plan` +
   *  `stripeSubscriptionId` when a `checkout.session.completed` webhook
   *  arrives. Returns the updated row. */
  updateAccount(id: string, patch: Partial<Account>): Promise<Account>;

  createProject(p: Project): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  updateProject(id: string, patch: Partial<Project>): Promise<Project>;
  listProjects(accountId: string): Promise<Project[]>;
  /** Delete a project and every FK-related row (database, mailbox,
   *  domains, env vars, deployments, phone number). Returns false when
   *  the project doesn't exist. */
  deleteProject(id: string): Promise<boolean>;

  getDatabaseByProject(projectId: string): Promise<ManagedDatabase | null>;
  createDatabase(d: ManagedDatabase): Promise<ManagedDatabase>;
  /** Delete a project's managed database row. Returns false when none. */
  deleteDatabase(projectId: string): Promise<boolean>;

  getMailboxByProject(projectId: string): Promise<Mailbox | null>;
  createMailbox(m: Mailbox): Promise<Mailbox>;

  /* ----- hosted mailboxes (plan §4.4 — real inboxes, many per project) ----- */

  createHostedMailbox(m: HostedMailbox): Promise<HostedMailbox>;
  listHostedMailboxesByProject(projectId: string): Promise<HostedMailbox[]>;
  listHostedMailboxes(accountId: string): Promise<HostedMailbox[]>;
  getHostedMailbox(id: string): Promise<HostedMailbox | null>;
  findHostedMailboxByAddress(address: string): Promise<HostedMailbox | null>;
  deleteHostedMailbox(id: string): Promise<boolean>;

  /* ----- mail aliases (plan §4.4 — routing rules) ----- */

  createMailAlias(a: MailAlias): Promise<MailAlias>;
  listMailAliasesByProject(projectId: string): Promise<MailAlias[]>;
  listMailAliases(accountId: string): Promise<MailAlias[]>;
  getMailAlias(id: string): Promise<MailAlias | null>;
  findMailAliasByAddress(address: string): Promise<MailAlias | null>;
  updateMailAlias(id: string, patch: Partial<MailAlias>): Promise<MailAlias>;
  deleteMailAlias(id: string): Promise<boolean>;

  /* ----- mail IP pools (plan §4.4 — IP-pool rotation) ----- */

  createMailIpPool(p: MailIpPool): Promise<MailIpPool>;
  listMailIpPools(accountId: string): Promise<MailIpPool[]>;
  getMailIpPool(id: string): Promise<MailIpPool | null>;
  updateMailIpPool(id: string, patch: Partial<MailIpPool>): Promise<MailIpPool>;
  deleteMailIpPool(id: string): Promise<boolean>;

  /* ----- number marketplace (plan §4.5) ----- */
  createMarketplaceNumber(n: MarketplaceNumber): Promise<MarketplaceNumber>;
  listMarketplaceNumbers(accountId: string): Promise<MarketplaceNumber[]>;
  getMarketplaceNumber(id: string): Promise<MarketplaceNumber | null>;
  findMarketplaceNumberByE164(
    e164: string,
  ): Promise<MarketplaceNumber | null>;
  updateMarketplaceNumber(
    id: string,
    patch: Partial<MarketplaceNumber>,
  ): Promise<MarketplaceNumber>;

  /* ----- compute nodes (plan §5.5 — Bring-Your-Own-VPS) ----- */

  createNode(n: Node): Promise<Node>;
  getNode(id: string): Promise<Node | null>;
  listNodes(accountId: string): Promise<Node[]>;
  listAllNodes(): Promise<Node[]>;
  updateNode(id: string, patch: Partial<Node>): Promise<Node>;
  findNodeByEnrollmentTokenHash(hash: string): Promise<Node | null>;

  /* ----- A2P/10DLC carrier registration (plan §4.5) ----- */

  createA2pRegistration(r: A2pRegistration): Promise<A2pRegistration>;
  listA2pRegistrations(accountId: string): Promise<A2pRegistration[]>;
  getA2pRegistration(id: string): Promise<A2pRegistration | null>;
  updateA2pRegistration(
    id: string,
    patch: Partial<A2pRegistration>,
  ): Promise<A2pRegistration>;

  getPhoneNumberByProject(projectId: string): Promise<PhoneNumber | null>;
  createPhoneNumber(n: PhoneNumber): Promise<PhoneNumber>;
  updatePhoneNumber(
    projectId: string,
    patch: Partial<PhoneNumber>,
  ): Promise<PhoneNumber>;
  /** Remove a project's SMS number — used by `deactivateSms`. */
  deletePhoneNumber(projectId: string): Promise<void>;

  listEnvVars(projectId: string): Promise<EnvVar[]>;
  upsertEnvVar(v: EnvVar): Promise<EnvVar>;
  /** Delete a project env var by key (all scopes) — used by `deactivateSms`. */
  deleteEnvVar(projectId: string, key: string): Promise<void>;

  createDeployment(d: Deployment): Promise<Deployment>;
  updateDeployment(id: string, patch: Partial<Deployment>): Promise<Deployment>;
  listDeployments(projectId: string): Promise<Deployment[]>;

  listDomains(projectId: string): Promise<Domain[]>;
  createDomain(d: Domain): Promise<Domain>;
  findDomainByHostname(hostname: string): Promise<Domain | null>;

  createApiKey(k: ApiKey): Promise<ApiKey>;
  listApiKeys(accountId: string): Promise<ApiKey[]>;
  findApiKeyByHash(hash: string): Promise<ApiKey | null>;
  findApiKeyById(id: string): Promise<ApiKey | null>;
  /** Total keys across every account — backs the bootstrap window. */
  countApiKeys(): Promise<number>;
  touchApiKey(id: string, at: string): Promise<void>;
  deleteApiKey(id: string): Promise<boolean>;

  /* ----- team (plan §5.5) ----- */

  listMembers(accountId: string): Promise<TeamMember[]>;
  /** Idempotent on (accountId, email) — if the user already exists by
   *  email they're attached to this account at the requested role. */
  addMember(input: {
    accountId: string;
    email: string;
    name: string;
    role: MemberRole;
  }): Promise<TeamMember>;
  updateMemberRole(membershipId: string, role: MemberRole): Promise<TeamMember>;
  removeMember(membershipId: string): Promise<boolean>;

  /* ----- per-user auth: users & sessions (plan §5.4) ----- */

  findUserByEmail(email: string): Promise<AuthUser | null>;
  getUser(id: string): Promise<AuthUser | null>;
  createUser(u: AuthUser): Promise<AuthUser>;
  /** Replace a user's password hash. Used by the admin reset endpoint
   *  (plan §5.4 follow-up); the real /forgot flow will use the same
   *  store call once email delivery is live. */
  updateUserPassword(userId: string, passwordHash: string): Promise<AuthUser>;
  /** Mark a user's email as verified (plan §5.4 / v1.18 — email-verify
   *  one-shot token flow). Idempotent — re-verifying simply overwrites
   *  the timestamp. */
  setUserEmailVerifiedAt(
    userId: string,
    verifiedAt: string,
  ): Promise<AuthUser>;
  /** Set a user's avatar URL (captured from a social IdP at sign-in).
   *  Idempotent. */
  setUserAvatarUrl(userId: string, avatarUrl: string): Promise<AuthUser>;
  createSession(s: Session): Promise<Session>;
  findSessionByTokenHash(tokenHash: string): Promise<Session | null>;
  deleteSession(id: string): Promise<boolean>;
  /** Delete every session for a user (e.g. on password change). Returns
   *  the number removed. */
  deleteSessionsByUser(userId: string): Promise<number>;

  /* ----- invites (plan §5.4 — per-user invite flow) -----
   *  The one-time accept link binds a new user to the inviting account
   *  instead of the bootstrap account, replacing the "every new user
   *  joins acc_[0]" prototype hack. */

  createInvite(i: Invite): Promise<Invite>;
  getInvite(id: string): Promise<Invite | null>;
  findInviteByTokenHash(tokenHash: string): Promise<Invite | null>;
  findPendingInviteByAccountAndEmail(
    accountId: string,
    email: string,
  ): Promise<Invite | null>;
  listInvitesByAccount(accountId: string): Promise<Invite[]>;
  updateInvite(id: string, patch: Partial<Invite>): Promise<Invite>;

  /* ----- memberships (plan §18 — Option B multi-org tenancy) ----- */

  createMembership(m: Membership): Promise<Membership>;
  /** Find an existing membership for (user, account); idempotency check. */
  findMembership(
    userId: string,
    accountId: string,
  ): Promise<Membership | null>;
  /** List every org the user belongs to (newest first). */
  listMembershipsByUser(userId: string): Promise<Membership[]>;
  /** List every member of an account (for the team page). */
  listMembershipsByAccount(accountId: string): Promise<Membership[]>;
  /** Drop a membership (leave-org / remove-member). */
  deleteMembership(id: string): Promise<boolean>;

  /** Update a session's `currentAccountId` (plan §18 — switch-org). */
  setSessionCurrentAccount(
    sessionId: string,
    accountId: string | null,
  ): Promise<Session>;

  /* ----- activity feed (plan §4.8) ----- */

  recordEvent(e: ActivityEvent): Promise<ActivityEvent>;
  listEvents(
    accountId: string,
    opts?: { limit?: number },
  ): Promise<ActivityEvent[]>;

  /* ----- inbound SMS message history (plan §4.5 — two-way SMS) ----- */

  createInboundMessage(m: InboundMessage): Promise<InboundMessage>;
  listInboundMessages(query: {
    accountId: string;
    projectId?: string;
    limit?: number;
  }): Promise<InboundMessage[]>;

  createInboundCall(c: InboundCallRecord): Promise<InboundCallRecord>;
  listInboundCalls(query: {
    accountId: string;
    projectId?: string;
    limit?: number;
  }): Promise<InboundCallRecord[]>;

  /* ----- inbound mail history (plan §4.4 — two-way mail) ----- */

  createInboundMail(m: InboundMail): Promise<InboundMail>;
  listInboundMail(query: {
    accountId: string;
    projectId?: string;
    limit?: number;
  }): Promise<InboundMail[]>;

  /* ----- object storage (plan §4.6) ----- */

  createBucket(b: StorageBucket): Promise<StorageBucket>;
  listBuckets(accountId: string): Promise<StorageBucket[]>;
  listBucketsByProject(projectId: string): Promise<StorageBucket[]>;
  findBucketByName(name: string): Promise<StorageBucket | null>;
  deleteBucket(id: string): Promise<boolean>;

  /* ----- backups (plan §5.5) ----- */

  createBackup(b: Backup): Promise<Backup>;
  listBackups(projectId: string): Promise<Backup[]>;
  getBackup(id: string): Promise<Backup | null>;
  deleteBackup(id: string): Promise<boolean>;

  /* ----- registrar (plan §4.7) ----- */

  createRegistration(r: DomainRegistration): Promise<DomainRegistration>;
  listRegistrations(accountId: string): Promise<DomainRegistration[]>;
  findRegistrationByHostname(
    hostname: string,
  ): Promise<DomainRegistration | null>;
  updateRegistration(
    id: string,
    patch: Partial<DomainRegistration>,
  ): Promise<DomainRegistration>;

  /* ----- agent brain journal (plan §4.9 — continuous learning) ----- */

  /** Persist one action record. Append-only. */
  recordAgentAction(action: StoredAgentAction): Promise<void>;
  /** Update an action's verification fields after the post-check runs.
   *  No-op when no action with `proposalId` exists. */
  updateAgentActionVerification(
    proposalId: string,
    verification: {
      verified: "ok" | "failed";
      verifiedAt: string;
      verifyDetail: string;
    },
  ): Promise<void>;
  /** Load the most recent N action records, newest first. The brain
   *  calls this on `start()` to rebuild its in-memory ring so the
   *  learning loop survives process restarts. */
  listAgentActions(opts?: { limit?: number }): Promise<StoredAgentAction[]>;

  /* ----- durable SMS telemetry + OTP challenges (plan §4.5) -----
   *  The control plane keeps fast in-memory rings/maps for these; these
   *  methods persist them so they survive a process restart. Durability
   *  is real only with a Prisma-backed Store — `InMemoryStore` keeps its
   *  own arrays, which themselves do not outlive the process. */

  appendSmsEvent(e: StoredSmsEvent): Promise<void>;
  listRecentSmsEvents(limit?: number): Promise<StoredSmsEvent[]>;

  appendMailEvent(e: StoredMailEvent): Promise<void>;
  listRecentMailEvents(limit?: number): Promise<StoredMailEvent[]>;

  upsertOtpChallenge(c: StoredOtpChallenge): Promise<void>;
  deleteOtpChallenge(id: string): Promise<void>;
  listOtpChallenges(): Promise<StoredOtpChallenge[]>;

  /* ----- Cantila Connections (plan §4.11) -----
   *  Account-wide stored credentials for external providers. The row
   *  carries metadata only; the raw secret lives behind `secretRef` in
   *  the secrets manager. */

  createConnection(c: Connection): Promise<Connection>;
  getConnection(id: string): Promise<Connection | null>;
  listConnections(accountId: string): Promise<Connection[]>;
  updateConnection(id: string, patch: Partial<Connection>): Promise<Connection>;
  deleteConnection(id: string): Promise<boolean>;

  /* ----- Cantila Automations — execution history (plan §4.10 / §15.5 Phase F) -----
   *  Persisted run records the Console reads to populate the "Runs" list
   *  + Replay button. Append-only — only the events array, status and
   *  finishedAt mutate after the row lands. */

  createWorkflowExecution(
    r: WorkflowExecutionRecord,
  ): Promise<WorkflowExecutionRecord>;
  appendExecutionEvent(
    executionId: string,
    event: WorkflowExecutionEvent,
  ): Promise<void>;
  /** Patch a captured run's terminal fields. Idempotent — applying the
   *  same patch twice is a no-op. */
  updateWorkflowExecution(
    executionId: string,
    patch: Partial<
      Pick<WorkflowExecutionRecord, "status" | "finishedAt" | "nodeStates" | "error">
    >,
  ): Promise<WorkflowExecutionRecord | null>;
  getWorkflowExecution(
    executionId: string,
  ): Promise<WorkflowExecutionRecord | null>;
  listWorkflowExecutions(query: {
    automationId: string;
    workflowId?: string;
    limit?: number;
  }): Promise<WorkflowExecutionRecord[]>;

  /* ----- Cantila Connections — credential-binding audit (plan §4.11 / §15.5 Phase F) ----- */

  recordConnectionAudit(e: ConnectionAuditEvent): Promise<ConnectionAuditEvent>;
  listConnectionAudits(query: {
    accountId: string;
    connectionId?: string;
    limit?: number;
  }): Promise<ConnectionAuditEvent[]>;
}

export class InMemoryStore implements Store {
  private accounts = new Map<string, Account>();

  async createAccount(a: Account): Promise<Account> {
    this.accounts.set(a.id, a);
    return a;
  }

  async getAccount(id: string): Promise<Account | null> {
    return this.accounts.get(id) ?? null;
  }

  async findAccountByHandle(handle: string): Promise<Account | null> {
    const wanted = handle.toLowerCase();
    return (
      [...this.accounts.values()].find((a) => a.handle === wanted) ?? null
    );
  }

  async findAccountByStripeCustomer(
    customerId: string,
  ): Promise<Account | null> {
    return (
      [...this.accounts.values()].find(
        (a) => a.stripeCustomerId === customerId,
      ) ?? null
    );
  }

  async listAccounts(): Promise<Account[]> {
    return [...this.accounts.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  async listChildAccounts(parentAccountId: string): Promise<Account[]> {
    return [...this.accounts.values()]
      .filter((a) => a.parentAccountId === parentAccountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async countAccounts(): Promise<number> {
    return this.accounts.size;
  }

  async updateAccount(id: string, patch: Partial<Account>): Promise<Account> {
    const existing = this.accounts.get(id);
    if (!existing) throw new Error(`account not found: ${id}`);
    const updated: Account = { ...existing, ...patch, id: existing.id };
    this.accounts.set(id, updated);
    return updated;
  }

  private projects = new Map<string, Project>();
  private databases = new Map<string, ManagedDatabase>(); // keyed by projectId
  private mailboxes = new Map<string, Mailbox>(); //          keyed by projectId
  private phoneNumbers = new Map<string, PhoneNumber>(); //   keyed by projectId
  private envVars = new Map<string, EnvVar>(); //             keyed by id
  private deployments = new Map<string, Deployment>(); //     keyed by id
  private domains = new Map<string, Domain>(); //              keyed by id

  async createProject(p: Project): Promise<Project> {
    this.projects.set(p.id, p);
    return p;
  }

  async listProjects(accountId: string): Promise<Project[]> {
    return [...this.projects.values()].filter(
      (p) => p.accountId === accountId && !p.platform,
    );
  }

  async getProject(id: string): Promise<Project | null> {
    return this.projects.get(id) ?? null;
  }

  async updateProject(id: string, patch: Partial<Project>): Promise<Project> {
    const existing = this.projects.get(id);
    if (!existing) throw new Error(`project not found: ${id}`);
    const updated: Project = { ...existing, ...patch, id: existing.id };
    this.projects.set(id, updated);
    return updated;
  }

  async deleteProject(id: string): Promise<boolean> {
    if (!this.projects.has(id)) return false;
    // Cascade every project-scoped collection — mirrors the Prisma
    // schema's `onDelete: Cascade` so both stores behave identically.
    this.projects.delete(id);
    this.databases.delete(id);
    this.mailboxes.delete(id);
    this.phoneNumbers.delete(id);
    for (const [mapId, v] of this.envVars) {
      if (v.projectId === id) this.envVars.delete(mapId);
    }
    for (const [mapId, d] of this.deployments) {
      if (d.projectId === id) this.deployments.delete(mapId);
    }
    for (const [mapId, d] of this.domains) {
      if (d.projectId === id) this.domains.delete(mapId);
    }
    for (const [mapId, m] of this.hostedMailboxes) {
      if (m.projectId === id) this.hostedMailboxes.delete(mapId);
    }
    for (const [mapId, a] of this.mailAliases) {
      if (a.projectId === id) this.mailAliases.delete(mapId);
    }
    return true;
  }

  async getDatabaseByProject(
    projectId: string,
  ): Promise<ManagedDatabase | null> {
    return this.databases.get(projectId) ?? null;
  }

  async createDatabase(d: ManagedDatabase): Promise<ManagedDatabase> {
    this.databases.set(d.projectId, d);
    return d;
  }

  async deleteDatabase(projectId: string): Promise<boolean> {
    return this.databases.delete(projectId);
  }

  async getMailboxByProject(projectId: string): Promise<Mailbox | null> {
    return this.mailboxes.get(projectId) ?? null;
  }

  async createMailbox(m: Mailbox): Promise<Mailbox> {
    this.mailboxes.set(m.projectId, m);
    return m;
  }

  /* ----- hosted mailboxes (plan §4.4) ----- */

  private hostedMailboxes = new Map<string, HostedMailbox>(); // keyed by id

  async createHostedMailbox(m: HostedMailbox): Promise<HostedMailbox> {
    this.hostedMailboxes.set(m.id, m);
    return m;
  }

  async listHostedMailboxesByProject(
    projectId: string,
  ): Promise<HostedMailbox[]> {
    return [...this.hostedMailboxes.values()]
      .filter((m) => m.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listHostedMailboxes(accountId: string): Promise<HostedMailbox[]> {
    const result: HostedMailbox[] = [];
    for (const m of this.hostedMailboxes.values()) {
      if (this.projects.get(m.projectId)?.accountId === accountId) {
        result.push(m);
      }
    }
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getHostedMailbox(id: string): Promise<HostedMailbox | null> {
    return this.hostedMailboxes.get(id) ?? null;
  }

  async findHostedMailboxByAddress(
    address: string,
  ): Promise<HostedMailbox | null> {
    const wanted = address.trim().toLowerCase();
    return (
      [...this.hostedMailboxes.values()].find((m) => m.address === wanted) ??
      null
    );
  }

  async deleteHostedMailbox(id: string): Promise<boolean> {
    return this.hostedMailboxes.delete(id);
  }

  /* ----- mail aliases (plan §4.4) ----- */

  private mailAliases = new Map<string, MailAlias>(); // keyed by id

  async createMailAlias(a: MailAlias): Promise<MailAlias> {
    this.mailAliases.set(a.id, a);
    return a;
  }

  async listMailAliasesByProject(projectId: string): Promise<MailAlias[]> {
    return [...this.mailAliases.values()]
      .filter((a) => a.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listMailAliases(accountId: string): Promise<MailAlias[]> {
    const result: MailAlias[] = [];
    for (const a of this.mailAliases.values()) {
      if (this.projects.get(a.projectId)?.accountId === accountId) {
        result.push(a);
      }
    }
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getMailAlias(id: string): Promise<MailAlias | null> {
    return this.mailAliases.get(id) ?? null;
  }

  async findMailAliasByAddress(address: string): Promise<MailAlias | null> {
    const wanted = address.trim().toLowerCase();
    return (
      [...this.mailAliases.values()].find((a) => a.address === wanted) ?? null
    );
  }

  async updateMailAlias(
    id: string,
    patch: Partial<MailAlias>,
  ): Promise<MailAlias> {
    const existing = this.mailAliases.get(id);
    if (!existing) throw new Error(`mail alias not found: ${id}`);
    const updated: MailAlias = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: new Date().toISOString(),
    };
    this.mailAliases.set(id, updated);
    return updated;
  }

  async deleteMailAlias(id: string): Promise<boolean> {
    return this.mailAliases.delete(id);
  }

  /* ----- mail IP pools (plan §4.4) ----- */

  private mailIpPools = new Map<string, MailIpPool>();

  async createMailIpPool(p: MailIpPool): Promise<MailIpPool> {
    this.mailIpPools.set(p.id, p);
    return p;
  }

  async listMailIpPools(accountId: string): Promise<MailIpPool[]> {
    return [...this.mailIpPools.values()]
      .filter((p) => p.accountId === accountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getMailIpPool(id: string): Promise<MailIpPool | null> {
    return this.mailIpPools.get(id) ?? null;
  }

  async updateMailIpPool(
    id: string,
    patch: Partial<MailIpPool>,
  ): Promise<MailIpPool> {
    const existing = this.mailIpPools.get(id);
    if (!existing) throw new Error(`mail ip pool not found: ${id}`);
    const updated: MailIpPool = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: new Date().toISOString(),
    };
    this.mailIpPools.set(id, updated);
    return updated;
  }

  async deleteMailIpPool(id: string): Promise<boolean> {
    return this.mailIpPools.delete(id);
  }

  /* ----- compute nodes (plan §5.5 — Bring-Your-Own-VPS) ----- */

  private nodes = new Map<string, Node>();

  async createNode(n: Node): Promise<Node> {
    this.nodes.set(n.id, n);
    return n;
  }

  async getNode(id: string): Promise<Node | null> {
    return this.nodes.get(id) ?? null;
  }

  async listNodes(accountId: string): Promise<Node[]> {
    return [...this.nodes.values()]
      .filter((n) => n.accountId === accountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listAllNodes(): Promise<Node[]> {
    return [...this.nodes.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  async updateNode(id: string, patch: Partial<Node>): Promise<Node> {
    const existing = this.nodes.get(id);
    if (!existing) throw new Error(`node not found: ${id}`);
    const updated: Node = { ...existing, ...patch, id: existing.id };
    this.nodes.set(id, updated);
    return updated;
  }

  async findNodeByEnrollmentTokenHash(hash: string): Promise<Node | null> {
    return (
      [...this.nodes.values()].find((n) => n.enrollmentTokenHash === hash) ??
      null
    );
  }

  /* ----- number marketplace (plan §4.5) ----- */

  private marketplaceNumbers = new Map<string, MarketplaceNumber>(); // by id

  async createMarketplaceNumber(
    n: MarketplaceNumber,
  ): Promise<MarketplaceNumber> {
    this.marketplaceNumbers.set(n.id, n);
    return n;
  }

  async listMarketplaceNumbers(
    accountId: string,
  ): Promise<MarketplaceNumber[]> {
    return [...this.marketplaceNumbers.values()]
      .filter((n) => n.accountId === accountId)
      .sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt));
  }

  async getMarketplaceNumber(
    id: string,
  ): Promise<MarketplaceNumber | null> {
    return this.marketplaceNumbers.get(id) ?? null;
  }

  async findMarketplaceNumberByE164(
    e164: string,
  ): Promise<MarketplaceNumber | null> {
    const wanted = e164.trim();
    return (
      [...this.marketplaceNumbers.values()].find(
        (n) => n.e164 === wanted,
      ) ?? null
    );
  }

  async updateMarketplaceNumber(
    id: string,
    patch: Partial<MarketplaceNumber>,
  ): Promise<MarketplaceNumber> {
    const existing = this.marketplaceNumbers.get(id);
    if (!existing) throw new Error(`marketplace number not found: ${id}`);
    const updated: MarketplaceNumber = { ...existing, ...patch, id };
    this.marketplaceNumbers.set(id, updated);
    return updated;
  }

  /* ----- A2P/10DLC carrier registration (plan §4.5) ----- */

  private a2pRegistrations = new Map<string, A2pRegistration>();

  async createA2pRegistration(
    r: A2pRegistration,
  ): Promise<A2pRegistration> {
    this.a2pRegistrations.set(r.id, r);
    return r;
  }

  async listA2pRegistrations(
    accountId: string,
  ): Promise<A2pRegistration[]> {
    return [...this.a2pRegistrations.values()]
      .filter((r) => r.accountId === accountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getA2pRegistration(
    id: string,
  ): Promise<A2pRegistration | null> {
    return this.a2pRegistrations.get(id) ?? null;
  }

  async updateA2pRegistration(
    id: string,
    patch: Partial<A2pRegistration>,
  ): Promise<A2pRegistration> {
    const existing = this.a2pRegistrations.get(id);
    if (!existing) throw new Error(`a2p registration not found: ${id}`);
    const updated: A2pRegistration = { ...existing, ...patch, id };
    this.a2pRegistrations.set(id, updated);
    return updated;
  }

  async getPhoneNumberByProject(
    projectId: string,
  ): Promise<PhoneNumber | null> {
    return this.phoneNumbers.get(projectId) ?? null;
  }

  async createPhoneNumber(n: PhoneNumber): Promise<PhoneNumber> {
    this.phoneNumbers.set(n.projectId, n);
    return n;
  }

  async updatePhoneNumber(
    projectId: string,
    patch: Partial<PhoneNumber>,
  ): Promise<PhoneNumber> {
    const existing = this.phoneNumbers.get(projectId);
    if (!existing) {
      throw new Error(`phone number not found for project: ${projectId}`);
    }
    const updated: PhoneNumber = { ...existing, ...patch, projectId };
    this.phoneNumbers.set(projectId, updated);
    return updated;
  }

  async deletePhoneNumber(projectId: string): Promise<void> {
    this.phoneNumbers.delete(projectId);
  }

  async listEnvVars(projectId: string): Promise<EnvVar[]> {
    return [...this.envVars.values()].filter((v) => v.projectId === projectId);
  }

  async upsertEnvVar(v: EnvVar): Promise<EnvVar> {
    // unique by (projectId, key, scope)
    const existing = [...this.envVars.values()].find(
      (e) =>
        e.projectId === v.projectId &&
        e.key === v.key &&
        e.scope === v.scope,
    );
    const row: EnvVar = existing ? { ...v, id: existing.id } : v;
    this.envVars.set(row.id, row);
    return row;
  }

  async deleteEnvVar(projectId: string, key: string): Promise<void> {
    for (const [mapId, v] of this.envVars) {
      if (v.projectId === projectId && v.key === key) {
        this.envVars.delete(mapId);
      }
    }
  }

  async createDeployment(d: Deployment): Promise<Deployment> {
    this.deployments.set(d.id, d);
    return d;
  }

  async updateDeployment(
    id: string,
    patch: Partial<Deployment>,
  ): Promise<Deployment> {
    const existing = this.deployments.get(id);
    if (!existing) throw new Error(`deployment not found: ${id}`);
    const updated: Deployment = { ...existing, ...patch, id: existing.id };
    this.deployments.set(id, updated);
    return updated;
  }

  async listDeployments(projectId: string): Promise<Deployment[]> {
    return [...this.deployments.values()].filter(
      (d) => d.projectId === projectId,
    );
  }

  async listDomains(projectId: string): Promise<Domain[]> {
    return [...this.domains.values()].filter((d) => d.projectId === projectId);
  }

  async createDomain(d: Domain): Promise<Domain> {
    this.domains.set(d.id, d);
    return d;
  }

  async findDomainByHostname(hostname: string): Promise<Domain | null> {
    return (
      [...this.domains.values()].find((d) => d.hostname === hostname) ?? null
    );
  }

  private apiKeys = new Map<string, ApiKey>();

  async createApiKey(k: ApiKey): Promise<ApiKey> {
    this.apiKeys.set(k.id, k);
    return k;
  }

  async listApiKeys(accountId: string): Promise<ApiKey[]> {
    return [...this.apiKeys.values()].filter((k) => k.accountId === accountId);
  }

  async findApiKeyByHash(hash: string): Promise<ApiKey | null> {
    return [...this.apiKeys.values()].find((k) => k.hash === hash) ?? null;
  }

  async findApiKeyById(id: string): Promise<ApiKey | null> {
    return this.apiKeys.get(id) ?? null;
  }

  async countApiKeys(): Promise<number> {
    return this.apiKeys.size;
  }

  async touchApiKey(id: string, at: string): Promise<void> {
    const k = this.apiKeys.get(id);
    if (k) this.apiKeys.set(id, { ...k, lastUsedAt: at });
  }

  async deleteApiKey(id: string): Promise<boolean> {
    return this.apiKeys.delete(id);
  }

  /* ----- team ----- */

  private members = new Map<string, TeamMember>();

  async listMembers(accountId: string): Promise<TeamMember[]> {
    return [...this.members.values()]
      .filter((m) => m.accountId === accountId)
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  }

  async addMember(input: {
    accountId: string;
    email: string;
    name: string;
    role: MemberRole;
  }): Promise<TeamMember> {
    const email = input.email.trim().toLowerCase();
    const existing = [...this.members.values()].find(
      (m) => m.accountId === input.accountId && m.email === email,
    );
    if (existing) {
      const updated: TeamMember = { ...existing, role: input.role, name: input.name };
      this.members.set(existing.id, updated);
      return updated;
    }
    const member: TeamMember = {
      id: `mem_${Math.random().toString(16).slice(2, 18)}`,
      accountId: input.accountId,
      userId: `usr_${email.replace(/[^a-z0-9]/g, "").slice(0, 12)}`,
      email,
      name: input.name,
      role: input.role,
      joinedAt: new Date().toISOString(),
    };
    this.members.set(member.id, member);
    return member;
  }

  async updateMemberRole(
    membershipId: string,
    role: MemberRole,
  ): Promise<TeamMember> {
    const existing = this.members.get(membershipId);
    if (!existing) throw new Error(`membership not found: ${membershipId}`);
    const updated: TeamMember = { ...existing, role };
    this.members.set(membershipId, updated);
    return updated;
  }

  async removeMember(membershipId: string): Promise<boolean> {
    return this.members.delete(membershipId);
  }

  /* ----- activity feed ----- */

  private events: ActivityEvent[] = [];

  async recordEvent(e: ActivityEvent): Promise<ActivityEvent> {
    this.events.push(e);
    return e;
  }

  async listEvents(
    accountId: string,
    opts: { limit?: number } = {},
  ): Promise<ActivityEvent[]> {
    const limit = opts.limit ?? 100;
    return this.events
      .filter((x) => x.accountId === accountId)
      .slice()
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
  }

  /* ----- inbound SMS message history ----- */

  private inboundMessages: InboundMessage[] = [];

  async createInboundMessage(m: InboundMessage): Promise<InboundMessage> {
    this.inboundMessages.push(m);
    return m;
  }

  async listInboundMessages(query: {
    accountId: string;
    projectId?: string;
    limit?: number;
  }): Promise<InboundMessage[]> {
    const limit = query.limit ?? 100;
    return this.inboundMessages
      .filter(
        (m) =>
          m.accountId === query.accountId &&
          (query.projectId === undefined ||
            m.projectId === query.projectId),
      )
      .slice()
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, limit);
  }

  private inboundCalls: InboundCallRecord[] = [];

  async createInboundCall(
    c: InboundCallRecord,
  ): Promise<InboundCallRecord> {
    this.inboundCalls.push(c);
    return c;
  }

  async listInboundCalls(query: {
    accountId: string;
    projectId?: string;
    limit?: number;
  }): Promise<InboundCallRecord[]> {
    const limit = query.limit ?? 100;
    return this.inboundCalls
      .filter(
        (c) =>
          c.accountId === query.accountId &&
          (query.projectId === undefined ||
            c.projectId === query.projectId),
      )
      .slice()
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, limit);
  }

  /* ----- inbound mail history ----- */

  private inboundMail: InboundMail[] = [];

  async createInboundMail(m: InboundMail): Promise<InboundMail> {
    this.inboundMail.push(m);
    return m;
  }

  async listInboundMail(query: {
    accountId: string;
    projectId?: string;
    limit?: number;
  }): Promise<InboundMail[]> {
    const limit = query.limit ?? 100;
    return this.inboundMail
      .filter(
        (m) =>
          m.accountId === query.accountId &&
          (query.projectId === undefined ||
            m.projectId === query.projectId),
      )
      .slice()
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, limit);
  }

  /* ----- object storage ----- */

  private buckets = new Map<string, StorageBucket>();
  /** Buckets are scoped to accounts but indexed by project; the account is
   *  derived through the bucket's project. */
  private bucketAccount = new Map<string, string>(); // bucketId → accountId

  async createBucket(b: StorageBucket): Promise<StorageBucket> {
    this.buckets.set(b.id, b);
    const project = this.projects.get(b.projectId);
    if (project) this.bucketAccount.set(b.id, project.accountId);
    return b;
  }

  async listBuckets(accountId: string): Promise<StorageBucket[]> {
    const result: StorageBucket[] = [];
    for (const b of this.buckets.values()) {
      const owner =
        this.bucketAccount.get(b.id) ?? this.projects.get(b.projectId)?.accountId;
      if (owner === accountId) result.push(b);
    }
    return result;
  }

  async listBucketsByProject(projectId: string): Promise<StorageBucket[]> {
    return [...this.buckets.values()].filter((b) => b.projectId === projectId);
  }

  async findBucketByName(name: string): Promise<StorageBucket | null> {
    return [...this.buckets.values()].find((b) => b.name === name) ?? null;
  }

  async deleteBucket(id: string): Promise<boolean> {
    this.bucketAccount.delete(id);
    return this.buckets.delete(id);
  }

  /* ----- backups ----- */

  private backups = new Map<string, Backup>();

  async createBackup(b: Backup): Promise<Backup> {
    this.backups.set(b.id, b);
    return b;
  }

  async listBackups(projectId: string): Promise<Backup[]> {
    return [...this.backups.values()]
      .filter((b) => b.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getBackup(id: string): Promise<Backup | null> {
    return this.backups.get(id) ?? null;
  }

  async deleteBackup(id: string): Promise<boolean> {
    return this.backups.delete(id);
  }

  /* ----- registrar ----- */

  private registrations = new Map<string, DomainRegistration>();

  async createRegistration(r: DomainRegistration): Promise<DomainRegistration> {
    this.registrations.set(r.id, r);
    return r;
  }

  async listRegistrations(accountId: string): Promise<DomainRegistration[]> {
    return [...this.registrations.values()].filter(
      (r) => r.accountId === accountId,
    );
  }

  async findRegistrationByHostname(
    hostname: string,
  ): Promise<DomainRegistration | null> {
    return (
      [...this.registrations.values()].find((r) => r.hostname === hostname) ??
      null
    );
  }

  async updateRegistration(
    id: string,
    patch: Partial<DomainRegistration>,
  ): Promise<DomainRegistration> {
    const existing = this.registrations.get(id);
    if (!existing) throw new Error(`registration not found: ${id}`);
    const updated: DomainRegistration = {
      ...existing,
      ...patch,
      id: existing.id,
    };
    this.registrations.set(id, updated);
    return updated;
  }

  /* ----- agent journal ----- */

  /** Append-only ring. Same bounded shape the brain's in-memory journal
   *  uses, but persisted for the lifetime of the process (and across
   *  process restarts once Prisma is wired). */
  private agentActions: StoredAgentAction[] = [];

  async recordAgentAction(action: StoredAgentAction): Promise<void> {
    this.agentActions.push(action);
    // Match the brain's buffer cap so memory pressure is bounded even
    // when the brain is loading from a long-running store.
    if (this.agentActions.length > 1000) {
      this.agentActions = this.agentActions.slice(-1000);
    }
  }

  async updateAgentActionVerification(
    proposalId: string,
    verification: {
      verified: "ok" | "failed";
      verifiedAt: string;
      verifyDetail: string;
    },
  ): Promise<void> {
    for (let i = this.agentActions.length - 1; i >= 0; i--) {
      if (this.agentActions[i].proposalId === proposalId) {
        this.agentActions[i] = {
          ...this.agentActions[i],
          ...verification,
        };
        return;
      }
    }
  }

  async listAgentActions(
    opts: { limit?: number } = {},
  ): Promise<StoredAgentAction[]> {
    const limit = opts.limit ?? 100;
    return this.agentActions.slice(-limit);
  }

  /* ----- durable SMS telemetry + OTP challenges ----- */

  private smsEventLog: StoredSmsEvent[] = [];

  async appendSmsEvent(e: StoredSmsEvent): Promise<void> {
    this.smsEventLog.push(e);
    if (this.smsEventLog.length > 2000) {
      this.smsEventLog = this.smsEventLog.slice(-2000);
    }
  }

  async listRecentSmsEvents(limit = 1000): Promise<StoredSmsEvent[]> {
    return this.smsEventLog.slice(-limit);
  }

  private mailEventLog: StoredMailEvent[] = [];

  async appendMailEvent(e: StoredMailEvent): Promise<void> {
    this.mailEventLog.push(e);
    if (this.mailEventLog.length > 2000) {
      this.mailEventLog = this.mailEventLog.slice(-2000);
    }
  }

  async listRecentMailEvents(limit = 1000): Promise<StoredMailEvent[]> {
    return this.mailEventLog.slice(-limit);
  }

  private otpChallengeStore = new Map<string, StoredOtpChallenge>();

  async upsertOtpChallenge(c: StoredOtpChallenge): Promise<void> {
    this.otpChallengeStore.set(c.id, c);
  }

  async deleteOtpChallenge(id: string): Promise<void> {
    this.otpChallengeStore.delete(id);
  }

  async listOtpChallenges(): Promise<StoredOtpChallenge[]> {
    return [...this.otpChallengeStore.values()];
  }

  /* ----- per-user auth: users & sessions (plan §5.4) ----- */

  private users = new Map<string, AuthUser>(); //    keyed by id
  private sessions = new Map<string, Session>(); //  keyed by id

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    const wanted = email.trim().toLowerCase();
    return [...this.users.values()].find((u) => u.email === wanted) ?? null;
  }

  async getUser(id: string): Promise<AuthUser | null> {
    return this.users.get(id) ?? null;
  }

  async createUser(u: AuthUser): Promise<AuthUser> {
    this.users.set(u.id, u);
    return u;
  }

  async updateUserPassword(
    userId: string,
    passwordHash: string,
  ): Promise<AuthUser> {
    const existing = this.users.get(userId);
    if (!existing) throw new Error(`user ${userId} not found`);
    const updated: AuthUser = { ...existing, passwordHash };
    this.users.set(userId, updated);
    return updated;
  }

  async setUserEmailVerifiedAt(
    userId: string,
    verifiedAt: string,
  ): Promise<AuthUser> {
    const existing = this.users.get(userId);
    if (!existing) throw new Error(`user ${userId} not found`);
    const updated: AuthUser = { ...existing, emailVerifiedAt: verifiedAt };
    this.users.set(userId, updated);
    return updated;
  }

  async setUserAvatarUrl(
    userId: string,
    avatarUrl: string,
  ): Promise<AuthUser> {
    const existing = this.users.get(userId);
    if (!existing) throw new Error(`user ${userId} not found`);
    const updated: AuthUser = { ...existing, avatarUrl };
    this.users.set(userId, updated);
    return updated;
  }

  async createSession(s: Session): Promise<Session> {
    this.sessions.set(s.id, s);
    return s;
  }

  async findSessionByTokenHash(tokenHash: string): Promise<Session | null> {
    return (
      [...this.sessions.values()].find((s) => s.tokenHash === tokenHash) ??
      null
    );
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async deleteSessionsByUser(userId: string): Promise<number> {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.userId === userId) {
        this.sessions.delete(id);
        n += 1;
      }
    }
    return n;
  }

  /* ----- invites (plan §5.4) ----- */

  private invites = new Map<string, Invite>(); // keyed by id

  async createInvite(i: Invite): Promise<Invite> {
    this.invites.set(i.id, i);
    return i;
  }

  async getInvite(id: string): Promise<Invite | null> {
    return this.invites.get(id) ?? null;
  }

  async findInviteByTokenHash(tokenHash: string): Promise<Invite | null> {
    return (
      [...this.invites.values()].find((x) => x.tokenHash === tokenHash) ?? null
    );
  }

  async findPendingInviteByAccountAndEmail(
    accountId: string,
    email: string,
  ): Promise<Invite | null> {
    const wanted = email.trim().toLowerCase();
    return (
      [...this.invites.values()].find(
        (x) =>
          x.accountId === accountId &&
          x.email === wanted &&
          x.status === "pending",
      ) ?? null
    );
  }

  async listInvitesByAccount(accountId: string): Promise<Invite[]> {
    return [...this.invites.values()]
      .filter((x) => x.accountId === accountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updateInvite(id: string, patch: Partial<Invite>): Promise<Invite> {
    const existing = this.invites.get(id);
    if (!existing) throw new Error(`invite not found: ${id}`);
    const updated: Invite = { ...existing, ...patch, id: existing.id };
    this.invites.set(id, updated);
    return updated;
  }

  /* ----- memberships (plan §18 — Option B multi-org tenancy) ----- */

  private memberships = new Map<string, Membership>(); // keyed by id

  async createMembership(m: Membership): Promise<Membership> {
    this.memberships.set(m.id, m);
    return m;
  }

  async findMembership(
    userId: string,
    accountId: string,
  ): Promise<Membership | null> {
    return (
      [...this.memberships.values()].find(
        (x) => x.userId === userId && x.accountId === accountId,
      ) ?? null
    );
  }

  async listMembershipsByUser(userId: string): Promise<Membership[]> {
    return [...this.memberships.values()]
      .filter((x) => x.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listMembershipsByAccount(accountId: string): Promise<Membership[]> {
    return [...this.memberships.values()]
      .filter((x) => x.accountId === accountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteMembership(id: string): Promise<boolean> {
    return this.memberships.delete(id);
  }

  async setSessionCurrentAccount(
    sessionId: string,
    accountId: string | null,
  ): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    if (!existing) throw new Error(`session not found: ${sessionId}`);
    const updated: Session = {
      ...existing,
      currentAccountId: accountId ?? undefined,
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  /* ----- Cantila Connections (plan §4.11) ----- */

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

  /* ----- Cantila Automations — execution history (plan §15.5 Phase F) ----- */

  private workflowExecutions = new Map<string, WorkflowExecutionRecord>();

  async createWorkflowExecution(
    r: WorkflowExecutionRecord,
  ): Promise<WorkflowExecutionRecord> {
    // Defensive copy so the caller can keep mutating their event array
    // without rewriting the row through the store on every push.
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
          (query.connectionId === undefined || e.connectionId === query.connectionId),
      )
      .slice()
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
  }
}
