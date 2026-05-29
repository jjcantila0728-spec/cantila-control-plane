/* ============================================================
   Cantila control plane — core domain types.
   Prisma-independent: the deploy logic depends on these, not on
   generated client types. prisma/schema.prisma is the canonical
   production model and stays in sync with these shapes.
   ============================================================ */

export type Region = "fsn1" | "hel1" | "ash";

export type Runtime =
  | "static"
  | "node"
  | "python"
  | "php"
  | "go"
  | "ruby"
  | "docker";

export type ProjectStatus =
  | "provisioning"
  | "building"
  | "live"
  | "sleeping"
  | "crashed"
  | "paused";

export type DeployTrigger = "chat" | "git" | "cli" | "mcp" | "upload";

export type DeployStatus =
  | "queued"
  | "building"
  | "live"
  | "failed"
  | "rolled_back"
  | "superseded";

export type ServiceStatus = "provisioning" | "active" | "sleeping" | "error";

export type DbEngine = "postgres" | "mysql" | "mongodb" | "redis";

export type EnvScope = "production" | "preview" | "all";

export type DomainKind = "subdomain" | "custom";

export type ApiKeyScope = "read" | "deploy" | "admin";

/** Cantila Automations (plan §4.10) — the engine kind that runs inside an
 *  automation instance. Each kind has an adapter behind
 *  `AutomationEngineAdapter` that translates Cantila's canonical workflow
 *  graph to/from the engine's native format. Extensible — adding Flowise
 *  or LibreChat later is a kind plus an adapter. */
export type AutomationKind = "n8n" | "openclaw";

/** Cantila Connections (plan §4.11) — the auth shape used to talk to an
 *  external provider. Each `Connection` has exactly one of these. */
export type ConnectionAuthKind = "oauth" | "api_key" | "basic";

/** Cantila Connections — credential health. `expired` is OAuth-only;
 *  `broken` covers API keys the provider has rejected on a probe. */
export type ConnectionStatus = "active" | "expired" | "broken";

/** Team roles — plan §5.5. Mirrors the Prisma `Role` enum. */
export type MemberRole = "owner" | "admin" | "developer" | "viewer";

/** Plan tier — mirrors the Prisma `Plan` enum. Stored on Account so the
 *  billing surface can render the right limits without consulting the
 *  PLAN_CATALOG at every read. */
export type AccountPlan = "hobby" | "starter" | "pro" | "agency" | "dedicated";

/** Billing health of an account, driven by the dunning state machine
 *  (plan §8 / §15.2 — `src/billing/dunning.ts`).
 *  - `active`    — paid up, or never had a payment fail (the default).
 *  - `past_due`  — a charge failed; the account is in the grace window
 *                  and still fully functional.
 *  - `suspended` — the grace window lapsed; deploys are blocked until
 *                  payment recovers.
 *  - `canceled`  — the subscription was terminated for non-payment.
 *  Absent on legacy `Account` rows — every reader treats `undefined`
 *  as `active`. */
export type AccountBillingStatus =
  | "active"
  | "past_due"
  | "suspended"
  | "canceled";

/** A tenant in the control plane. Every project, mailbox, phone number,
 *  domain registration, bucket, team membership and API key hangs off an
 *  Account row. The bootstrap path mints the first Account on the first
 *  key; the admin `POST /v1/accounts` endpoint provisions any additional
 *  ones. */
export interface Account {
  id: string;
  /** Human-friendly name shown in the Console (e.g. "Acme Inc"). */
  name: string;
  /** URL-safe handle, unique across the control plane. Used as the
   *  routing slug for the `*.cantila.app` namespace later. */
  handle: string;
  plan: AccountPlan;
  /** Parent account, when this Account is a sub-account under an agency
   *  / reseller (plan §5.5 — white-label). Absent on top-level accounts.
   *  The parent can act on this row through `canActOnAccount`, mirroring
   *  the agency persona in §3. Sub-account creation goes through
   *  `createSubAccount`, never `createAccount` directly. */
  parentAccountId?: string;
  /** Stripe `Customer.id` — minted on first bootstrap (best-effort, may
   *  be back-filled later if the bootstrap-time Stripe call failed). The
   *  rail is the source of truth for billing operations (plan §8 / §15.1). */
  stripeCustomerId?: string;
  /** Active `Subscription.id` — populated by the Stripe webhook receiver
   *  on `checkout.session.completed` and cleared on
   *  `customer.subscription.deleted`. */
  stripeSubscriptionId?: string;
  /** Per-tenant Anthropic API key (plan §4.3.1 — "Run Chat Deploy on
   *  your own Claude account"). When set, the AI analyser uses this key
   *  for the tenant's `troubleshootDeploy` / `getCostOptimisation` calls
   *  — model spend is billed to the tenant's Anthropic account, not
   *  Cantila's. Masked on standard reads; the raw value is never echoed
   *  after the initial `set` call. */
  anthropicApiKey?: string;
  /** Billing health — driven entirely by the dunning state machine on
   *  Stripe `invoice.*` webhooks and the dunning sweep. `undefined` on
   *  legacy rows; read as `active`. */
  billingStatus?: AccountBillingStatus;
  /** Failed-payment count in the current dunning cycle. Reset to 0 the
   *  moment a payment succeeds. `undefined` / 0 when not in dunning. */
  dunningAttempts?: number;
  /** ISO timestamp of the most recent failed payment. Only meaningful
   *  while `billingStatus` is `past_due` or `suspended`. */
  dunningFailedAt?: string;
  /** ISO timestamp at which `past_due` escalates to `suspended` if
   *  payment has not recovered. The dunning sweep watches this clock.
   *  Only meaningful while `billingStatus` is `past_due`. */
  dunningGraceEndsAt?: string;
  /** Plan §5.5 — white-label per-account branding. All optional. When
   *  absent the Console renders default Cantila chrome. Set by the
   *  account itself OR by its agency parent (the parent's
   *  `canActOnAccount` permission carries through). */
  brandPrimaryColor?: string;
  /** Hex secondary accent. Optional. */
  brandAccentColor?: string;
  /** Public URL to the brand logo (SVG or PNG). The Console
   *  swaps the sidebar's diamond mark for this image when set. */
  brandLogoUrl?: string;
  /** Display-name override — useful when an agency wants the
   *  workspace chrome to read "Acme Client A" rather than the
   *  legal account `name`. Falls back to `name` when absent. */
  brandDisplayName?: string;
  /** Plan §5.5 — white-label billing-rollup. When set, this
   *  account does NOT carry its own Stripe subscription; every
   *  charge that would land on its own subscription (number
   *  leases, plan-tier fees) is routed to the referenced
   *  account's subscription instead. Must point at the agency
   *  parent (enforced at the ControlPlane layer). Two-level only —
   *  a rolled-up sub-account cannot itself be rolled up onto. */
  billedToAccountId?: string;
  createdAt: string;
}

/** Plan §5.5 — the branding patch shape accepted by
 *  `updateAccountBranding`. All fields optional; passing
 *  `null` (via the API layer) clears that field. */
export interface AccountBrandingPatch {
  brandPrimaryColor?: string | null;
  brandAccentColor?: string | null;
  brandLogoUrl?: string | null;
  brandDisplayName?: string | null;
}

/** One dunning notice — a billing email Cantila rendered for an account
 *  owner (payment failed, account suspended, …). Recorded in a bounded
 *  in-memory ring; actual delivery to the customer's inbox is a job for
 *  the platform MTA, which is not yet real (plan §15.2). */
export interface DunningNotice {
  accountId: string;
  /** Which dunning email this is — see `DunningEmailTemplate`. */
  template: string;
  /** Rendered subject line. */
  subject: string;
  /** Rendered plain-text body. */
  body: string;
  /** When the notice was rendered/recorded. */
  at: string;
}

/** A user's membership in an account. The CP normalises the User and
 *  Membership tables into a single row for the Console / CLI. */
export interface TeamMember {
  /** Membership id — stable across email/name changes. */
  id: string;
  accountId: string;
  userId: string;
  email: string;
  name: string;
  role: MemberRole;
  joinedAt: string;
  /** Optional — most recent activity (touched by `recordEvent` later). */
  lastActiveAt?: string;
}

/** A person who can sign into the Console (plan §5.4 — per-user OIDC/SSO
 *  auth). Distinct from `TeamMember`, which is the flattened User+Membership
 *  view the team API returns. `passwordHash` is internal — never serialised
 *  past the ControlPlane boundary. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** scrypt hash — set for password sign-in, undefined for SSO-only users. */
  passwordHash?: string;
  twoFactorEnabled: boolean;
  /** The account this user belongs to (plan §5.4). Bound at user
   *  creation — it makes a session a real, account-scoped API credential.
   *  Absent on legacy rows; readers fall back to the default account. */
  accountId?: string;
  /** ISO timestamp when the user verified their email via the
   *  `email_verify` one-shot token flow (plan §5.4). `undefined`
   *  before verification — the column is nullable + back-compat
   *  for legacy rows. Today the verification gate is advisory
   *  (the Console renders a banner); it is NOT yet a hard sign-in
   *  block — that decision lives at the route layer when Mail
   *  goes live and bounces become a real signal. */
  emailVerifiedAt?: string;
  /** Profile picture URL from a social IdP (Google `picture`, GitHub
   *  `avatar_url`). Undefined for password-only users. */
  avatarUrl?: string;
  createdAt: string;
}

/** A server-side login session backing the Console's per-user auth.
 *  `tokenHash` is the SHA-256 of the raw token; the raw token lives only
 *  in the caller's cookie and is never persisted (same posture as `ApiKey`).
 *  Additive to the scoped-API-key model — sessions gate the Console,
 *  keys gate the API. */
export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  /** ISO timestamp — the session is invalid once the clock passes this. */
  expiresAt: string;
  createdAt: string;
  /** The account this session is currently scoped to (plan §18). One User
   *  belongs to many Accounts via `Membership`; this records which one is
   *  active. Null when the user has no memberships yet. */
  currentAccountId?: string;
}

/** A user's membership in an account (plan §18 — multi-org tenancy).
 *  One row per (User, Account). Replaces the legacy 1:1
 *  `User.accountId` binding so consultants / agency staff / founders can
 *  belong to multiple orgs without duplicate users. */
export interface Membership {
  id: string;
  userId: string;
  accountId: string;
  role: MemberRole;
  createdAt: string;
}

/** Lifecycle states for an invite to join an account (plan §5.4). */
export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

/** A one-time invitation for someone to join an account at a given role.
 *  Replaces the prototype's "first user joins the bootstrap account"
 *  hack: an accepted invite pins the new user to the inviting account so
 *  their session is account-scoped to the inviter, not to whichever
 *  Account row sorts first.
 *
 *  `tokenHash` is the SHA-256 of the raw invite token; the raw token is
 *  returned exactly once at creation (same one-time-reveal posture as
 *  `ApiKey` and `Session`) and embedded in the accept URL. */
export interface Invite {
  id: string;
  accountId: string;
  /** Lowercased email — the invitee accepts by knowing the token, but the
   *  email is recorded so the Console can show "invited foo@bar.com" and
   *  so the accept flow can pre-fill it. */
  email: string;
  role: MemberRole;
  tokenHash: string;
  status: InviteStatus;
  /** User id of the inviter, when available — recorded for the audit
   *  trail. Optional because bootstrap-time invites have no inviter. */
  invitedByUserId?: string;
  /** When the invite was created. */
  createdAt: string;
  /** When the invite stops being acceptable. The accept path rejects
   *  invites whose clock has passed even if `status` is still `pending`. */
  expiresAt: string;
  /** When the invite was accepted, if it was. */
  acceptedAt?: string;
  /** The user that accepted it, if any. */
  acceptedByUserId?: string;
}

/** Kinds of platform events that show up in the Activity feed (plan §4.8).
 *  Kept loose so new event sources don't need a schema migration. */
export type ActivityKind =
  | "deploy"
  | "domain"
  | "database"
  | "storage"
  | "git"
  | "config"
  | "key"
  | "alert"
  | "backup"
  | "system";

export interface ActivityEvent {
  id: string;
  accountId: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  /** Optional — when the event is project-scoped. */
  projectId?: string;
  /** Optional — when an *actor* different from the target account
   *  drove the event. Today this is set when an agency parent (plan
   *  §5.5) takes an action against a sub-account: `accountId` is the
   *  sub-account that owns the resource, `actorAccountId` is the
   *  parent that asked. Stored only when actor ≠ target — events the
   *  account drives on itself are unchanged. */
  actorAccountId?: string;
  at: string;
}

export interface Project {
  id: string;
  accountId: string;
  slug: string;
  name: string;
  runtime: Runtime;
  region: Region;
  status: ProjectStatus;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  alwaysOn: boolean;
  autoSleep: boolean;
  /** Horizontal scaling (plan §5.2). `desiredInstances` is the count the
   *  data plane is asked to run; `minInstances` / `maxInstances` are the
   *  bounds an auto-scaling policy must respect. All default to 1, so
   *  legacy single-instance projects keep behaving exactly the same. */
  desiredInstances: number;
  minInstances: number;
  maxInstances: number;
  /** Connected git repo, e.g. https://github.com/owner/name */
  repoUrl?: string;
  /** Branch that auto-deploys when a push arrives — default "main". */
  branch?: string;
  /** When true, an incoming push webhook triggers a deploy. */
  autoDeploy: boolean;
  /** Per-project HMAC secret. Set when `connectGit` is called and used to
   *  verify incoming webhook payloads — without it the receiver would
   *  fire deploys for anyone who knows the project id. The plaintext
   *  secret is returned exactly once from `connectGit` (and `git secret
   *  rotate`); only the value itself is stored so the receiver can
   *  recompute and compare signatures. */
  webhookSecret?: string;
  /** Cantila Automations (plan §4.10). When set, this project is an
   *  automation instance — n8n or OpenClaw — and the `/v1/automations/*`
   *  routes surface it as such. Absent on regular hosting projects, which
   *  remain untouched by the Automations layer. The Console filters its
   *  Automations view on `automationKind != null` to keep instances out of
   *  the generic Projects list. */
  automationKind?: AutomationKind;
  /** Kind-specific configuration set at creation time (engine version,
   *  encryption-key id, webhook base URL, etc.). The engine adapter reads
   *  this on every operation; the deploy pipeline merges fields it cares
   *  about into the project's env. Opaque to the core types so adding a
   *  new kind never edits this type. */
  automationConfig?: Record<string, unknown>;
  /** UUID of the corresponding Coolify Application (plan §19). Populated
   *  on first deploy through `CoolifyDataPlane` and re-used on every
   *  subsequent deploy / redeploy so we don't need to scan the full
   *  Coolify app list to look the project back up after a control-plane
   *  restart. Unset until the live data plane is in play (stub never
   *  writes it; offline builds leave the column null). */
  coolifyAppUuid?: string;
  /** True only for the seeded system "Platform" project that owns
   *  cantila.app. Hidden from tenant project lists. */
  platform?: boolean;
  /** Webhook URL the Telnyx AI agent posts tool-call events to (plan §4.5 —
   *  voice agents). When set, `receiveAgentEvent` forwards tool-call events
   *  here. Absent until set via a management API (follow-up). */
  voiceAgentToolUrl?: string;
  createdAt: string;
}

/** Cantila Automations (plan §4.10) — a persisted workflow execution.
 *  The engine adapter is the source of truth for live runs, but its
 *  records live only in the engine's own memory (or its database). The
 *  Cantila-side record captures the run + its event tape so the Console
 *  can list past runs and a `Replay` button can re-fire the same
 *  workflow without re-loading the engine's history. Plan §15.5 Phase F. */
export interface WorkflowExecutionRecord {
  /** The engine-side execution id (kept stable across replays — a replay
   *  mints a fresh row with `replayOfId` pointing at the original). */
  id: string;
  /** Cantila Automation Project id this run belongs to. */
  automationId: string;
  accountId: string;
  workflowId: string;
  /** Cached at capture time so the Console can show a workflow label
   *  without re-loading the graph. */
  workflowName?: string;
  status: "queued" | "running" | "success" | "failed";
  startedAt: string;
  finishedAt?: string;
  /** Captured event tape — appended to as the SSE / capture iterator
   *  yields events. The Console's Replay surface reads this verbatim. */
  events: WorkflowExecutionEvent[];
  /** Final per-node states copied off the adapter's terminal
   *  `ExecutionState`. Absent until the run finishes. */
  nodeStates?: Record<string, "pending" | "running" | "success" | "failed">;
  /** If this row is a replay of another, the source execution id.
   *  Chains allowed — the Console renders the chain length so an
   *  operator can see how many replays a workflow has had. */
  replayOfId?: string;
  /** Free-text error message when `status === "failed"`. Copied from the
   *  engine's terminal state. */
  error?: string;
}

/** One captured execution event — same shape as the live `ExecutionEvent`
 *  the engine yields, but persisted alongside the run. */
export interface WorkflowExecutionEvent {
  at: string;
  executionId: string;
  nodeId?: string;
  kind:
    | "execution_started"
    | "execution_finished"
    | "node_started"
    | "node_succeeded"
    | "node_failed";
  detail?: string;
}

/** Cantila Connections (plan §4.11) — one audit row per
 *  `bindConnection` / `unbindConnection` call. Lets an operator see who
 *  bound which credential into which engine, when, and whether the bind
 *  pushed real bytes or stayed a placeholder. Plan §15.5 Phase F. */
export interface ConnectionAuditEvent {
  id: string;
  accountId: string;
  connectionId: string;
  /** The automation Project the bind targeted — set when the bind
   *  happens through `cp.bindConnectionForRun`. Absent for bare audit
   *  rows recorded outside an automation context. */
  automationId?: string;
  kind: "bind" | "unbind";
  /** The engine adapter that performed the operation, e.g. `n8n@live`. */
  engineLabel: string;
  /** The engine-side credential id (n8n's credential row id, OpenClaw's
   *  credential id, or the adapter's placeholder when no real push). */
  engineCredentialId: string;
  /** True when real bytes landed in the engine; false when the adapter
   *  only minted a placeholder id. */
  pushed: boolean;
  /** Bind-only — when the engine TTL'd the credential. */
  expiresAt?: string;
  /** Free-text — captured error message when the adapter call threw. */
  error?: string;
  at: string;
}

/** A Cantila Connection (plan §4.11) — an account-wide stored credential
 *  for an external provider (Gmail, Slack, Notion, …). Every automation
 *  instance, every project, can reference a connection by id; the engine
 *  adapter binds it just-in-time at workflow execution so the vendor
 *  engine never holds the long-lived secret.
 *
 *  Credentials are never stored on this row. `secretRef` points at an
 *  entry in the secrets manager — the row carries metadata only and is
 *  safe to return over the API as-is. */
export interface Connection {
  id: string;
  accountId: string;
  /** Provider id, e.g. "gmail", "slack", "openai". Matches a
   *  `ProviderDescriptor.id` in the server-side provider catalog. */
  provider: string;
  /** User-friendly label, e.g. "JJ Gmail" or "Acme Slack workspace". */
  name: string;
  authKind: ConnectionAuthKind;
  status: ConnectionStatus;
  /** Provider-shaped metadata captured at create time — the OAuth account
   *  email, the workspace name, scopes granted, etc. Opaque to the core
   *  types so adding a new provider never edits this. */
  metadata: Record<string, unknown>;
  /** Pointer into the secrets manager. The raw credential never leaves
   *  the secrets store and is never serialised across the API boundary. */
  secretRef: string;
  createdAt: string;
  /** Last time the engine adapter bound this credential into a run.
   *  Drives the "last used" column in the Console's connections list. */
  lastUsedAt?: string;
  /** OAuth-only — the token's stated expiry. The dunning-style refresh
   *  sweep flips `status` to `expired` when this passes. Absent for
   *  api-key / basic connections. */
  expiresAt?: string;
}

/** A project's own dedicated database — one per project. */
export interface ManagedDatabase {
  id: string;
  projectId: string;
  engine: DbEngine;
  version: string;
  region: Region;
  status: ServiceStatus;
  connectionUri: string; // secret
  createdAt: string;
}

/** A project's own email service — one per project. */
export interface Mailbox {
  id: string;
  projectId: string;
  address: string;
  sendingDomain: string;
  smtpHost: string;
  smtpUser: string;
  smtpPassword: string; // secret
  status: ServiceStatus;
  createdAt: string;
}

/** Kind of a hosted mailbox — a real inbox a person uses. */
export type MailboxKind = "personal" | "shared";

/** A hosted mailbox (plan §4.4 — "Hosted mailboxes — real inboxes").
 *  Distinct from `Mailbox` above (a project's auto-wired transactional
 *  SMTP service): a `HostedMailbox` is an addressable inbox a team member
 *  or a shared role uses. A project can own many — created and removed
 *  through the mailbox CRUD endpoints, not the deploy pipeline. */
export interface HostedMailbox {
  id: string;
  projectId: string;
  /** Full email address — globally unique. */
  address: string;
  displayName: string;
  kind: MailboxKind;
  /** Storage quota in MB. */
  quotaMb: number;
  /** Storage used in MB — production fills this from the mailstore. */
  usedMb: number;
  status: ServiceStatus;
  createdAt: string;
}

/** `createHostedMailbox` success result. For platform (cantila.app)
 *  mailboxes the generated mailbox password is returned exactly once
 *  here and never persisted. Absent for non-platform mailboxes. */
export type CreatedHostedMailbox = HostedMailbox & {
  oneTimePassword?: string;
};

/** Kind of mail alias (plan §4.4 — Cantila Mail aliases). Mirrors the
 *  Console's existing alias vocabulary in `cantila-console/src/lib/types.ts`:
 *  - `alias` — internal forward: `name@domain` → another Cantila mailbox.
 *  - `forward` — external forward: `name@domain` → an outside address.
 *  - `catch-all` — wildcard `*@domain` → one destination.
 *  - `parse` — programmatic: deliver to a webhook URL the project hosts. */
export type MailAliasKind = "alias" | "forward" | "catch-all" | "parse";

/** A mail routing rule (plan §4.4). Mail delivered to `address` is
 *  routed to `target` by the MTA — the rule semantics depend on `kind`.
 *  Aliases are project-scoped; the alias's hostname must match the
 *  project's `Mailbox.sendingDomain` (or be `*@<domain>` for catch-all).
 *  The real MTA does not exist yet (plan §15.2); today this records the
 *  rule the future MTA will honor. Shape mirrors the Console's existing
 *  `MailAlias` mock so the live wiring drops into the existing UI. */
export interface MailAlias {
  id: string;
  projectId: string;
  /** The address that receives mail — full email for alias/forward/parse,
   *  `*@<domain>` for catch-all. Lowercased and globally unique. */
  address: string;
  /** Where mail is routed. Another email for alias/forward/catch-all; a
   *  free-text identifier (webhook URL or label) for `parse`. */
  target: string;
  kind: MailAliasKind;
  /** When false, the MTA bounces mail rather than routing — gives
   *  operators a way to pause a rule without deleting it. */
  active: boolean;
  /** Optional free-text label shown in the Console. */
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/** Mail sending-IP pool purpose (plan §4.4 — IP-pool rotation). Mail
 *  providers route different message classes through different pools
 *  to protect sender reputation:
 *  - `warmup` — a fresh IP being ramped up; only low volume here.
 *  - `main` — the default pool for general traffic.
 *  - `transactional` — receipts, OTPs, account notifications. High
 *    engagement, low complaint rate.
 *  - `marketing` — bulk campaigns. Isolated from transactional so a
 *    marketing bounce spike doesn't poison receipt deliverability. */
export type MailIpPoolKind = "warmup" | "main" | "transactional" | "marketing";

/** A sending-IP pool an account uses for outbound mail (plan §4.4).
 *  Account-scoped; the future MTA reads this metadata to decide which
 *  pool a given send rides through. The actual IPs are managed by the
 *  MTA / cloud provider — this row records the contract. */
export interface MailIpPool {
  id: string;
  accountId: string;
  name: string;
  kind: MailIpPoolKind;
  /** Comma-separated synthetic IPv4 addresses for the prototype. The
   *  real MTA fills this from the cloud provider's allocations. */
  ips: string[];
  /** Reputation score 0–100. Synthesised from `kind` today (warmup
   *  pools start at 50 and climb, transactional pools track high,
   *  marketing pools sit lower). The real MTA reads this from
   *  Postmaster Tools / SNDS feeds. */
  reputation: number;
  /** When false, the rotation policy never picks this pool. Lets
   *  operators pause a pool (e.g. while investigating a bounce
   *  spike) without deleting it. */
  active: boolean;
  /** Exactly one pool per account is the default — picked when no
   *  more-specific rule (kind / sending-domain assignment) matches.
   *  The CP enforces single-default at write time. */
  isDefault: boolean;
  /** Free-text label for the operator. */
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/** What an inbound call to a number does (plan §4.5 — voice routing). */
export type CallRoutingAction =
  | "forward"
  | "voicemail"
  | "reject"
  | "app_webhook";

/** A project's own SMS number — one per project. */
export interface PhoneNumber {
  id: string;
  projectId: string;
  e164: string;
  region: Region;
  status: ServiceStatus;
  apiKey: string; // secret
  /** The account-owned `MarketplaceNumber` this project number was
   *  provisioned from, when SMS was activated via `activateSms`. Used by
   *  `deactivateSms` to release the Telnyx lease + stop billing. Absent on
   *  legacy auto-wired rows. */
  marketplaceNumberId?: string;
  /** What the number can do — SMS / MMS / voice (plan §4.5). Absent on
   *  legacy rows; read as the full `["sms","mms","voice"]` default. */
  capabilities: NumberCapability[];
  /** What an inbound call to this number does. Absent on legacy rows;
   *  read as `voicemail`. */
  callRoutingAction?: CallRoutingAction;
  /** The forward destination (E.164 / SIP URI) or the app webhook URL,
   *  depending on `callRoutingAction`. */
  callRoutingTarget?: string;
  createdAt: string;
}

/** Phone-number classification — shared by the telephony provider port
 *  and the number marketplace (plan §4.5). */
export type NumberType = "local" | "toll_free" | "mobile" | "short_code";

/** A channel a phone number supports. */
export type NumberCapability = "sms" | "mms" | "voice";

/** Lifecycle state of a marketplace number. */
export type MarketplaceNumberStatus = "active" | "porting" | "released";

/** A phone number an account purchased through the Cantila SMS number
 *  marketplace (plan §4.5). Distinct from `PhoneNumber` (a project's
 *  auto-wired SMS number): a `MarketplaceNumber` is account-owned, has
 *  marketplace pricing and a lifecycle (port-in → active → released),
 *  and bills monthly through the billing system. Optionally assigned to
 *  a project. */
export interface MarketplaceNumber {
  id: string;
  accountId: string;
  /** The number itself, E.164 — globally unique. */
  e164: string;
  /** ISO-3166 country, e.g. "US". */
  country: string;
  numberType: NumberType;
  capabilities: NumberCapability[];
  /** One-time setup fee paid at purchase, in cents. */
  setupPriceCents: number;
  /** Recurring monthly lease fee, in cents. */
  monthlyPriceCents: number;
  status: MarketplaceNumberStatus;
  /** Carrier-side id from the TelephonyProvider. */
  providerId: string;
  /** Optional project this number is assigned to. */
  projectId?: string;
  /** Stripe `SubscriptionItem` id billing this number's recurring monthly
   *  lease. Set when an `active` number is wired onto the owning account's
   *  Stripe subscription; absent while `porting`, after release, or when
   *  the account has no Stripe subscription yet (billing is deferred). */
  stripeSubscriptionItemId?: string;
  purchasedAt: string;
  /** Set when the number is released. */
  releasedAt?: string;
}

/** A2P/10DLC carrier registration (plan §4.5 — US SMS regulatory).
 *  Every business sending Application-to-Person SMS in the US must
 *  register a "brand" (the business identity) and one or more
 *  "campaigns" (use cases under that brand) with The Campaign
 *  Registry, via a carrier or aggregator. Until both are approved the
 *  carrier rate-limits / blocks the traffic.
 *
 *  The schema records what the operator would submit to the carrier
 *  and tracks the approval state machine; the actual submission to
 *  TCR is infra-blocked on a carrier account. */
export type A2pRegistrationKind = "brand" | "campaign";

/** Lifecycle state of an A2P registration. Mirrors the standard TCR
 *  flow: submitted → in_review → approved | rejected | hold. `draft`
 *  is the local-only state before the operator has submitted. */
export type A2pRegistrationStatus =
  | "draft"
  | "submitted"
  | "in_review"
  | "approved"
  | "rejected"
  | "hold";

export interface A2pRegistration {
  id: string;
  accountId: string;
  kind: A2pRegistrationKind;
  /** A short human-readable name — "Cantila LLC brand", "OTP campaign", … */
  name: string;
  status: A2pRegistrationStatus;
  /** For campaigns — the `A2pRegistration.id` of the brand they belong
   *  to. Required for campaigns; absent on brands. */
  brandRegistrationId?: string;
  /** Regulatory metadata. Loose JSON because the field set differs
   *  between brand (legal name / EIN / vertical / address) and campaign
   *  (use case / sample messages / opt-in flow). The CP enforces
   *  required keys per kind at create time. */
  payload: Record<string, unknown>;
  /** Carrier-side TCR id, once the submission is acknowledged. */
  providerRegistrationId?: string;
  /** Free-text reason a registration was rejected or held — what the
   *  carrier returned, for operator visibility. */
  rejectionReason?: string;
  createdAt: string;
  submittedAt?: string;
  resolvedAt?: string;
}

/** A compute node the control plane can schedule workloads on (plan
 *  §5.5 — Bring-Your-Own-VPS). Two kinds:
 *
 *  - `managed` — provisioned and owned by Cantila on the platform fleet.
 *                Identical contract today as the synthesised `node-<region>-NN`
 *                ids that `getFleetCapacity` round-robins instances over —
 *                first-class rows replace the implicit names when the real
 *                data plane lands.
 *  - `byo`     — supplied by the tenant. They paste their SSH host into the
 *                Console; the control plane mints a one-time enrollment
 *                token; the tenant runs the Cantila node-agent on the box,
 *                which posts back with its SSH public-key fingerprint and
 *                the node flips to `active`. From then on it is a regular
 *                row in the fleet — Cantila schedules workloads on it but
 *                does NOT own the hardware. The tenant can retire it any
 *                time. */
export type NodeKind = "managed" | "byo";

/** Lifecycle of a `Node`:
 *  - `pending`  — enrollment token minted; the node-agent hasn't called back yet.
 *  - `active`   — agent completed enrollment and is heartbeating; eligible to
 *                 receive workloads.
 *  - `degraded` — heartbeats are flowing but the agent reports problems (load
 *                 saturated, a container crashed). Reads accept new schedules,
 *                 but the brain's CapacityAgent may steer traffic away.
 *  - `offline`  — no heartbeat for a while. CapacityAgent observes this; the
 *                 control plane stops scheduling new work onto it.
 *  - `retired`  — the operator decommissioned it. No new schedules; existing
 *                 instances drain. Terminal state. */
export type NodeStatus = "pending" | "active" | "degraded" | "offline" | "retired";

export interface Node {
  id: string;
  accountId: string;
  kind: NodeKind;
  /** Human label the operator picked, e.g. "my-hetzner-cx21". Free-text. */
  label: string;
  /** Region slug. Managed nodes use Cantila's region enum (fsn1/hel1/ash);
   *  BYO nodes carry their own free-text region label so an operator can
   *  group their own boxes however they like. */
  region: string;
  /** Reachable host the control plane SSHes into — IPv4, IPv6 or DNS name.
   *  Empty for synthesised managed nodes that have no real address yet. */
  host: string;
  /** SSH user the node-agent runs as. Defaults to "root". */
  sshUser: string;
  /** SHA-256 hash of the one-time enrollment token. The raw value is
   *  returned exactly once by `enrollNode` and never persisted. The agent
   *  presents the raw token at `completeNodeEnrollment` and `heartbeat`. */
  enrollmentTokenHash: string;
  /** Visible prefix of the enrollment token (e.g. "ctn_a1b2…"). Helps an
   *  operator recognise their own pending token in the Console without
   *  revealing the secret. */
  enrollmentTokenPrefix: string;
  /** SSH public-key fingerprint the node-agent presented at enrollment.
   *  Absent until the agent calls back. */
  publicKeyFingerprint?: string;
  /** Per-node instance capacity. Defaults to 16 (matches the platform's
   *  NODE_CAPACITY constant); the agent can report a different number at
   *  enrollment based on the box's actual vCPU / RAM. */
  capacityInstances: number;
  status: NodeStatus;
  /** Last reported running-instance count from the agent. */
  reportedInstances?: number;
  /** Last reported load% from the agent — wire it into CapacityAgent
   *  alongside the synthesised platform-side load. */
  reportedLoadPct?: number;
  /** When the agent first completed enrollment. */
  enrolledAt?: string;
  /** When the agent last heartbeat-ed. The brain treats absence of recent
   *  heartbeats as `offline`. */
  lastHeartbeatAt?: string;
  /** When the operator retired the node. */
  retiredAt?: string;
  createdAt: string;
}

/** An inbound SMS message received on a project's phone number (plan
 *  §4.5 — two-way SMS). Persisted message history — distinct from the
 *  bounded in-memory SMS event ring, which keeps only rollup telemetry
 *  (counts, rates) and no message bodies. */
export interface InboundMessage {
  id: string;
  accountId: string;
  projectId: string;
  /** The Cantila number the message was received on, E.164. */
  toE164: string;
  /** The external sender, E.164. */
  fromE164: string;
  body: string;
  /** A recognised compliance keyword, when the body is one. */
  keyword?: "stop" | "start" | "help";
  /** Carrier-side message id. */
  providerMessageId: string;
  receivedAt: string;
}

/** An inbound mail message received on one of the project's sending
 *  domains (plan §4.4 — two-way mail). Persisted message history —
 *  distinct from the bounded in-memory mail event ring, which keeps
 *  only rollup telemetry (counts, rates) and no message bodies. Same
 *  shape as `InboundMessage` (SMS) so the two stories stay symmetrical. */
export interface InboundMail {
  id: string;
  accountId: string;
  projectId: string;
  /** The Cantila address the message was delivered to (e.g. `support@yourdomain.com`). */
  toAddress: string;
  /** The external sender. */
  fromAddress: string;
  subject: string;
  body: string;
  /** Carrier / MTA-side message id (RFC 5322 Message-ID when present). */
  providerMessageId: string;
  /** The `MailAlias.id` that matched `toAddress`, when one did. Absent
   *  when the message landed directly on a `HostedMailbox` address. */
  matchedAliasId?: string;
  /** Where the alias / inbox routing pointed the message — copy of the
   *  alias's `target` at receive time so the audit trail survives an
   *  alias edit afterward. */
  routedTo?: string;
  receivedAt: string;
}

/** An inbound voice call received on a project's phone number (plan §4.5
 *  — two-way voice). Persisted call history; an append-only log, the
 *  voice counterpart of `InboundMessage`. */
export interface InboundCallRecord {
  id: string;
  accountId: string;
  projectId: string;
  /** The Cantila number the call came in on, E.164. */
  toE164: string;
  /** The external caller, E.164. */
  fromE164: string;
  /** Carrier-side call id. */
  providerCallId: string;
  /** The routing action Cantila applied to the call. */
  routingAction: CallRoutingAction;
  receivedAt: string;
}

export interface EnvVar {
  id: string;
  projectId: string;
  key: string;
  value: string;
  secret: boolean;
  scope: EnvScope;
  updatedAt: string;
}

export interface Deployment {
  id: string;
  projectId: string;
  status: DeployStatus;
  trigger: DeployTrigger;
  runtime: Runtime;
  imageRef?: string;
  nodeId?: string;
  url?: string;
  logs: string[]; // ordered pipeline step trace
  /** Source-tracking metadata, set when the deploy originated from git. */
  commitHash?: string;
  commitMessage?: string;
  branch?: string;
  /** Preview environments (plan §5.1). When set, this deployment is a
   *  branch preview — its URL is derived from `{slug}-{previewBranch}.cantila.app`
   *  and it does NOT supersede the project's production live deployment.
   *  Filtering by `previewBranch !== undefined` gives the preview list. */
  previewBranch?: string;
  createdAt: string;
}

/** A hostname attached to a project. The free `*.cantila.app` subdomain is
 *  created with the project; custom domains are added later. */
export interface Domain {
  id: string;
  projectId: string;
  hostname: string;
  kind: DomainKind;
  sslActive: boolean;
  primary: boolean;
  createdAt: string;
}

/** Vertical (vcpu/memory/disk/alwaysOn) AND horizontal (instance counts)
 *  resize. Applied to the project record; the data plane consults the
 *  fields on next deploy + on any live instance-count change. */
export interface ScaleSpec {
  vcpu?: number;
  memoryMb?: number;
  diskGb?: number;
  alwaysOn?: boolean;
  desiredInstances?: number;
  minInstances?: number;
  maxInstances?: number;
}

/** One project-wide load sample at a point in time (plan §5.2 — real
 *  CPU/RPS metrics for ScaleAgent). Rolled-up across instances — the
 *  data plane is responsible for the aggregation. The stub data plane
 *  synthesises plausible values from project state; the real one will
 *  read from Docker / kube stats + the LB's request counters.
 *
 *  ScaleAgent reads a window of these to decide whether sustained load
 *  warrants a scale-up — replacing the "deploy frequency as a proxy"
 *  heuristic the agent uses today (see plan §15.2). */
export interface ProjectMetricSample {
  at: string;
  /** Average CPU utilisation across instances, 0–100. */
  cpuPct: number;
  /** Average memory utilisation across instances, 0–100. */
  memPct: number;
  /** Total requests per second across instances. */
  rps: number;
}

/** Live state of a single container instance running this project. Used
 *  by `GET /v1/projects/:id/instances` to render the per-instance health
 *  view (plan §5.2). */
export interface Instance {
  id: string;
  projectId: string;
  /** 0-indexed within the project's instance set. */
  index: number;
  nodeId: string;
  region: Region;
  status: "starting" | "healthy" | "draining" | "crashed";
  startedAt: string;
}

/** An S3-compatible object-storage bucket (plan §4.6 — Cantila Data).
 *  Buckets belong to a project and pair with the bundled database; "public"
 *  buckets serve assets via the Cantila CDN when enabled. */
export interface StorageBucket {
  id: string;
  projectId: string;
  name: string; // globally unique, dash-separated
  region: Region;
  publicRead: boolean;
  cdn: boolean;
  /** Logical counters — production fills these from object-store telemetry. */
  objects: number;
  sizeGb: number;
  createdAt: string;
}

/** A domain Cantila has registered on behalf of an account (plan §4.7).
 *  This is the registrar product — separate from `Domain`, which represents
 *  a hostname *attached* to a project. A `DomainRegistration` can later be
 *  wired up to a project by creating a `Domain` row pointing at it. */
export interface DomainRegistration {
  id: string;
  accountId: string;
  hostname: string;
  tld: string;
  pricePerYearCents: number;
  /** ISO date when the registration auto-renews. */
  expiresAt: string;
  whoisPrivacy: boolean;
  autoRenew: boolean;
  /** Optional link — the project this domain is currently attached to. */
  attachedProjectId?: string;
  createdAt: string;
}

/** A snapshot of a project at a point in time (plan §5.5 — "Automated
 *  daily backups, point-in-time restore"). Captures the live deployment
 *  id + a copy of every env var so restore can roll the deployment back
 *  AND re-apply the configuration that was paired with it.
 *
 *  Database backups (the actual data) are referenced by `databaseSnapshotId`
 *  — production wires that to the managed Postgres' WAL archive; the
 *  in-memory store treats it as an opaque label. */
export interface Backup {
  id: string;
  projectId: string;
  accountId: string;
  /** The live deployment captured at backup time. Restoring rolls back
   *  the project to this deployment. */
  deploymentId: string;
  /** Snapshot of every env var on the project at backup time. The shape
   *  matches `EnvVar` minus `id` / `updatedAt` so applying it is a series
   *  of upserts. */
  envVars: Array<{
    key: string;
    value: string;
    secret: boolean;
    scope: EnvScope;
  }>;
  /** Opaque reference into the database snapshot system. Set to the
   *  database id when the project has a managed db; null otherwise. */
  databaseSnapshotId: string | null;
  /** Free-form note from the operator (CLI `--note`). */
  note?: string;
  /** What triggered the backup — operator-issued vs. automatic pre-deploy. */
  trigger: "manual" | "auto-pre-deploy";
  createdAt: string;
}

/** A scoped API key. The raw key is shown to the user exactly once at
 *  creation time; only the SHA-256 hash is persisted (plan §5.4 — account
 *  security: "scoped API keys"). */
export interface ApiKey {
  id: string;
  accountId: string;
  name: string;
  scope: ApiKeyScope;
  prefix: string; // visible prefix, e.g. ctk_li (for lookups in the UI)
  hash: string; // sha256(rawKey)
  lastUsedAt?: string;
  createdAt: string;
}
