/* ============================================================
   ControlPlane — the shared service layer.
   The single core behind every transport: the HTTP API and the
   MCP server both call these methods (plan §7.1).
   ============================================================ */

import type { Store } from "../domain/store";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  Account,
  AccountBrandingPatch,
  AccountPlan,
  Project,
  ManagedDatabase,
  Mailbox,
  HostedMailbox,
  CreatedHostedMailbox,
  MailAlias,
  MailAliasKind,
  MailboxKind,
  PhoneNumber,
  Deployment,
  Domain,
  Runtime,
  Region,
  DeployTrigger,
  EnvScope,
  DbEngine,
  ScaleSpec,
  Instance,
  ProjectMetricSample,
  ApiKey,
  ApiKeyScope,
  Backup,
  DomainRegistration,
  StorageBucket,
  ActivityKind,
  TeamMember,
  MemberRole,
  AuthUser,
  Invite,
  AccountBillingStatus,
  DunningNotice,
  MarketplaceNumber,
  NumberType,
  NumberCapability,
  A2pRegistration,
  A2pRegistrationKind,
  A2pRegistrationStatus,
  MailIpPool,
  MailIpPoolKind,
  Node,
  NodeKind,
  NodeStatus,
  CallRoutingAction,
  InboundMessage,
  InboundCallRecord,
  InboundMail,
  AutomationKind,
  Connection,
  ConnectionAuthKind,
  ConnectionAuditEvent,
  WorkflowExecutionRecord,
  WorkflowExecutionEvent,
} from "../domain/types";
import type { ServiceProvisioner } from "../deploy/provisioning";
import {
  runDeploy,
  type DataPlane,
  type DeploySource,
  type DeployOutcome,
  type DeployStepEvent,
} from "../deploy/pipeline";
import { UptimeChecker, type UptimeMonitor } from "../monitoring/uptime";
import { AgentBrain, createDefaultBrain } from "../agents";
import type { AgentName, BrainSnapshot } from "../agents";
import {
  type StripeAdapter,
  type StripeEvent,
  type StripeInvoice,
  type StripePriceTier,
  STRIPE_PRICE_IDS,
} from "../billing/stripe";
import type {
  ProrationPreview,
  PlanChangeResult,
  ProrationBehavior,
  ProrationInput,
} from "../billing/proration";
import type { AiAnalyser } from "../ai/analyser";
import { ClaudeAiAnalyser } from "../ai/claude";
import { id, now, secret } from "../lib/ids";
import { getRequestContext } from "../lib/request-context";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../lib/secrets";
import { hashPassword, verifyPassword } from "../auth/passwords";
import {
  getSsoProvider,
  availableSsoProviders,
  type SsoProfile,
} from "../auth/sso";
import { generatePkceVerifier, derivePkceChallenge } from "../auth/pkce";
import {
  mintOneShotToken,
  parsePresentedToken,
  evaluateTokenVerification,
  effectiveTokenStatus,
  TOKEN_POLICY,
  type OneShotToken,
  type TokenPurpose,
  type TokenVerifyOutcome,
} from "../auth/tokens";
import { mailProvider } from "../mail/provider";
import { mailboxProvisioner } from "../mail/provisioner";
import {
  DUNNING_POLICY,
  DUNNING_GRACE_DAYS,
  normaliseStatus,
  isDeployBlocked,
  onPaymentFailed,
  onPaymentSucceeded,
  onGraceExpiry,
  onSubscriptionDeleted,
  type DunningTransition,
} from "../billing/dunning";
import {
  OTP_POLICY,
  generateOtpCode,
  hashOtpCode,
  renderOtpMessage,
  evaluateOtpVerification,
  effectiveOtpStatus,
  toOtpChallengeView,
  type OtpChallenge,
  type OtpChallengeView,
  type OtpPurpose,
  type OtpVerifyOutcome,
} from "../auth/otp";
import {
  telephonyProvider,
  type AvailableNumber,
  type InboundSmsMessage,
  type InboundCall,
  type CallRouting,
  type SmsStatusUpdate,
  type CallStatusUpdate,
  type VoiceAgentConfig,
  type VoiceAgentEvent,
} from "../sms/provider";
import { isComplianceRejection } from "../sms/telnyx";

export interface ControlPlaneDeps {
  store: Store;
  provisioner: ServiceProvisioner;
  dataPlane: DataPlane;
  stripe: StripeAdapter;
  aiAnalyser: AiAnalyser;
  /** Optional — wired by the HTTP boot (`src/index.ts`) so the CP can
   *  reach into the automation engines for the AutomationAgent's
   *  workflow-health rollup (plan §4.9 + §4.10) and the credential
   *  broker (plan §15.5 Phase F). Lookups here defensive-swallow when
   *  an engine is unreachable. */
  engineRegistry?: {
    labels?: { get(kind: "n8n" | "openclaw"): string | undefined };
    get(kind: "n8n" | "openclaw"): {
      listWorkflows(instanceId: string): Promise<
        {
          id: string;
          name: string;
          active: boolean;
          lastRunStatus?: "success" | "failed" | "running";
          lastRunAt?: string;
        }[]
      >;
      bindConnection?: (
        instanceId: string,
        connectionId: string,
        ctx?: {
          provider: string;
          payload: Record<string, string>;
          name?: string;
        },
      ) => Promise<{
        engineCredentialId: string;
        expiresAt: string;
        pushed?: boolean;
      }>;
      unbindConnection?: (
        instanceId: string,
        engineCredentialId: string,
      ) => Promise<void>;
    };
  };
  /** Optional — resolves a Cantila secret reference to its underlying
   *  payload. Used by the credential broker (plan §15.5 Phase F) so
   *  `bindConnectionForRun` can push real bytes into the engine. When
   *  absent (older HTTP boots), the broker falls back to calling
   *  `adapter.bindConnection` with no context — same shape as the
   *  Phase B placeholder path. */
  resolveSecret?: (ref: string) => Promise<Record<string, string> | null>;
}

export interface CreateProjectInput {
  name: string;
  accountId: string;
  runtime: Runtime;
  region: Region;
}

export interface EnvView {
  key: string;
  value: string;
  secret: boolean;
  scope: EnvScope;
}

export interface ProjectDetail {
  project: Project;
  services: {
    database: ManagedDatabase | null;
    mailbox: Mailbox | null;
    phoneNumber: PhoneNumber | null;
  };
  deployments: Deployment[];
  domains: Domain[];
}

export interface DeploymentLogs {
  deploymentId: string;
  status: string;
  logs: string[];
}

export type AlertSeverity = "critical" | "warning" | "info";

/** A surfaced alert — derived from recent `alert`-kind events plus any
 *  currently-crashed projects. Sticky until acknowledged client-side. */
export interface MonitoringAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  projectId?: string;
  at: string;
}

/** Status-page component — a coarse service rollup shown on the public
 *  status page and in the Monitoring header. Status is derived from
 *  underlying signals (project crashes, uptime monitors, etc.). */
export interface StatusComponent {
  name: string;
  status: "up" | "degraded" | "down";
  /** Short reason — used when status != "up". */
  reason?: string;
}

export type IncidentState =
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved";

export interface IncidentUpdate {
  at: string;
  state: IncidentState;
  note: string;
}

/** A synthesised incident — one per recently-crashed project. Auto-resolves
 *  when the project's next deploy succeeds. Operators can later declare
 *  manual incidents through a future endpoint. */
export interface Incident {
  id: string;
  title: string;
  severity: AlertSeverity;
  state: IncidentState;
  projectId?: string;
  startedAt: string;
  duration: string;
  summary: string;
  updates: IncidentUpdate[];
}

export interface MonitoringSnapshot {
  at: string;
  monitors: UptimeMonitor[];
  alerts: MonitoringAlert[];
  statusComponents: StatusComponent[];
  incidents: Incident[];
  /** Account-wide rollup. */
  summary: {
    monitorsUp: number;
    monitorsDegraded: number;
    monitorsDown: number;
    avgUptimePct: number;
    activeAlerts: number;
    openIncidents: number;
  };
}

/* ----- billing (plan §8) ----- */

export type PlanTier = "hobby" | "starter" | "pro" | "agency" | "dedicated";

export interface BillingPlan {
  tier: PlanTier;
  /** Display name, e.g. "Pro". */
  name: string;
  /** Monthly price in cents. */
  priceCents: number;
  tagline: string;
  /** Caps for the metered usage rows. */
  limits: {
    projects: number;
    bandwidthGb: number;
    storageGb: number;
    monthlyEmails: number;
    monthlySms: number;
  };
}

export interface UsageMeter {
  label: string;
  used: number;
  limit: number;
  unit: string;
}

export interface InvoiceLineItem {
  id: string;
  kind: "subscription" | "domain" | "number" | "compute" | "bandwidth" | "storage";
  description: string;
  amountCents: number;
  at: string;
}

export interface BillingSummary {
  plan: BillingPlan;
  periodStart: string;
  periodEnd: string;
  /** Total to-date for the current month in cents. */
  monthToDateCents: number;
  /** Linear projection through the end of the month. */
  projectedCents: number;
  usage: UsageMeter[];
  /** Recent invoice line items — registrar purchases are real, the rest are
   *  illustrative until full metering lands. Newest first. */
  recentCharges: InvoiceLineItem[];
  /** All plans (so the Console can render the tier picker without hard-coding). */
  catalog: BillingPlan[];
}

/** Aggregated counters for the Console dashboard (plan §4.8 — control surface). */
export interface AccountMetrics {
  /** When the snapshot was taken. */
  at: string;
  totals: {
    projects: number;
    liveProjects: number;
    buildingProjects: number;
    sleepingProjects: number;
    crashedProjects: number;
    deployments: number;
    deploysLast24h: number;
    deploysLast7d: number;
    deployTriggers: Record<DeployTrigger, number>;
    domains: number;
    autoDeployRepos: number;
    services: {
      databases: number;
      mailboxes: number;
      phoneNumbers: number;
    };
    keys: number;
  };
  /** Spark-line series — newest-last, hourly buckets for the last 24h. */
  series: {
    deploysPerHour: number[];
    runtimes: Record<Runtime, number>;
    regions: Record<Region, number>;
  };
  /** A small breakdown the data-plane "Activity" widget can render. */
  recentDeployments: Array<
    Pick<Deployment, "id" | "projectId" | "status" | "trigger" | "url"> & {
      projectSlug: string;
      at: string;
    }
  >;
}

/** A suggested fix for a failing deploy (plan §5.6 — AI troubleshooting).
 *  Today this is pattern-based — the same shape will hold for an LLM-backed
 *  analyser swapped in behind the method. */
export interface TroubleshootSuggestion {
  /** Severity / confidence the analyser has in this recommendation. */
  confidence: "high" | "medium" | "low";
  /** One-line headline. */
  title: string;
  /** Free-form explanation. */
  body: string;
  /** Optional remediation hints — concrete actions the user can take. */
  actions?: { label: string; hint: string }[];
}

/** A right-sizing or idle-resource recommendation (plan §5.6 — AI cost
 *  optimiser). Same shape pattern as TroubleshootSuggestion so the swap-in
 *  to an LLM-backed analyser is straightforward. */
export interface CostRecommendation {
  id: string;
  kind:
    | "idle_alwayson"
    | "oversized_ram"
    | "oversized_cpu"
    | "oversized_disk"
    | "stale_project"
    | "unused_bucket"
    | "unused_domain";
  projectId?: string;
  projectName?: string;
  confidence: "high" | "medium" | "low";
  title: string;
  body: string;
  /** Estimated monthly savings, in cents. */
  savingsCentsPerMonth: number;
  /** Concrete CLI/console commands to apply the change. */
  actions?: { label: string; hint: string }[];
}

export interface CostOptimisationReport {
  at: string;
  accountId: string;
  /** Total estimated savings across all recommendations, cents/month. */
  totalSavingsCentsPerMonth: number;
  recommendations: CostRecommendation[];
}

export interface TroubleshootResult {
  deploymentId: string;
  /** Was the deploy actually unhealthy? `false` means the call was made on a
   *  healthy deployment — we still return suggestions but they're informational. */
  failed: boolean;
  /** The pipeline step that landed last — e.g. "verify-failed". */
  lastStep?: string;
  /** Ordered, newest-most-relevant first. */
  suggestions: TroubleshootSuggestion[];
  /** Direct quote of the deploy log lines we analysed. */
  excerpt: string[];
}

export interface AddDomainResult {
  domain: Domain;
  // Records the user must publish at their registrar (mocked for now —
  // the real DNS adapter will resolve target hostnames against the data plane).
  dns: { type: "CNAME" | "A"; name: string; value: string };
  ssl: "issuing" | "active";
}

/** Returned exactly once at api-key creation — the raw key is never
 *  retrievable again. Persistence stores only `key.hash`. */
export interface CreatedApiKey {
  key: ApiKey;
  /** The plaintext key, shown only on creation. */
  rawKey: string;
}

/* ----- registrar (plan §4.7) ----- */

/** TLDs Cantila Domains resells. Cents-per-year so totals stay integer.
 *
 *  Pricing strategy: undercut the market. These are wholesale-near prices —
 *  Cantila's gross margin on domains is intentionally thin because the
 *  domain is bait for the bundled hosting/email/SMS where the real margin
 *  lives. (Cf. Cloudflare Registrar, which resells at registry cost.) */
export const TLD_CATALOG: Record<string, { pricePerYearCents: number }> = {
  com: { pricePerYearCents: 899 }, //  $8.99 — vs. GoDaddy $19.99, Namecheap $10.98
  net: { pricePerYearCents: 999 }, //  $9.99
  org: { pricePerYearCents: 899 }, //  $8.99
  io: { pricePerYearCents: 2999 }, // $29.99 — vs. typical $40+
  dev: { pricePerYearCents: 1099 }, // $10.99
  app: { pricePerYearCents: 1199 }, // $11.99
  ai: { pricePerYearCents: 4999 }, // $49.99 — vs. typical $70-90
  co: { pricePerYearCents: 1999 }, // $19.99
  shop: { pricePerYearCents: 1899 }, // $18.99
  store: { pricePerYearCents: 1499 }, // $14.99
  xyz: { pricePerYearCents: 199 }, //  $1.99 — cheapest TLD in the catalog
  build: { pricePerYearCents: 1199 }, // $11.99
  site: { pricePerYearCents: 299 }, //  $2.99
  online: { pricePerYearCents: 299 }, // $2.99
  tech: { pricePerYearCents: 599 }, //  $5.99
  me: { pricePerYearCents: 999 }, //  $9.99
};

/* ----- public marketing pricebook (plan §4.7 / §8.2) -----
 *
 *  The Console's /billing surface reads its own per-account state from
 *  the live Stripe rail; the apex marketing pages at cantila.app/pricing
 *  used to ship a static mirror of these numbers in
 *  `cantila-console/src/data/{tld-prices,plan-tiers}.ts`. That left two
 *  drift surfaces — the catalog above and the marketing copy — that had
 *  to be hand-kept in sync every time §4.7/§8.2 moved. We close the loop
 *  by exposing both shapes on `GET /v1/billing/info`; the marketing
 *  page server-fetches at request time, with the vendored static file as
 *  a last-resort fallback when the control plane is unreachable. */

/** Retail benchmark + marketing note for each TLD in `TLD_CATALOG`.
 *  Display prices are derived from `pricePerYearCents` at serve time so
 *  there's no second number to drift. Keep new TLDs added to the catalog
 *  in this map too, or the API just omits the retail/note for them. */
const TLD_MARKETING_META: Record<
  string,
  { retail?: string; note?: string }
> = {
  com: { retail: "$12–20", note: "Below every major retail registrar" },
  net: { retail: "$15" },
  org: { retail: "$12–15" },
  io: { retail: "$40–50" },
  dev: { retail: "$15" },
  app: { retail: "$18" },
  ai: { retail: "$80–100" },
  co: { retail: "$30" },
  shop: { retail: "$35" },
  store: { retail: "$50" },
  xyz: { retail: "$9–12", note: "Cheapest in catalog" },
  build: { retail: "$30" },
  site: { retail: "$25" },
  online: { retail: "$30" },
  tech: { retail: "$40" },
  me: { retail: "$20" },
};

/** Stable order for the marketing table — ascending by Cantila price. */
const TLD_MARKETING_ORDER: readonly string[] = [
  "xyz",
  "site",
  "online",
  "tech",
  "com",
  "org",
  "me",
  "net",
  "dev",
  "app",
  "build",
  "store",
  "shop",
  "co",
  "io",
  "ai",
];

/** Marketing-table row — what the public pricing page renders. */
export interface PublicTldPrice {
  tld: string; //  e.g. ".com"
  perYear: string; //  e.g. "$8.99"
  retail?: string; //  e.g. "$12–20"
  note?: string;
}

/** Build the public marketing pricebook from `TLD_CATALOG` + the
 *  benchmark metadata. Single source of truth for cents-per-year. */
function buildPublicTldPricebook(): PublicTldPrice[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const tld of TLD_MARKETING_ORDER) {
    if (TLD_CATALOG[tld]) {
      ordered.push(tld);
      seen.add(tld);
    }
  }
  // Any TLD added to the catalog but not yet in the marketing order
  // still appears (sorted by price ascending) — better than silently
  // dropping it from the public table.
  const extras = Object.keys(TLD_CATALOG)
    .filter((t) => !seen.has(t))
    .sort(
      (a, b) =>
        TLD_CATALOG[a]!.pricePerYearCents - TLD_CATALOG[b]!.pricePerYearCents,
    );
  for (const tld of extras) ordered.push(tld);

  return ordered.map((tld) => {
    const cents = TLD_CATALOG[tld]!.pricePerYearCents;
    const meta = TLD_MARKETING_META[tld] ?? {};
    return {
      tld: `.${tld}`,
      perYear: `$${(cents / 100).toFixed(2)}`,
      retail: meta.retail,
      note: meta.note,
    };
  });
}

/** Marketing tier — what the public /pricing page renders. The Console's
 *  in-app billing surface reads per-account state from Stripe; this is
 *  the catalog the un-authed visitor sees. */
export interface PublicPlanTier {
  slug: "hobby" | "starter" | "pro" | "agency" | "dedicated";
  name: string;
  price: string;
  priceCadence?: string;
  best: string;
  bullets: string[];
  cta: { label: string; href: string };
  featured?: boolean;
}

/** Marketing pricing catalog — mirrors plan §8.2. Numbers are
 *  illustrative against measured infra cost; the exact figure on the
 *  invoice is whatever Stripe says it is. */
export const PUBLIC_PLAN_TIERS: PublicPlanTier[] = [
  {
    slug: "hobby",
    name: "Hobby",
    price: "$0",
    priceCadence: "/ mo",
    best: "Trying Cantila and side projects.",
    bullets: [
      "1 small app on a *.cantila.app subdomain",
      "Sleeps when idle",
      "Auto-wired Postgres, ready in the env",
      "Community support",
    ],
    cta: { label: "Start free", href: "/signup" },
  },
  {
    slug: "starter",
    name: "Starter",
    price: "~$10",
    priceCadence: "/ mo",
    best: "Indie hackers shipping a real product.",
    bullets: [
      "A few always-on apps",
      "1 custom domain included",
      "1 managed database",
      "Email + SMS quotas, metered overage",
      "Build minutes + 50 GB transfer",
    ],
    cta: { label: "Start on Starter", href: "/signup?plan=starter" },
    featured: true,
  },
  {
    slug: "pro",
    name: "Pro",
    price: "~$35",
    priceCadence: "/ mo",
    best: "Serious solo builders and small teams.",
    bullets: [
      "More apps and more resources per app",
      "Auto-scaling and preview environments",
      "Multiple databases, branching, point-in-time restore",
      "Priority support",
    ],
    cta: { label: "Start on Pro", href: "/signup?plan=pro" },
  },
  {
    slug: "agency",
    name: "Agency",
    price: "~$99+",
    priceCadence: "/ mo",
    best: "Agencies and resellers.",
    bullets: [
      "White-label sub-accounts",
      "Team seats and role-based access",
      "Wholesale add-on pricing",
      "Per-account branding and billing rollup",
    ],
    cta: { label: "Talk to sales", href: "/contact?topic=agency" },
  },
  {
    slug: "dedicated",
    name: "Dedicated",
    price: "Custom",
    best: "Workloads needing isolation or an SLA.",
    bullets: [
      "Dedicated VPS nodes",
      "SSO and audit log export",
      "Uptime SLA",
      "Hands-on support",
    ],
    cta: { label: "Contact us", href: "/contact?topic=dedicated" },
  },
];

/** Public-facing billing catalog — both shapes the apex /pricing page
 *  needs. Stable contract: the marketing page server-fetches this and
 *  falls back to its own vendored copy if the control plane is
 *  unreachable. Plan §4.7 / §8.2. */
export interface PublicBillingCatalog {
  tldPrices: PublicTldPrice[];
  planTiers: PublicPlanTier[];
}

export function getPublicBillingCatalog(): PublicBillingCatalog {
  return {
    tldPrices: buildPublicTldPricebook(),
    planTiers: PUBLIC_PLAN_TIERS,
  };
}

export interface DomainQuote {
  hostname: string;
  tld: string;
  available: boolean;
  pricePerYearCents: number;
  /** USD-formatted helper for the Console UI. */
  pricePerYearDisplay: string;
}

export interface RegisterDomainInput {
  accountId: string;
  hostname: string;
  years?: number;
  whoisPrivacy?: boolean;
  autoRenew?: boolean;
  /** Optional — attach to this project on registration. */
  projectId?: string;
}

/* ----- secret masking ----- */

function mask(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/** "+14155558642" → "+•••••••8642". Last four digits are visible (enough
 *  for support to confirm a customer's number) while the prefix and most
 *  of the digits stay hidden so a dumped SmsEventRecord can't be used to
 *  rebuild the customer's recipient list. */
function maskPhone(e164: string): string {
  const digits = e164.replace(/[^\d]/g, "");
  if (digits.length <= 4) return e164;
  return `+${"•".repeat(Math.max(1, digits.length - 4))}${digits.slice(-4)}`;
}

/** Resolve a number's stored call-routing rule into a `CallRouting`
 *  decision for the carrier (plan §4.5). Missing rule → voicemail. */
function callRoutingOf(n: PhoneNumber): CallRouting {
  const action = n.callRoutingAction ?? "voicemail";
  if (action === "forward") {
    return { action: "forward", destination: n.callRoutingTarget };
  }
  if (action === "app_webhook") {
    return { action: "app_webhook", webhookUrl: n.callRoutingTarget };
  }
  return { action }; // voicemail | reject
}

/** "ada.lovelace@example.com" → "ada.lovelace@e…example.com". Keeps the
 *  local part (lawful basis for showing back, plus essential for debug)
 *  but masks the bulk of the domain so a dumped MailEventRecord can't be
 *  used to enumerate a customer's recipient list. */
function maskEmail(addr: string): string {
  const at = addr.lastIndexOf("@");
  if (at < 0) return addr;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (domain.length <= 2) return `${local}@${domain}`;
  return `${local}@${domain[0]}…${domain.slice(-Math.min(domain.length - 2, 10))}`;
}

function maskDatabase(d: ManagedDatabase | null): ManagedDatabase | null {
  return d ? { ...d, connectionUri: mask(d.connectionUri) } : null;
}

/** Strip `webhookSecret` from a Project before it leaves the control
 *  plane. The plaintext secret is only returned in the response envelopes
 *  of `connectGit` and `rotateWebhookSecret` — never on standard reads,
 *  the same one-time-reveal contract API keys use. */
function stripWebhookSecret(p: Project): Project {
  if (!p.webhookSecret) return p;
  const { webhookSecret: _ws, ...rest } = p;
  return rest;
}

function stripList(ps: Project[]): Project[] {
  return ps.map(stripWebhookSecret);
}

function maskMailbox(m: Mailbox | null): Mailbox | null {
  return m ? { ...m, smtpPassword: mask(m.smtpPassword) } : null;
}

/** Strip the per-tenant Anthropic API key from an Account before it
 *  leaves the control plane. The plaintext key is set once by the
 *  Settings UI and never echoed afterwards — only the prefix shows up
 *  on subsequent reads, the same one-time-reveal contract API keys use. */
function maskAccount(a: Account | null): Account | null {
  if (!a) return null;
  if (!a.anthropicApiKey) return a;
  // The stored key may be an `enc.v1.` envelope (encrypted at rest) —
  // never slice a prefix off ciphertext. Per-account keys are always
  // Anthropic keys, so an encrypted value masks to the standard prefix.
  const prefix = isEncryptedSecret(a.anthropicApiKey)
    ? "sk-ant-api"
    : a.anthropicApiKey.slice(0, 10);
  return { ...a, anthropicApiKey: `${prefix}••••••••` };
}

function maskNumber(n: PhoneNumber | null): PhoneNumber | null {
  return n ? { ...n, apiKey: mask(n.apiKey) } : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Verify an HMAC-SHA256 signature against the raw request body.
 *  Accepts either GitHub-style `sha256=<hex>` or a bare hex digest, both
 *  of which we recommend so the same secret works with GitHub's native
 *  webhook UI and a curl-from-CI bare-hex push. Comparison is constant-time
 *  so a single byte difference doesn't leak through timing. */
function verifyHmacSignature(
  secret: string,
  rawBody: string,
  signature: string,
): boolean {
  const supplied = signature.trim().toLowerCase().replace(/^sha256=/, "");
  if (!/^[0-9a-f]+$/.test(supplied)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (supplied.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  } catch {
    return false;
  }
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  return `${Math.round(ms / 86_400_000)}d`;
}

/** Plan tiers — illustrative pricing matching §8.2. Limits are caps the UI
 *  meters against; production will replace them with database-backed values. */
const PLAN_CATALOG: BillingPlan[] = [
  {
    tier: "hobby",
    name: "Hobby",
    priceCents: 0,
    tagline: "Trying Cantila, side projects",
    limits: {
      projects: 1,
      bandwidthGb: 10,
      storageGb: 1,
      monthlyEmails: 100,
      monthlySms: 0,
    },
  },
  {
    tier: "starter",
    name: "Starter",
    priceCents: 1000,
    tagline: "Indie hackers shipping a real product",
    limits: {
      projects: 5,
      bandwidthGb: 100,
      storageGb: 10,
      monthlyEmails: 5000,
      monthlySms: 100,
    },
  },
  {
    tier: "pro",
    name: "Pro",
    priceCents: 3500,
    tagline: "Serious solo builders & small teams",
    limits: {
      projects: 25,
      bandwidthGb: 1000,
      storageGb: 100,
      monthlyEmails: 50_000,
      monthlySms: 1000,
    },
  },
  {
    tier: "agency",
    name: "Agency",
    priceCents: 9900,
    tagline: "Agencies & resellers · white-label",
    limits: {
      projects: 100,
      bandwidthGb: 5000,
      storageGb: 500,
      monthlyEmails: 250_000,
      monthlySms: 10_000,
    },
  },
];

/** Map an Account plan to its self-serve Stripe price tier. `dedicated`
 *  is sales-led — it has no catalog Price, so proration doesn't apply. */
function tierOf(plan: AccountPlan): StripePriceTier | null {
  return plan === "dedicated" ? null : plan;
}

/** Monthly list price for a tier, in cents, from the plan catalog. */
function priceCentsOf(tier: StripePriceTier): number {
  return PLAN_CATALOG.find((p) => p.tier === tier)?.priceCents ?? 0;
}

/** The current calendar-month billing period — the same window
 *  `getBillingSummary` meters against, so a proration computed here
 *  lines up with what the customer sees on the billing page. */
function currentBillingPeriod(): { start: string; end: string } {
  const n = new Date();
  const start = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
  const end = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Retail pricebook for the number marketplace (plan §4.5) — one-time
 *  setup + recurring monthly lease, per number type, in cents. Cantila
 *  prices numbers as a margin product, the way Cantila Domains prices
 *  TLDs. Short codes are intentionally expensive — they are a scarce,
 *  carrier-vetted resource. */
const NUMBER_PRICEBOOK: Record<
  NumberType,
  { setupCents: number; monthlyCents: number }
> = {
  local: { setupCents: 100, monthlyCents: 150 },
  toll_free: { setupCents: 200, monthlyCents: 300 },
  mobile: { setupCents: 150, monthlyCents: 250 },
  short_code: { setupCents: 100_000, monthlyCents: 150_000 },
};

function mintRawKey(): string {
  // ctk = Cantila Key. The `_live_` segment leaves room for `_test_` later.
  return `ctk_live_${randomBytes(24).toString("hex")}`;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project"
  );
}

function isValidHostname(host: string): boolean {
  // RFC-1123-ish: letters/digits/hyphens in each label, total ≤ 253 chars.
  if (host.length === 0 || host.length > 253) return false;
  const labelRe = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
  return host.split(".").every((label) => labelRe.test(label));
}

/* ----- the service ----- */

export type AuthFailureReason =
  | "no_credentials"
  | "invalid_key"
  | "scope_denied"
  | "cross_account";

/* ----- mail telemetry (plan §4.4 — Cantila Mail) -----
 *
 *  Cantila Mail is first-party (§4.4) but the actual MTA isn't built yet
 *  (§15.2). The `/v1/projects/:id/mail/send` route below is the shape the
 *  real send API will keep; today it records a `sent` event and rolls a
 *  realistic outcome (delivered / bounced / complained) into the same
 *  in-memory ring. MailAgent reads the ring to surface deliverability
 *  problems per sending domain. When the real MTA lands, only the rolling
 *  changes — the event shape and the agent stay the same. */

export type MailEventKind =
  | "sent"
  | "delivered"
  | "bounced"
  | "complained"
  | "deferred"
  | "received";

export interface MailEventRecord {
  at: string;
  kind: MailEventKind;
  projectId: string;
  accountId: string;
  mailboxId: string;
  mailboxAddress: string;
  sendingDomain: string;
  /** Message id — shared between `sent` and its terminal event so a single
   *  send can be traced through the ring. */
  messageId: string;
  /** Recipient — masked in dumps (`name@d…example.com`). */
  toMasked: string;
  /** The MailIpPool the send rode through (plan §4.4 — IP-pool rotation).
   *  Absent on legacy events and on events recorded before the account
   *  had any pool configured — the per-pool rollup tolerates absence
   *  and groups them under `pool: undefined`. In-memory only today; the
   *  durable `StoredMailEvent` does not carry it (a control-plane restart
   *  loses pool attribution but not the events themselves). */
  poolId?: string;
}

/** Per-sending-domain deliverability rollup. */
export interface MailDeliverability {
  sendingDomain: string;
  /** Number of distinct mailboxes/projects using this sending domain. */
  mailboxes: number;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  deferred: number;
  bounceRatePct: number;
  complaintRatePct: number;
}

/* ----- sms telemetry (plan §4.5 — Cantila SMS) -----
 *
 *  Same shape contract as mail telemetry: a bounded in-memory ring of
 *  outcome events recorded by a stub `cp.sendSms`, read by SmsAgent.
 *  The real SMSC swap is invisible to MailAgent and SmsAgent. Carrier-
 *  style state machine — `sent` → terminal `delivered` / `failed` /
 *  `undelivered` — plus `opt_out` for inbound STOP replies. */

export type SmsEventKind =
  | "sent"
  | "delivered"
  | "failed"
  | "undelivered"
  | "opt_out"
  // Inbound message landed on one of the account's numbers (plan §4.5).
  | "received";

export interface SmsEventRecord {
  at: string;
  kind: SmsEventKind;
  projectId: string;
  accountId: string;
  phoneNumberId: string;
  /** Sender number — E.164 (`+1415555…`). */
  fromE164: string;
  /** Shared between `sent` and its terminal event so a single send can be
   *  traced through the ring. `opt_out` events use a synthetic id. */
  messageId: string;
  /** Recipient masked to last 4 digits (`+•••••••6789`). */
  toMasked: string;
}

/** Per-number deliverability rollup. SMS has no FBL like email's complaint
 *  rate; the equivalent reputation signal is the opt-out rate. */
export interface SmsDeliverability {
  fromE164: string;
  /** Distinct projects sending from this number — almost always 1, since
   *  the auto-wiring is per-project, but resilience against future shared
   *  numbers is free. */
  projects: number;
  sent: number;
  delivered: number;
  failed: number;
  undelivered: number;
  optOut: number;
  /** Combined hard-fail rate (failed + undelivered) / terminal events. */
  failureRatePct: number;
  /** Opt-outs / sent — proxy for "the audience didn't want this". */
  optOutRatePct: number;
}

/** One rejected request — the only direct signal SecurityAgent has today.
 *  Stored in a bounded ring on the ControlPlane (never persisted) so SecurityAgent
 *  can correlate bursts without us shipping a full SIEM pipeline. */
export interface AuthFailureRecord {
  at: string;
  reason: AuthFailureReason;
  method: string;
  route: string;
  /** When the caller did present a key (scope_denied, cross_account) — surface
   *  the visible prefix so a burst can be attributed to one key. Never the raw key. */
  keyPrefix?: string;
  /** Account that owned the key, when there was one. */
  accountId?: string;
}

const AUTH_FAILURE_BUFFER = 500;
const MAIL_EVENT_BUFFER = 1000;
const SMS_EVENT_BUFFER = 1000;
const DUNNING_NOTICE_BUFFER = 500;
const OTP_CHALLENGE_BUFFER = 500;

/** How often the dunning sweep checks `past_due` accounts for an elapsed
 *  grace window. The grace clock spans weeks, so a 5-minute cadence is
 *  ample and keeps the sweep cheap. */
const DUNNING_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** How often the heartbeat sweep walks the BYO node fleet looking for
 *  stale heartbeats (plan §5.5). 60 s is fine — the offline threshold
 *  is minutes, not seconds. */
const NODE_HEARTBEAT_SWEEP_INTERVAL_MS = 60 * 1000;

/** A BYO node with no heartbeat in this window is flipped to `offline`.
 *  The next heartbeat walks it back to `active`. */
const NODE_OFFLINE_THRESHOLD_MS = 5 * 60 * 1000;

/** A BYO node whose agent reports this load% (or higher) is auto-marked
 *  `degraded` by `recordNodeHeartbeat`; lower reports walk it back to
 *  `active`. Mirrors CapacityAgent's saturated threshold. */
const NODE_DEGRADED_LOAD_PCT = 85;

/** A BYO node that has been offline this long is a candidate for
 *  CapacityAgent's `retire_stale_byo` proposal. Low confidence,
 *  destructive — operator decision, not auto-applied. */
const NODE_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Probability the stub deliverer rolls each outcome to. Sum < 1; the rest
 *  is `deferred` (the message is held for retry). These match a "healthy
 *  sender on warmed IPs" baseline; tests can shove the bounce rate up by
 *  passing `outcomeBias` to `sendMail` (used by the smoke test). */
const STUB_DELIVERY_BASELINE = {
  delivered: 0.9,
  bounced: 0.07,
  complained: 0.01,
  // remainder (0.02) → deferred
} as const;

/** SMS baseline — SMS is more reliable than email on healthy short codes,
 *  hence the higher delivered share. `opt_out` is recorded separately
 *  (inbound) so it doesn't show up in the per-send outcome roll. */
const STUB_SMS_BASELINE = {
  delivered: 0.95,
  failed: 0.03,
  undelivered: 0.02,
} as const;

/** Decide whether an agent event should be forwarded to the tenant's tool
 *  webhook, and build the request. Returns null when there is nothing to
 *  forward (not a tool call, or no tenant URL configured). Pure — unit-tested
 *  directly. */
export function agentToolForward(
  ev: VoiceAgentEvent,
  toolWebhookUrl: string | undefined,
): { url: string; body: Record<string, unknown> } | null {
  if (ev.kind !== "tool_call" || !toolWebhookUrl) return null;
  return {
    url: toolWebhookUrl,
    body: { toolName: ev.toolName, payload: ev.payload, callId: ev.callId },
  };
}

export class ControlPlane {
  private uptimeChecker: UptimeChecker;
  private brain: AgentBrain;
  /** In-memory ring of recent auth failures. Bounded — older entries fall off.
   *  Not durable on purpose: a process restart clears the slate, which is the
   *  right behaviour for a burst-detection signal. */
  private authFailures: AuthFailureRecord[] = [];
  /** In-memory ring of recent mail events. Same shape contract as the auth
   *  ring — bounded, non-durable, feeds MailAgent's bounce-rate detector. */
  private mailEvents: MailEventRecord[] = [];
  /** SMS event ring — same shape as `mailEvents`. */
  private smsEvents: SmsEventRecord[] = [];
  /** In-memory ring of rendered dunning emails (plan §8 / §15.2). The
   *  email body is real; actual delivery to the customer's inbox waits
   *  on the platform MTA, which is not yet real. Bounded, non-durable. */
  private dunningNotices: DunningNotice[] = [];
  /** Handle for the periodic dunning grace-expiry sweep. */
  private dunningTimer: ReturnType<typeof setInterval> | null = null;
  private nodeHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Live OTP challenges (plan §4.5 / §15.2), keyed by challenge id.
   *  In-memory + TTL-pruned — OTP codes are ephemeral, so a process
   *  restart just means a customer re-requests. Production would use
   *  Redis with native TTLs, or a swept database table. */
  private otpChallenges = new Map<string, OtpChallenge>();
  /** Live one-shot tokens for password reset + email verify
   *  (plan §5.4 / v1.18). In-memory + TTL-pruned — these are
   *  short-lived and a process restart just means the user
   *  re-requests. Keyed by token id. The raw token never lands
   *  here — only `sha256(<id>:<raw>)`. */
  private oneShotTokens = new Map<string, OneShotToken>();

  constructor(private deps: ControlPlaneDeps) {
    this.uptimeChecker = new UptimeChecker(
      { store: deps.store, dataPlane: deps.dataPlane },
      30_000,
    );
    // The brain wires itself with the three launch agents; we hand it
    // `this` rather than `deps` so agents can call the public API instead
    // of reaching past the encapsulation.
    this.brain = createDefaultBrain(this);
  }

  /** Begin background sweeps + agent ticks. Called by the HTTP transport on
   *  boot; the MCP server opts in too. */
  startBackgroundJobs(): void {
    // Rehydrate the SMS event ring + OTP challenge map from durable
    // storage so telemetry history and in-flight verifications survive a
    // restart (plan §15). Best-effort, fire-and-forget.
    void this.rehydrateTelemetry();
    this.uptimeChecker.start();
    this.brain.start();
    // Dunning grace-expiry sweep — escalates `past_due` accounts to
    // `suspended` once the grace clock elapses, even if no further
    // Stripe webhook arrives. `unref()` so it never holds the process up.
    if (!this.dunningTimer) {
      this.dunningTimer = setInterval(() => {
        void this.runDunningSweep();
      }, DUNNING_SWEEP_INTERVAL_MS);
      this.dunningTimer.unref?.();
    }
    // BYO node heartbeat sweep (plan §5.5) — flips silent agents to
    // `offline` so the fleet rollup and CapacityAgent reflect reality.
    // `unref()` so the timer never holds the process open.
    if (!this.nodeHeartbeatTimer) {
      this.nodeHeartbeatTimer = setInterval(() => {
        void this.runNodeHeartbeatSweep();
      }, NODE_HEARTBEAT_SWEEP_INTERVAL_MS);
      this.nodeHeartbeatTimer.unref?.();
    }
  }

  stopBackgroundJobs(): void {
    this.uptimeChecker.stop();
    this.brain.stop();
    if (this.dunningTimer) {
      clearInterval(this.dunningTimer);
      this.dunningTimer = null;
    }
    if (this.nodeHeartbeatTimer) {
      clearInterval(this.nodeHeartbeatTimer);
      this.nodeHeartbeatTimer = null;
    }
  }

  /* ----- Cantila Agents — plan §4.9 ----- */

  /** Snapshot the brain's memory + pending proposals + recent actions. */
  agentsStatus(): BrainSnapshot {
    return this.brain.snapshot();
  }

  /** Force one synchronous tick — used by `?fresh=1`. */
  async tickAgents(): Promise<void> {
    await this.brain.tick();
  }

  pauseAgents(): void {
    this.brain.pause();
  }

  resumeAgents(): void {
    this.brain.resume();
  }

  /* ----- agent brain journal (plan §4.9 — continuous learning) -----
   *
   *  Thin pass-through to the Store so the brain can persist its action
   *  journal without holding a Store reference directly. Both InMemory
   *  and Prisma back the same shape (`StoredAgentAction`). */

  async recordAgentActionDurable(
    action: import("../domain/store").StoredAgentAction,
  ): Promise<void> {
    return this.deps.store.recordAgentAction(action);
  }

  async updateAgentActionVerificationDurable(
    proposalId: string,
    verification: {
      verified: "ok" | "failed";
      verifiedAt: string;
      verifyDetail: string;
    },
  ): Promise<void> {
    return this.deps.store.updateAgentActionVerification(
      proposalId,
      verification,
    );
  }

  async listAgentActionsDurable(opts?: { limit?: number }): Promise<
    import("../domain/store").StoredAgentAction[]
  > {
    return this.deps.store.listAgentActions(opts);
  }

  /** Dev-only test seam — surface the brain's `_injectAction` so the
   *  learning loop can be exercised end-to-end without contriving real
   *  failures. Wired to `POST /v1/agents/_test/inject-action` (which is
   *  itself disabled unless `nodeEnv !== "production"`). */
  /** Dev-only test seam — simulate a process restart by wiping the
   *  brain's in-memory journal and rehydrating from the durable store. */
  async _reloadAgentJournalFromDurable(): Promise<void> {
    await this.brain._reloadFromDurable();
  }

  _injectAgentAction(input: {
    agent: AgentName;
    kind: string;
    outcome: "ok" | "failed";
    verified?: "n/a" | "pending" | "ok" | "failed";
    title?: string;
    detail?: string;
  }): void {
    this.brain._injectAction({
      at: now(),
      proposalId: `injected_${id("inj")}`,
      agent: input.agent,
      kind: input.kind,
      title: input.title ?? `Injected ${input.agent}:${input.kind}`,
      outcome: input.outcome,
      detail:
        input.detail ?? `Synthetic ${input.outcome} record (dev test seam).`,
      verified: input.verified ?? "n/a",
      verifiedAt:
        input.verified && input.verified !== "n/a" && input.verified !== "pending"
          ? now()
          : undefined,
      verifyDetail:
        input.verified === "failed"
          ? "Synthetic verify failure (dev test seam)."
          : input.verified === "ok"
            ? "Synthetic verify success (dev test seam)."
            : undefined,
    });
  }

  /* ----- security telemetry (plan §4.9 — SecurityAgent input) ----- */

  /** Record one rejected request. Called from the HTTP auth hooks. The ring
   *  is bounded; oldest entries are dropped silently. */
  recordAuthFailure(record: Omit<AuthFailureRecord, "at">): void {
    this.authFailures.push({ at: now(), ...record });
    if (this.authFailures.length > AUTH_FAILURE_BUFFER) {
      this.authFailures = this.authFailures.slice(-AUTH_FAILURE_BUFFER);
    }
  }

  /** Read auth failures, optionally newer than `sinceIso`. Newest last so
   *  callers can append-and-trim. */
  getAuthFailures(sinceIso?: string): AuthFailureRecord[] {
    if (!sinceIso) return this.authFailures.slice();
    return this.authFailures.filter((r) => r.at >= sinceIso);
  }

  /* ----- mail telemetry (plan §4.4 — MailAgent input) ----- */

  /** Append one mail event to the ring. Bounded; oldest entries drop. */
  recordMailEvent(record: Omit<MailEventRecord, "at">): void {
    const event: MailEventRecord = { at: now(), ...record };
    this.mailEvents.push(event);
    if (this.mailEvents.length > MAIL_EVENT_BUFFER) {
      this.mailEvents = this.mailEvents.slice(-MAIL_EVENT_BUFFER);
    }
    // Best-effort durable append (plan §15) — same posture as the SMS
    // event ring above: the in-memory ring stays the fast read path;
    // persisting each event lets it be rehydrated after a restart. A
    // store failure is swallowed: telemetry must never break a send.
    void this.deps.store.appendMailEvent(event).catch(() => {});
  }

  /** Read mail events, optionally newer than `sinceIso` and optionally
   *  scoped to a single account. Newest last. */
  getMailEvents(opts?: {
    sinceIso?: string;
    accountId?: string;
  }): MailEventRecord[] {
    let rows = this.mailEvents.slice();
    if (opts?.sinceIso) rows = rows.filter((r) => r.at >= opts.sinceIso!);
    if (opts?.accountId) rows = rows.filter((r) => r.accountId === opts.accountId);
    return rows;
  }

  /** Per-sending-domain deliverability rollup for an account. Only terminal
   *  events (delivered / bounced / complained / deferred) count toward the
   *  rate denominators — `sent` is the "in flight" count. */
  async getMailDeliverability(
    accountId: string,
    opts?: { sinceIso?: string },
  ): Promise<MailDeliverability[]> {
    const events = this.getMailEvents({ sinceIso: opts?.sinceIso, accountId });
    const byDomain = new Map<
      string,
      {
        mailboxes: Set<string>;
        sent: number;
        delivered: number;
        bounced: number;
        complained: number;
        deferred: number;
      }
    >();
    for (const e of events) {
      // Deliverability is an outbound-only rollup; skip inbound events.
      if (e.kind === "received") continue;
      const bucket = byDomain.get(e.sendingDomain) ?? {
        mailboxes: new Set<string>(),
        sent: 0,
        delivered: 0,
        bounced: 0,
        complained: 0,
        deferred: 0,
      };
      bucket.mailboxes.add(e.mailboxId);
      bucket[e.kind] += 1;
      byDomain.set(e.sendingDomain, bucket);
    }
    return [...byDomain.entries()]
      .map(([sendingDomain, v]) => {
        const terminal = v.delivered + v.bounced + v.complained + v.deferred;
        return {
          sendingDomain,
          mailboxes: v.mailboxes.size,
          sent: v.sent,
          delivered: v.delivered,
          bounced: v.bounced,
          complained: v.complained,
          deferred: v.deferred,
          bounceRatePct:
            terminal === 0 ? 0 : Math.round((v.bounced / terminal) * 1000) / 10,
          complaintRatePct:
            terminal === 0
              ? 0
              : Math.round((v.complained / terminal) * 1000) / 10,
        };
      })
      .sort((a, b) => b.sent - a.sent);
  }

  /** Mock send. Records a `sent` event, then synchronously rolls the
   *  outcome and records a terminal event. Returns the message id so the
   *  caller can correlate. `outcomeBias` (test-only) lets the smoke test
   *  force a high bounce rate without running real bad mail through. */
  async sendMail(
    projectId: string,
    input: {
      to: string;
      subject?: string;
      body?: string;
      outcomeBias?: { delivered?: number; bounced?: number; complained?: number };
      /** Optional kind hint for pool selection (plan §4.4). When set, the
       *  policy prefers the account's pool of that kind. */
      poolKind?: MailIpPoolKind;
    },
  ): Promise<
    { messageId: string; outcome: MailEventKind; poolId?: string } | { error: string }
  > {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const mailbox = await this.deps.store.getMailboxByProject(projectId);
    if (!mailbox) return { error: "project has no mailbox" };

    // Pick the sending IP pool *once* per send so the `sent` and the
    // terminal event ride the same row in the rollup. A future MTA reads
    // this attribution to actually route the bytes; the stub records it
    // so MailAgent / the deliverability rollup can reason per-pool.
    const poolId = await this.chooseSendingPool({
      accountId: project.accountId,
      kind: input.poolKind,
      sendingDomain: mailbox.sendingDomain,
    });

    // Hand off to the MailProvider (plan §4.4 / §17.2 — Mailcow). The
    // stub returns a `stubTerminal` so we record the terminal inline
    // (preserving today's offline-deterministic behaviour); a live MTA
    // returns `accepted: true` only and the terminal arrives later via
    // a status-webhook call to `receiveMailStatusUpdate`. Both paths
    // record the `sent` event right after hand-off so the deliverability
    // rollup sees the volume immediately.
    const hand = await mailProvider.sendMail({
      from: mailbox.address,
      to: input.to,
      subject: input.subject,
      body: input.body,
      poolId,
      outcomeBias: input.outcomeBias,
    });
    if (!hand.accepted) {
      return { error: "MTA rejected the message" };
    }

    const messageId = hand.providerMessageId || id("msg");
    const base: Omit<MailEventRecord, "at" | "kind"> = {
      projectId,
      accountId: project.accountId,
      mailboxId: mailbox.id,
      mailboxAddress: mailbox.address,
      sendingDomain: mailbox.sendingDomain,
      messageId,
      toMasked: maskEmail(input.to),
      poolId,
    };
    this.recordMailEvent({ ...base, kind: "sent" });

    // Stub path: terminal known synchronously. Live path: the status
    // webhook will record the terminal later — defer here.
    if (!hand.stubTerminal) {
      return { messageId, outcome: "sent", poolId };
    }
    const outcome = hand.stubTerminal;
    this.recordMailEvent({ ...base, kind: outcome });
    if (poolId) {
      await this.adjustPoolReputation(poolId, outcome).catch(() => {});
    }
    return { messageId, outcome, poolId };
  }

  /** Which MTA is wired — `{label, live}` from the bundled
   *  `MailProvider`. Mirrors `aiInfo` / `billingInfo` so the Console
   *  Mail page can render a "(stub)" badge when the real MTA isn't
   *  there. Plan §4.4 / §17.2. */
  mailInfo(): { label: string; live: boolean } {
    return { label: mailProvider.label, live: mailProvider.live };
  }

  /** Pick the IP pool an outbound message should ride through (plan §4.4
   *  — IP-pool rotation). Today's policy is deliberately simple — a real
   *  MTA grows kind-priority, warmup-ramp and per-domain bindings on top
   *  of this seam without changing call sites:
   *
   *    1. If `kind` is specified and the account has an active pool of
   *       that kind, prefer it.
   *    2. Otherwise the account's default pool (single-default
   *       invariant is enforced at write time in `createMailIpPool` /
   *       `updateMailIpPool`).
   *    3. If neither matches (a fresh account with no pools), return
   *       `undefined` — `sendMail` still records the event; the rollup
   *       just groups it under "no pool".
   *
   *  `sendingDomain` is the third selection axis we'll grow into — a
   *  future drop adds explicit per-domain bindings; the parameter is
   *  threaded through now so the call site doesn't need to change. */
  async chooseSendingPool(input: {
    accountId: string;
    kind?: MailIpPoolKind;
    sendingDomain?: string;
  }): Promise<string | undefined> {
    const pools = await this.deps.store.listMailIpPools(input.accountId);
    if (pools.length === 0) return undefined;
    const active = pools.filter((p) => p.active);
    if (active.length === 0) return undefined;
    if (input.kind) {
      const byKind = active.find((p) => p.kind === input.kind);
      if (byKind) return byKind.id;
    }
    const defaultPool = active.find((p) => p.isDefault);
    if (defaultPool) return defaultPool.id;
    // Fall back to the first active pool — happens when an operator has
    // active pools but cleared every `isDefault` flag (allowed by the
    // CP — see `updateMailIpPool`). Deterministic order matches the
    // store's createdAt sort.
    return active[0].id;
  }

  /** Nudge a pool's reputation in response to a terminal mail outcome
   *  (plan §4.4 — IP-pool rotation):
   *
   *    delivered  → +0.2 (slow recovery; reputation is hard to earn back)
   *    bounced    → −2   (a bounce on a real IP costs reputation)
   *    complained → −5   (FBL hits are the biggest reputation killer)
   *    deferred   → 0    (transient, no signal)
   *    received   → 0    (inbound — not a sender-reputation signal)
   *
   *  Reputation is clamped [0, 100]. The reputation column is otherwise
   *  operator-edited (the existing PATCH route), so this only nudges
   *  it — a real MTA bulk-feeds the column from Postmaster Tools /
   *  SNDS. Returns the new reputation. */
  async adjustPoolReputation(
    poolId: string,
    kind: MailEventKind,
  ): Promise<number | undefined> {
    const delta =
      kind === "delivered"
        ? 0.2
        : kind === "bounced"
          ? -2
          : kind === "complained"
            ? -5
            : 0;
    if (delta === 0) return undefined;
    const pool = await this.deps.store.getMailIpPool(poolId);
    if (!pool) return undefined;
    const next = Math.max(0, Math.min(100, Math.round((pool.reputation + delta) * 10) / 10));
    if (next === pool.reputation) return pool.reputation;
    const updated = await this.deps.store.updateMailIpPool(poolId, {
      reputation: next,
    });
    return updated.reputation;
  }

  /** Per-pool deliverability rollup for an account (plan §4.4). Mirrors
   *  `getMailDeliverability` but groups by the in-memory event's `poolId`
   *  instead of sending-domain — gives MailAgent and operators a view of
   *  "how is each IP pool actually performing". Events with no `poolId`
   *  (legacy or pre-rotation) are dropped from this rollup; they still
   *  appear in the per-domain rollup. */
  async getMailPoolDeliverability(
    accountId: string,
    opts?: { sinceIso?: string },
  ): Promise<
    Array<{
      poolId: string;
      poolName: string;
      poolKind: MailIpPoolKind;
      reputation: number;
      sent: number;
      delivered: number;
      bounced: number;
      complained: number;
      deferred: number;
      bounceRatePct: number;
      complaintRatePct: number;
    }>
  > {
    const events = this.getMailEvents({ sinceIso: opts?.sinceIso, accountId });
    const byPool = new Map<
      string,
      {
        sent: number;
        delivered: number;
        bounced: number;
        complained: number;
        deferred: number;
      }
    >();
    for (const e of events) {
      if (e.kind === "received") continue;
      if (!e.poolId) continue;
      const bucket = byPool.get(e.poolId) ?? {
        sent: 0,
        delivered: 0,
        bounced: 0,
        complained: 0,
        deferred: 0,
      };
      bucket[e.kind] += 1;
      byPool.set(e.poolId, bucket);
    }
    const pools = await this.deps.store.listMailIpPools(accountId);
    const rows = [];
    for (const [poolId, counts] of byPool.entries()) {
      const pool = pools.find((p) => p.id === poolId);
      if (!pool) continue; // pool was deleted; orphan events drop out
      const terminal = counts.delivered + counts.bounced + counts.complained + counts.deferred;
      rows.push({
        poolId,
        poolName: pool.name,
        poolKind: pool.kind,
        reputation: pool.reputation,
        ...counts,
        bounceRatePct:
          terminal === 0 ? 0 : Math.round((counts.bounced / terminal) * 1000) / 10,
        complaintRatePct:
          terminal === 0 ? 0 : Math.round((counts.complained / terminal) * 1000) / 10,
      });
    }
    return rows.sort((a, b) => b.sent - a.sent);
  }

  /* ----- sms telemetry (plan §4.5 — SmsAgent input) ----- */

  recordSmsEvent(record: Omit<SmsEventRecord, "at">): void {
    const event: SmsEventRecord = { at: now(), ...record };
    this.smsEvents.push(event);
    if (this.smsEvents.length > SMS_EVENT_BUFFER) {
      this.smsEvents = this.smsEvents.slice(-SMS_EVENT_BUFFER);
    }
    // Best-effort durable append (plan §15) — the in-memory ring above
    // stays the fast read path; persisting each event lets the ring be
    // rehydrated after a control-plane restart. A store failure is
    // swallowed: telemetry must never break an SMS send.
    void this.deps.store.appendSmsEvent(event).catch(() => {});
  }

  getSmsEvents(opts?: {
    sinceIso?: string;
    accountId?: string;
  }): SmsEventRecord[] {
    let rows = this.smsEvents.slice();
    if (opts?.sinceIso) rows = rows.filter((r) => r.at >= opts.sinceIso!);
    if (opts?.accountId) rows = rows.filter((r) => r.accountId === opts.accountId);
    return rows;
  }

  /** Per-number deliverability rollup for an account. Sorted by `sent`
   *  descending so the noisiest senders are at the top. */
  async getSmsDeliverability(
    accountId: string,
    opts?: { sinceIso?: string },
  ): Promise<SmsDeliverability[]> {
    const events = this.getSmsEvents({ sinceIso: opts?.sinceIso, accountId });
    const byNumber = new Map<
      string,
      {
        projects: Set<string>;
        sent: number;
        delivered: number;
        failed: number;
        undelivered: number;
        optOut: number;
      }
    >();
    for (const e of events) {
      const bucket = byNumber.get(e.fromE164) ?? {
        projects: new Set<string>(),
        sent: 0,
        delivered: 0,
        failed: 0,
        undelivered: 0,
        optOut: 0,
      };
      bucket.projects.add(e.projectId);
      if (e.kind === "opt_out") bucket.optOut += 1;
      else if (e.kind === "received") {
        // Inbound messages are tracked separately (durable `InboundMessage`
        // table); they don't roll up into outbound deliverability.
      } else bucket[e.kind] += 1;
      byNumber.set(e.fromE164, bucket);
    }
    return [...byNumber.entries()]
      .map(([fromE164, v]) => {
        const terminal = v.delivered + v.failed + v.undelivered;
        return {
          fromE164,
          projects: v.projects.size,
          sent: v.sent,
          delivered: v.delivered,
          failed: v.failed,
          undelivered: v.undelivered,
          optOut: v.optOut,
          failureRatePct:
            terminal === 0
              ? 0
              : Math.round(((v.failed + v.undelivered) / terminal) * 1000) / 10,
          optOutRatePct:
            v.sent === 0 ? 0 : Math.round((v.optOut / v.sent) * 1000) / 10,
        };
      })
      .sort((a, b) => b.sent - a.sent);
  }

  /** Send one SMS — hands off to the carrier through the
   *  `TelephonyProvider` port, then records `sent` plus a terminal
   *  event. The `outcomeBias` knob is test-only; a carrier-rejected
   *  hand-off fails immediately. OTP codes ride this path too. */
  async sendSms(
    projectId: string,
    input: {
      to: string;
      body?: string;
      outcomeBias?: {
        delivered?: number;
        failed?: number;
        undelivered?: number;
      };
    },
  ): Promise<
    { messageId: string; outcome: SmsEventKind } | { error: string }
  > {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const number = await this.deps.store.getPhoneNumberByProject(projectId);
    if (!number) return { error: "project has no phone number" };

    // Carrier hand-off through the TelephonyProvider port. The stub
    // accepts everything; a real carrier returns accepted=false on a
    // hard reject.
    let handoff;
    try {
      handoff = await telephonyProvider.sendSms({
        from: number.e164,
        to: input.to,
        body: input.body ?? "",
      });
    } catch (err) {
      if (isComplianceRejection(err)) return { error: "sms_compliance_required" };
      return { error: "carrier send failed" };
    }
    const messageId = handoff.providerMessageId;
    const base: Omit<SmsEventRecord, "at" | "kind"> = {
      projectId,
      accountId: project.accountId,
      phoneNumberId: number.id,
      fromE164: number.e164,
      messageId,
      toMasked: maskPhone(input.to),
    };
    this.recordSmsEvent({ ...base, kind: "sent" });

    // Terminal outcome. A rejected hand-off fails immediately. With the
    // stub, roll a delivery outcome now; with a real carrier, leave it at
    // `sent` — the terminal state arrives later via the SMS status
    // webhook (`receiveSmsStatus`).
    let outcome: SmsEventKind = "sent";
    if (!handoff.accepted) {
      outcome = "failed";
      this.recordSmsEvent({ ...base, kind: outcome });
    } else if (!telephonyProvider.live) {
      const bias = input.outcomeBias ?? {};
      const pDelivered = bias.delivered ?? STUB_SMS_BASELINE.delivered;
      const pFailed = bias.failed ?? STUB_SMS_BASELINE.failed;
      const roll = Math.random();
      if (roll < pDelivered) outcome = "delivered";
      else if (roll < pDelivered + pFailed) outcome = "failed";
      else outcome = "undelivered";
      this.recordSmsEvent({ ...base, kind: outcome });
    }
    return { messageId, outcome };
  }

  /** Record an inbound STOP / opt-out reply. The real SMSC will call this
   *  from its inbound webhook handler; the test surface drives it directly. */
  async recordSmsOptOut(
    projectId: string,
    from: string,
  ): Promise<{ ok: true } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const number = await this.deps.store.getPhoneNumberByProject(projectId);
    if (!number) return { error: "project has no phone number" };
    this.recordSmsEvent({
      kind: "opt_out",
      projectId,
      accountId: project.accountId,
      phoneNumberId: number.id,
      fromE164: number.e164,
      messageId: id("optout"),
      toMasked: maskPhone(from),
    });
    return { ok: true };
  }

  /* ----- inbound SMS & voice (plan §4.5 — receiving is first-class) -----
   *
   *  Carrier webhooks land on the routes in `index.ts`; the
   *  `TelephonyProvider` port normalizes the carrier payload, and these
   *  methods record the event and apply Cantila-side handling. */

  /** Handle an inbound SMS webhook. Parses the carrier payload through
   *  the port, records a `received` event, auto-handles a STOP keyword,
   *  and logs the message to the activity feed. */
  async receiveInboundSms(
    projectId: string,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<
    | { ok: true; from: string; keyword: InboundSmsMessage["keyword"] }
    | { error: string }
  > {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const number = await this.deps.store.getPhoneNumberByProject(projectId);
    if (!number) return { error: "project has no phone number" };

    let msg: InboundSmsMessage;
    try {
      msg = telephonyProvider.parseInboundSms(rawBody, headers);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "invalid inbound SMS",
      };
    }

    // Record the inbound message in the SMS event ring. `fromE164` holds
    // the Cantila number the message landed on (so per-number rollups
    // stay keyed correctly, as `opt_out` does); `toMasked` carries the
    // external sender.
    this.recordSmsEvent({
      kind: "received",
      projectId,
      accountId: project.accountId,
      phoneNumberId: number.id,
      fromE164: number.e164,
      messageId: msg.providerMessageId,
      toMasked: maskPhone(msg.from),
    });

    // Persist the message itself (plan §4.5 — two-way SMS history). The
    // event ring above keeps only rollup telemetry; this is the durable,
    // queryable record with the body and the un-masked sender.
    await this.deps.store.createInboundMessage({
      id: id("inb"),
      accountId: project.accountId,
      projectId,
      toE164: number.e164,
      fromE164: msg.from,
      body: msg.body,
      keyword: msg.keyword,
      providerMessageId: msg.providerMessageId,
      receivedAt: msg.receivedAt,
    });

    // STOP keyword → opt the sender out automatically.
    if (msg.keyword === "stop") {
      await this.recordSmsOptOut(projectId, msg.from);
    }
    await this.recordEvent(
      project.accountId,
      "system",
      "Inbound SMS received",
      `${maskPhone(msg.from)} → ${number.e164}${msg.keyword ? ` · ${msg.keyword}` : ""}`,
      projectId,
    );
    return { ok: true, from: maskPhone(msg.from), keyword: msg.keyword };
  }

  /** Create a hosted AI voice agent for a project. */
  async createVoiceAgent(
    projectId: string,
    input: VoiceAgentConfig,
  ): Promise<{ agentId: string; name: string } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    return telephonyProvider.createVoiceAgent(input);
  }

  /** Update a project's voice agent. */
  async updateVoiceAgent(
    projectId: string,
    agentId: string,
    input: Partial<VoiceAgentConfig>,
  ): Promise<{ agentId: string; name: string } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    return telephonyProvider.updateVoiceAgent({ agentId, ...input });
  }

  /** Delete a project's voice agent. */
  async deleteVoiceAgent(
    projectId: string,
    agentId: string,
  ): Promise<{ ok: true } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    await telephonyProvider.deleteVoiceAgent({ agentId });
    return { ok: true };
  }

  /** Bind a voice agent to the project's phone number. */
  async attachVoiceAgent(
    projectId: string,
    agentId: string,
  ): Promise<{ ok: true } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const number = await this.deps.store.getPhoneNumberByProject(projectId);
    if (!number) return { error: "project has no phone number" };
    await telephonyProvider.attachAgentToNumber({ agentId, e164: number.e164 });
    return { ok: true };
  }

  /** Handle an agent/tool webhook: parse + (for tool calls) forward to the
   *  tenant's tool webhook. `opts` is test-injectable; production reads the
   *  per-project tool URL + uses global fetch. */
  async receiveAgentEvent(
    projectId: string,
    rawBody: string,
    headers: Record<string, string>,
    opts?: { fetchImpl?: typeof fetch; toolWebhookUrl?: string },
  ): Promise<{ ok: true; kind: VoiceAgentEvent["kind"] } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    let ev: VoiceAgentEvent;
    try {
      ev = telephonyProvider.parseAgentEvent(rawBody, headers);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "invalid agent event" };
    }
    const fwd = agentToolForward(ev, opts?.toolWebhookUrl);
    if (fwd) {
      const f = opts?.fetchImpl ?? fetch;
      await f(fwd.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fwd.body),
      });
    }
    return { ok: true, kind: ev.kind };
  }

  /** Handle an inbound mail webhook (plan §4.4 — two-way mail). The real
   *  MTA does not exist yet (§15.2); a future MTA / aggregator will POST
   *  here when mail lands on one of the project's sending domains. We
   *  resolve routing against the project's `MailAlias` rules + hosted
   *  mailboxes, persist the message, and record a `received` event into
   *  the in-memory mail ring so `MailAgent` and the deliverability
   *  rollup see inbound volume alongside outbound. */
  async receiveInboundMail(
    projectId: string,
    input: {
      to: string;
      from: string;
      subject?: string;
      body?: string;
      providerMessageId?: string;
    },
  ): Promise<
    | {
        ok: true;
        from: string;
        matchedAliasId?: string;
        routedTo?: string;
      }
    | { error: string }
  > {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const mailbox = await this.deps.store.getMailboxByProject(projectId);
    if (!mailbox) return { error: "project has no mailbox" };

    const toAddress = input.to.trim().toLowerCase();
    const fromAddress = input.from.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toAddress)) {
      return { error: "to address is not a valid email" };
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromAddress)) {
      return { error: "from address is not a valid email" };
    }
    const domain = toAddress.split("@")[1];

    // Resolve routing. Preference order — exact alias > catch-all alias >
    // hosted mailbox at the address > no routing. Aliases whose `active`
    // flag is false are skipped, matching the runtime contract.
    let matchedAliasId: string | undefined;
    let routedTo: string | undefined;
    const exact = await this.deps.store.findMailAliasByAddress(toAddress);
    if (exact && exact.projectId === projectId && exact.active) {
      matchedAliasId = exact.id;
      routedTo = exact.target;
    } else {
      const catchAll = await this.deps.store.findMailAliasByAddress(
        `*@${domain}`,
      );
      if (
        catchAll &&
        catchAll.projectId === projectId &&
        catchAll.active &&
        catchAll.kind === "catch-all"
      ) {
        matchedAliasId = catchAll.id;
        routedTo = catchAll.target;
      } else {
        const hosted =
          await this.deps.store.findHostedMailboxByAddress(toAddress);
        if (hosted && hosted.projectId === projectId) {
          routedTo = hosted.address;
        }
      }
    }

    // Record into the in-memory event ring (telemetry side). Body / subject
    // / sender don't ride the ring — only rollup-level fields. `toMasked`
    // here carries the external sender (mirrors the SMS convention where
    // `toMasked` on a `received` event carries `from`).
    const messageId = input.providerMessageId ?? id("inm");
    this.recordMailEvent({
      kind: "received",
      projectId,
      accountId: project.accountId,
      mailboxId: mailbox.id,
      mailboxAddress: mailbox.address,
      sendingDomain: mailbox.sendingDomain,
      messageId,
      toMasked: maskEmail(fromAddress),
    });

    // Persist the message itself (the durable, queryable record).
    await this.deps.store.createInboundMail({
      id: id("inm"),
      accountId: project.accountId,
      projectId,
      toAddress,
      fromAddress,
      subject: input.subject ?? "",
      body: input.body ?? "",
      providerMessageId: messageId,
      matchedAliasId,
      routedTo,
      receivedAt: now(),
    });

    await this.recordEvent(
      project.accountId,
      "system",
      "Inbound mail received",
      `${maskEmail(fromAddress)} → ${toAddress}${routedTo ? ` · ${routedTo}` : " · unrouted"}`,
      projectId,
    );
    return {
      ok: true,
      from: maskEmail(fromAddress),
      matchedAliasId,
      routedTo,
    };
  }

  /** Persisted inbound mail history (plan §4.4). Project-scoped or
   *  account-wide — matches the `listInboundMessages` shape on the SMS
   *  side. */
  async listInboundMail(
    accountId: string,
    opts: { projectId?: string; limit?: number } = {},
  ): Promise<InboundMail[]> {
    return this.deps.store.listInboundMail({
      accountId,
      projectId: opts.projectId,
      limit: opts.limit,
    });
  }

  /** Handle an inbound voice-call webhook. Parses the carrier payload,
   *  logs the call, and returns the routing decision the carrier should
   *  apply — resolved from the number's stored call-routing rule. */
  async receiveInboundCall(
    projectId: string,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<
    { ok: true; from: string; routing: CallRouting } | { error: string }
  > {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const number = await this.deps.store.getPhoneNumberByProject(projectId);
    if (!number) return { error: "project has no phone number" };

    let call: InboundCall;
    try {
      call = telephonyProvider.parseInboundCall(rawBody, headers);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "invalid inbound call",
      };
    }

    const routing = callRoutingOf(number);
    // Persist the call as durable history (plan §4.5 — two-way voice),
    // the voice counterpart of the inbound-message log.
    await this.deps.store.createInboundCall({
      id: id("icl"),
      accountId: project.accountId,
      projectId,
      toE164: number.e164,
      fromE164: call.from,
      providerCallId: call.providerCallId,
      routingAction: routing.action,
      receivedAt: call.receivedAt,
    });
    await this.recordEvent(
      project.accountId,
      "system",
      "Inbound call received",
      `${maskPhone(call.from)} → ${number.e164} · ${routing.action}`,
      projectId,
    );
    return { ok: true, from: maskPhone(call.from), routing };
  }

  /** List inbound SMS messages received by an account, newest first
   *  (plan §4.5 — persisted two-way SMS history). Optionally narrowed to
   *  a single project. */
  async listInboundMessages(
    accountId: string,
    opts: { projectId?: string; limit?: number } = {},
  ): Promise<InboundMessage[]> {
    return this.deps.store.listInboundMessages({
      accountId,
      projectId: opts.projectId,
      limit: opts.limit,
    });
  }

  /** List inbound voice calls received by an account, newest first
   *  (plan §4.5 — persisted two-way voice history). Optionally narrowed
   *  to a single project. */
  async listInboundCalls(
    accountId: string,
    opts: { projectId?: string; limit?: number } = {},
  ): Promise<InboundCallRecord[]> {
    return this.deps.store.listInboundCalls({
      accountId,
      projectId: opts.projectId,
      limit: opts.limit,
    });
  }

  /** Read the inbound call-routing rule on a project's number. */
  async getCallRouting(
    projectId: string,
  ): Promise<
    | { action: CallRoutingAction; target?: string }
    | { error: string }
  > {
    const number = await this.deps.store.getPhoneNumberByProject(projectId);
    if (!number) return { error: "project has no phone number" };
    return {
      action: number.callRoutingAction ?? "voicemail",
      target: number.callRoutingTarget,
    };
  }

  /** Set the inbound call-routing rule on a project's number. `forward`
   *  and `app_webhook` require a target (a destination number / SIP URI,
   *  or an app webhook URL); `voicemail` and `reject` clear it. */
  async setCallRouting(
    projectId: string,
    input: { action: CallRoutingAction; target?: string },
  ): Promise<
    | { action: CallRoutingAction; target?: string }
    | { error: string }
  > {
    const number = await this.deps.store.getPhoneNumberByProject(projectId);
    if (!number) return { error: "project has no phone number" };
    const needsTarget =
      input.action === "forward" || input.action === "app_webhook";
    const target = input.target?.trim();
    if (needsTarget && !target) {
      return {
        error: `the "${input.action}" routing action requires a target`,
      };
    }
    const updated = await this.deps.store.updatePhoneNumber(projectId, {
      callRoutingAction: input.action,
      callRoutingTarget: needsTarget ? target : undefined,
    });
    const project = await this.deps.store.getProject(projectId);
    await this.recordEvent(
      project?.accountId ?? "",
      "system",
      `Call routing set — ${input.action}`,
      `${number.e164}${needsTarget ? ` → ${target}` : ""}`,
      projectId,
    );
    return {
      action: updated.callRoutingAction ?? "voicemail",
      target: updated.callRoutingTarget,
    };
  }

  /** Handle an SMS delivery-status webhook from the carrier — the real
   *  source of the terminal `delivered` / `failed` / `undelivered` state
   *  (the stub rolls it inline in `sendSms`; a live carrier reports it
   *  here). Records the terminal event into the SMS ring. */
  async receiveSmsStatus(
    projectId: string,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<
    { ok: true; status: SmsStatusUpdate["status"] } | { error: string }
  > {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const number = await this.deps.store.getPhoneNumberByProject(projectId);
    if (!number) return { error: "project has no phone number" };

    let update: SmsStatusUpdate;
    try {
      update = telephonyProvider.parseSmsStatus(rawBody, headers);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "invalid SMS status",
      };
    }
    // `queued` is not a terminal kind — only the others land in the ring.
    if (
      update.status === "sent" ||
      update.status === "delivered" ||
      update.status === "failed" ||
      update.status === "undelivered"
    ) {
      this.recordSmsEvent({
        kind: update.status,
        projectId,
        accountId: project.accountId,
        phoneNumberId: number.id,
        fromE164: number.e164,
        messageId: update.providerMessageId,
        toMasked: "—",
      });
    }
    return { ok: true, status: update.status };
  }

  /** Handle a voice-call status webhook from the carrier — completed,
   *  busy, no-answer, voicemail, etc. Logged to the activity feed. */
  async receiveCallStatus(
    projectId: string,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<
    { ok: true; status: CallStatusUpdate["status"] } | { error: string }
  > {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };

    let update: CallStatusUpdate;
    try {
      update = telephonyProvider.parseCallStatus(rawBody, headers);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "invalid call status",
      };
    }
    const detail =
      update.status === "voicemail" && update.voicemailUrl
        ? `voicemail recorded — ${update.voicemailUrl}`
        : typeof update.durationSec === "number"
          ? `duration ${update.durationSec}s`
          : `call ${update.providerCallId}`;
    await this.recordEvent(
      project.accountId,
      "system",
      `Call ${update.status}`,
      detail,
      projectId,
    );
    return { ok: true, status: update.status };
  }

  /* ----- SMS OTP / 2FA (plan §4.5 / §15.2 — phone verification) -----
   *
   *  The code generation / hashing / verification logic lives in the
   *  pure `src/auth/otp.ts`; the control plane holds the live challenges
   *  and rides the existing (stubbed) SMS path to deliver them. */

  /** Drop OTP challenges older than the rate-limit window — keeps the
   *  in-memory map bounded. Kept a full hour (not just the 5-min TTL) so
   *  the issuance rate limiter and the stats rollup still see them. */
  private pruneOtpChallenges(): void {
    const cutoff = Date.now() - OTP_POLICY.rateWindowMs;
    for (const [chId, ch] of this.otpChallenges) {
      if (new Date(ch.createdAt).getTime() < cutoff) {
        this.otpChallenges.delete(chId);
        void this.deps.store.deleteOtpChallenge(chId).catch(() => {});
      }
    }
    // Backstop hard cap — evict oldest first.
    if (this.otpChallenges.size > OTP_CHALLENGE_BUFFER) {
      const oldest = [...this.otpChallenges.entries()].sort((a, b) =>
        a[1].createdAt.localeCompare(b[1].createdAt),
      );
      const drop = this.otpChallenges.size - OTP_CHALLENGE_BUFFER;
      for (const [chId] of oldest.slice(0, drop)) {
        this.otpChallenges.delete(chId);
        void this.deps.store.deleteOtpChallenge(chId).catch(() => {});
      }
    }
  }

  /** Rehydrate the in-memory SMS event ring and OTP challenge map from
   *  the durable store on startup, so SMS deliverability history and
   *  in-flight verifications survive a control-plane restart (plan §4.5 /
   *  §15). Best-effort — a store failure (or the non-durable
   *  `InMemoryStore`) just leaves the rings empty, exactly as a cold
   *  start has always behaved. */
  private async rehydrateTelemetry(): Promise<void> {
    try {
      const events = await this.deps.store.listRecentSmsEvents(
        SMS_EVENT_BUFFER,
      );
      if (events.length > 0) {
        this.smsEvents = events as SmsEventRecord[];
      }
    } catch {
      /* leave the ring empty — cold-start behaviour */
    }
    try {
      const events = await this.deps.store.listRecentMailEvents(
        MAIL_EVENT_BUFFER,
      );
      if (events.length > 0) {
        this.mailEvents = events as MailEventRecord[];
      }
    } catch {
      /* leave the ring empty — cold-start behaviour */
    }
    try {
      const challenges = await this.deps.store.listOtpChallenges();
      for (const ch of challenges) {
        this.otpChallenges.set(ch.id, ch as OtpChallenge);
      }
      // Drop anything already past the rate window / over the cap.
      this.pruneOtpChallenges();
    } catch {
      /* leave the map empty */
    }
  }

  /** Issue an OTP code to `phone` and deliver it over the project's SMS
   *  number. Rate-limited per (project, phone). Returns the safe
   *  challenge view plus the raw code — the HTTP layer only echoes the
   *  code outside production (there is no real SMSC in the stub). */
  async requestSmsOtp(
    projectId: string,
    input: { phone: string; purpose?: OtpPurpose },
  ): Promise<
    { challenge: OtpChallengeView; code: string } | { error: string }
  > {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const number = await this.deps.store.getPhoneNumberByProject(projectId);
    if (!number) return { error: "project has no phone number" };
    const phone = input.phone.trim();
    if (!/^\+?[0-9][0-9\s().-]{4,}$/.test(phone)) {
      return { error: "a valid phone number is required" };
    }

    this.pruneOtpChallenges();
    const nowMs = Date.now();
    // pruneOtpChallenges already dropped everything older than the rate
    // window, so `mine` is exactly this number's in-window challenges.
    const mine = [...this.otpChallenges.values()].filter(
      (c) => c.projectId === projectId && c.phone === phone,
    );
    const lastIssued = mine.reduce(
      (max, c) => Math.max(max, new Date(c.createdAt).getTime()),
      0,
    );
    if (lastIssued && nowMs - lastIssued < OTP_POLICY.resendCooldownMs) {
      const wait = Math.ceil(
        (OTP_POLICY.resendCooldownMs - (nowMs - lastIssued)) / 1000,
      );
      return { error: `a code was just sent — retry in ${wait}s` };
    }
    if (mine.length >= OTP_POLICY.maxPerWindow) {
      return {
        error: "too many codes requested for this number — try again later",
      };
    }

    const purpose: OtpPurpose = input.purpose ?? "two_factor";
    const challengeId = id("otp");
    const code = generateOtpCode();
    const challenge: OtpChallenge = {
      id: challengeId,
      projectId,
      accountId: project.accountId,
      phone,
      phoneMasked: maskPhone(phone),
      purpose,
      codeHash: hashOtpCode(challengeId, code),
      createdAt: now(),
      expiresAt: new Date(nowMs + OTP_POLICY.ttlMs).toISOString(),
      attempts: 0,
      status: "pending",
    };
    this.otpChallenges.set(challengeId, challenge);
    void this.deps.store.upsertOtpChallenge(challenge).catch(() => {});

    // Deliver over the existing SMS path — the code rides real SMS
    // telemetry, so SmsAgent sees OTP traffic like any other send.
    const sent = await this.sendSms(projectId, {
      to: phone,
      body: renderOtpMessage(purpose, code),
    });
    if ("error" in sent) {
      this.otpChallenges.delete(challengeId);
      void this.deps.store.deleteOtpChallenge(challengeId).catch(() => {});
      return { error: sent.error };
    }
    await this.recordEvent(
      project.accountId,
      "system",
      `OTP code issued (${purpose})`,
      `${challenge.phoneMasked} · challenge ${challengeId}`,
      projectId,
    );
    return { challenge: toOtpChallengeView(challenge, new Date()), code };
  }

  /** Verify an OTP code. The challenge is found by `challengeId`, or by
   *  the most recent pending challenge for `phone`. Attempt-capped — a
   *  burned challenge stays burned. */
  async verifySmsOtp(
    projectId: string,
    input: { challengeId?: string; phone?: string; code: string },
  ): Promise<
    | {
        verified: boolean;
        outcome: OtpVerifyOutcome;
        attemptsRemaining: number;
        challenge: OtpChallengeView;
      }
    | { error: string }
  > {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };

    this.pruneOtpChallenges();
    let challenge: OtpChallenge | undefined;
    if (input.challengeId) {
      const found = this.otpChallenges.get(input.challengeId);
      if (found && found.projectId === projectId) challenge = found;
    } else if (input.phone) {
      const phone = input.phone.trim();
      challenge = [...this.otpChallenges.values()]
        .filter(
          (c) =>
            c.projectId === projectId &&
            c.phone === phone &&
            c.status === "pending",
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    }
    if (!challenge) {
      return { error: "no matching OTP challenge — request a new code" };
    }

    const verdict = evaluateOtpVerification(
      challenge,
      input.code.trim(),
      new Date(),
    );
    challenge.attempts = verdict.attemptsUsed;
    challenge.status = verdict.nextStatus;
    this.otpChallenges.set(challenge.id, challenge);
    void this.deps.store.upsertOtpChallenge(challenge).catch(() => {});

    await this.recordEvent(
      project.accountId,
      "system",
      verdict.outcome === "verified"
        ? "OTP code verified"
        : `OTP verify failed (${verdict.outcome})`,
      `${challenge.phoneMasked} · challenge ${challenge.id}`,
      projectId,
    );
    return {
      verified: verdict.outcome === "verified",
      outcome: verdict.outcome,
      attemptsRemaining: verdict.attemptsRemaining,
      challenge: toOtpChallengeView(challenge, new Date()),
    };
  }

  /** Account-wide OTP rollup — what the Console SMS page and the
   *  `cantila otp` command render. */
  getOtpStats(accountId: string): {
    active: number;
    issued: number;
    verified: number;
    failed: number;
    expired: number;
    verifyRatePct: number;
    recent: OtpChallengeView[];
  } {
    this.pruneOtpChallenges();
    const nowDate = new Date();
    const mine = [...this.otpChallenges.values()].filter(
      (c) => c.accountId === accountId,
    );
    let active = 0;
    let verified = 0;
    let failed = 0;
    let expired = 0;
    for (const c of mine) {
      const s = effectiveOtpStatus(c, nowDate);
      if (s === "pending") active += 1;
      else if (s === "verified") verified += 1;
      else if (s === "failed") failed += 1;
      else expired += 1;
    }
    const decided = verified + failed;
    return {
      active,
      issued: mine.length,
      verified,
      failed,
      expired,
      verifyRatePct: decided > 0 ? Math.round((verified / decided) * 100) : 0,
      recent: mine
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20)
        .map((c) => toOtpChallengeView(c, nowDate)),
    };
  }

  /* ----- number marketplace (plan §4.5 — buy & lease phone numbers) -----
   *
   *  Search runs against the `TelephonyProvider` carrier inventory; the
   *  control plane re-prices every result through the retail pricebook.
   *  A purchase provisions the number with the carrier, persists an
   *  account-owned `MarketplaceNumber`, and bills through `getBillingSummary`
   *  (a recurring monthly line + a one-time setup line). */

  /** Search the carrier number inventory, re-priced to retail. */
  async searchNumberCatalog(input: {
    country: string;
    type?: NumberType;
    capability?: NumberCapability;
    areaCode?: string;
  }): Promise<AvailableNumber[]> {
    const available = await telephonyProvider.searchAvailableNumbers(input);
    return available.map((n) => {
      const price = NUMBER_PRICEBOOK[n.type];
      return {
        ...n,
        setupPriceCents: price.setupCents,
        monthlyPriceCents: price.monthlyCents,
      };
    });
  }

  /* ----- per-project SMS activation (opt-in) -----
   *
   *  SMS is no longer auto-wired at deploy. A tenant activates it on a
   *  project, which provisions a real number through the carrier (the
   *  marketplace `purchaseNumber` path — Telnyx in prod, the stub offline)
   *  and bridges it to the project's `PhoneNumber` row so the existing
   *  send / inbound / voice / OTP call sites work unchanged. */

  /** Activate SMS on a project. Idempotent — returns the existing number
   *  if SMS is already on. Provisions a real carrier number (billed
   *  monthly), records it as a project `PhoneNumber`, and injects
   *  `CANTILA_SMS_NUMBER` / `CANTILA_SMS_API_KEY` so the app picks them up
   *  on its next deploy. When `e164` is omitted, the first available
   *  number in `country` (of `numberType`) is chosen. */
  async activateSms(
    accountId: string,
    projectId: string,
    input: {
      country: string;
      numberType?: NumberType;
      capabilities?: NumberCapability[];
      e164?: string;
    },
  ): Promise<PhoneNumber | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project || project.accountId !== accountId) {
      return { error: "project not found" };
    }

    // Idempotent — SMS already active.
    const existing = await this.deps.store.getPhoneNumberByProject(projectId);
    if (existing) return maskNumber(existing) as PhoneNumber;

    const numberType: NumberType = input.numberType ?? "local";
    const capabilities: NumberCapability[] =
      input.capabilities && input.capabilities.length > 0
        ? input.capabilities
        : ["sms", "mms", "voice"];

    // Resolve a concrete number to provision.
    let e164 = input.e164?.trim();
    if (!e164) {
      const available = await this.searchNumberCatalog({
        country: input.country,
        type: numberType,
        capability: "sms",
      });
      if (available.length === 0) {
        return { error: "no numbers available for that country" };
      }
      e164 = available[0].e164;
    }

    // Provision + bill the real number via the marketplace path.
    const purchased = await this.purchaseNumber({
      accountId,
      e164,
      country: input.country,
      numberType,
      capabilities,
      projectId,
    });
    if ("error" in purchased) return purchased;

    // Bridge to the project send path: the project's own `PhoneNumber`.
    const phone = await this.deps.store.createPhoneNumber({
      id: id("num"),
      projectId,
      e164: purchased.e164,
      region: project.region,
      status: "active",
      apiKey: `ct_sms_${secret().slice(0, 24)}`,
      marketplaceNumberId: purchased.id,
      capabilities,
      createdAt: now(),
    });

    // Inject the project env so the app is wired on its next deploy.
    await this.injectSmsEnv(projectId, phone.e164, phone.apiKey);

    await this.recordEvent(
      accountId,
      "system",
      `SMS activated — ${phone.e164}`,
      `${numberType} · ${capabilities.join("/")}`,
      projectId,
    );
    return maskNumber(phone) as PhoneNumber;
  }

  /** Deactivate SMS on a project — releases the carrier number (stops the
   *  monthly charge), removes the project `PhoneNumber`, and strips the
   *  injected env. Idempotent — a no-op when SMS is already off. */
  async deactivateSms(
    accountId: string,
    projectId: string,
  ): Promise<{ ok: true } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project || project.accountId !== accountId) {
      return { error: "project not found" };
    }
    const phone = await this.deps.store.getPhoneNumberByProject(projectId);
    if (!phone) return { ok: true };

    // Release the carrier lease + stop billing. Best-effort: a release
    // failure must not strand the project with an un-removable number.
    if (phone.marketplaceNumberId) {
      const released = await this.releaseOwnedNumber(
        accountId,
        phone.marketplaceNumberId,
      );
      if ("error" in released && released.error !== "number is already released") {
        return { error: released.error };
      }
    }

    await this.deps.store.deletePhoneNumber(projectId);
    await this.deps.store.deleteEnvVar(projectId, "CANTILA_SMS_NUMBER");
    await this.deps.store.deleteEnvVar(projectId, "CANTILA_SMS_API_KEY");

    await this.recordEvent(
      accountId,
      "system",
      "SMS deactivated",
      `${phone.e164} released`,
      projectId,
    );
    return { ok: true };
  }

  /** Inject the SMS env pair as project secrets (scope `all`). Mirrors the
   *  keys the deploy auto-wiring used to inject before SMS became opt-in. */
  private async injectSmsEnv(
    projectId: string,
    e164: string,
    apiKey: string,
  ): Promise<void> {
    await this.deps.store.upsertEnvVar({
      id: id("env"),
      projectId,
      key: "CANTILA_SMS_NUMBER",
      value: e164,
      secret: true,
      scope: "all",
      updatedAt: now(),
    });
    await this.deps.store.upsertEnvVar({
      id: id("env"),
      projectId,
      key: "CANTILA_SMS_API_KEY",
      value: apiKey,
      secret: true,
      scope: "all",
      updatedAt: now(),
    });
  }

  /** Purchase a number from the marketplace — provision it with the
   *  carrier, persist an account-owned `MarketplaceNumber`, and record a
   *  billable purchase event. Pricing is server-authoritative (from the
   *  pricebook, by type) — the client cannot set its own price. */
  async purchaseNumber(input: {
    accountId: string;
    e164: string;
    country: string;
    numberType: NumberType;
    capabilities: NumberCapability[];
    projectId?: string;
  }): Promise<MarketplaceNumber | { error: string }> {
    const account = await this.deps.store.getAccount(input.accountId);
    if (!account) return { error: "account not found" };
    const e164 = input.e164.trim();
    if (!/^\+[1-9][0-9]{6,14}$/.test(e164)) {
      return { error: "a valid E.164 phone number is required" };
    }
    const existing =
      await this.deps.store.findMarketplaceNumberByE164(e164);
    if (existing && existing.status !== "released") {
      return { error: "that number is already owned" };
    }
    if (input.projectId) {
      const project = await this.deps.store.getProject(input.projectId);
      if (!project || project.accountId !== input.accountId) {
        return { error: "project not found on this account" };
      }
    }
    const price = NUMBER_PRICEBOOK[input.numberType];
    try {
      const provisioned = await telephonyProvider.provisionNumber({
        e164,
        country: input.country,
        type: input.numberType,
        capabilities: input.capabilities,
      });
      let number = await this.deps.store.createMarketplaceNumber({
        id: id("pn"),
        accountId: input.accountId,
        e164,
        country: input.country,
        numberType: input.numberType,
        capabilities: input.capabilities,
        setupPriceCents: price.setupCents,
        monthlyPriceCents: price.monthlyCents,
        status: "active",
        providerId: provisioned.providerId,
        projectId: input.projectId,
        purchasedAt: now(),
      });
      // The number is active immediately — start Stripe billing now: a
      // recurring SubscriptionItem for the monthly lease + a one-time
      // InvoiceItem for the setup fee. Best-effort (plan §8).
      const itemId = await this.startNumberStripeBilling(account, number, true);
      if (itemId) {
        number = await this.deps.store.updateMarketplaceNumber(number.id, {
          stripeSubscriptionItemId: itemId,
        });
      }
      await this.recordEvent(
        input.accountId,
        "system",
        `Number purchased — ${e164}`,
        `${input.numberType} · setup $${(price.setupCents / 100).toFixed(2)} · $${(price.monthlyCents / 100).toFixed(2)}/mo`,
        input.projectId,
      );
      return number;
    } catch (err) {
      return {
        error:
          err instanceof Error ? err.message : "number purchase failed",
      };
    }
  }

  /** List the marketplace numbers an account owns (newest first). */
  async listOwnedNumbers(accountId: string): Promise<MarketplaceNumber[]> {
    return this.deps.store.listMarketplaceNumbers(accountId);
  }

  /** Release a marketplace number — hands it back to the carrier and
   *  stops the monthly charge. Account-scoped: a caller can't release
   *  another account's number. The row is kept (status `released`) for
   *  billing history rather than hard-deleted. */
  async releaseOwnedNumber(
    accountId: string,
    numberId: string,
  ): Promise<MarketplaceNumber | { error: string }> {
    const number = await this.deps.store.getMarketplaceNumber(numberId);
    if (!number || number.accountId !== accountId) {
      return { error: "number not found" };
    }
    if (number.status === "released") {
      return { error: "number is already released" };
    }
    try {
      await telephonyProvider.releaseNumber({
        providerId: number.providerId,
      });
    } catch (err) {
      return {
        error:
          err instanceof Error ? err.message : "number release failed",
      };
    }
    // Stop Stripe billing before the row flips — `number` still carries the
    // live `stripeSubscriptionItemId`. Stripe credits the unused slice of
    // the lease back to the customer (plan §8).
    await this.stopNumberStripeBilling(accountId, number);
    const updated = await this.deps.store.updateMarketplaceNumber(numberId, {
      status: "released",
      releasedAt: now(),
      stripeSubscriptionItemId: undefined,
    });
    await this.recordEvent(
      accountId,
      "system",
      `Number released — ${number.e164}`,
      "monthly charge stopped",
    );
    return updated;
  }

  /** Port in a number the account already owns at another carrier.
   *  Creates the `MarketplaceNumber` in `porting` status — it becomes
   *  usable, and starts billing, only once `completePortIn` confirms
   *  the carrier finished the port. */
  async portInNumber(input: {
    accountId: string;
    e164: string;
    country: string;
    numberType: NumberType;
    capabilities: NumberCapability[];
    projectId?: string;
  }): Promise<MarketplaceNumber | { error: string }> {
    const account = await this.deps.store.getAccount(input.accountId);
    if (!account) return { error: "account not found" };
    const e164 = input.e164.trim();
    if (!/^\+[1-9][0-9]{6,14}$/.test(e164)) {
      return { error: "a valid E.164 phone number is required" };
    }
    const existing =
      await this.deps.store.findMarketplaceNumberByE164(e164);
    if (existing && existing.status !== "released") {
      return { error: "that number is already owned" };
    }
    if (input.projectId) {
      const project = await this.deps.store.getProject(input.projectId);
      if (!project || project.accountId !== input.accountId) {
        return { error: "project not found on this account" };
      }
    }
    const price = NUMBER_PRICEBOOK[input.numberType];
    try {
      const ported = await telephonyProvider.portInNumber({
        e164,
        country: input.country,
        type: input.numberType,
        capabilities: input.capabilities,
      });
      const number = await this.deps.store.createMarketplaceNumber({
        id: id("pn"),
        accountId: input.accountId,
        e164,
        country: input.country,
        numberType: input.numberType,
        capabilities: input.capabilities,
        setupPriceCents: price.setupCents,
        monthlyPriceCents: price.monthlyCents,
        status: "porting",
        providerId: ported.providerId,
        projectId: input.projectId,
        purchasedAt: now(),
      });
      await this.recordEvent(
        input.accountId,
        "system",
        `Number port-in started — ${e164}`,
        `${input.numberType} · awaiting carrier confirmation`,
        input.projectId,
      );
      return number;
    } catch (err) {
      return {
        error:
          err instanceof Error ? err.message : "number port-in failed",
      };
    }
  }

  /** Confirm a port-in — flip a `porting` number to `active`. In
   *  production the carrier reports the completed port; offline it is
   *  driven directly. Account-scoped. */
  async completePortIn(
    accountId: string,
    numberId: string,
  ): Promise<MarketplaceNumber | { error: string }> {
    const number = await this.deps.store.getMarketplaceNumber(numberId);
    if (!number || number.accountId !== accountId) {
      return { error: "number not found" };
    }
    if (number.status !== "porting") {
      return { error: `number is ${number.status}, not porting` };
    }
    let updated = await this.deps.store.updateMarketplaceNumber(numberId, {
      status: "active",
    });
    // The number only starts billing once it is active — wire it onto the
    // account's Stripe subscription now (monthly lease + setup fee).
    const account = await this.deps.store.getAccount(accountId);
    if (account) {
      const itemId = await this.startNumberStripeBilling(
        account,
        updated,
        true,
      );
      if (itemId) {
        updated = await this.deps.store.updateMarketplaceNumber(numberId, {
          stripeSubscriptionItemId: itemId,
        });
      }
    }
    await this.recordEvent(
      accountId,
      "system",
      `Number port-in complete — ${number.e164}`,
      "the number is now active and billing",
    );
    return updated;
  }

  /** Transfer an active number to another Cantila account — an internal
   *  ownership change, no carrier interaction. The number is unassigned
   *  from its (source-account) project and re-homed; activity is
   *  recorded on both accounts. */
  async transferNumber(input: {
    fromAccountId: string;
    numberId: string;
    toAccountHandle: string;
  }): Promise<MarketplaceNumber | { error: string }> {
    const number = await this.deps.store.getMarketplaceNumber(
      input.numberId,
    );
    if (!number || number.accountId !== input.fromAccountId) {
      return { error: "number not found" };
    }
    if (number.status !== "active") {
      return { error: "only an active number can be transferred" };
    }
    const target = await this.deps.store.findAccountByHandle(
      input.toAccountHandle.trim().toLowerCase(),
    );
    if (!target) return { error: "destination account not found" };
    if (target.id === input.fromAccountId) {
      return { error: "the number is already on that account" };
    }
    // Move the Stripe billing with the number: drop the SubscriptionItem
    // from the source account's subscription, then add a fresh one to the
    // destination's. No setup fee — a transfer is an ownership change, not
    // a new purchase (plan §8). `startNumberStripeBilling` returns
    // `undefined` when the destination has no subscription, which clears
    // the id so billing reconciles when that account next subscribes.
    await this.stopNumberStripeBilling(input.fromAccountId, number);
    const newItemId = await this.startNumberStripeBilling(
      target,
      number,
      false,
    );
    const updated = await this.deps.store.updateMarketplaceNumber(
      input.numberId,
      {
        accountId: target.id,
        projectId: undefined,
        stripeSubscriptionItemId: newItemId,
      },
    );
    await this.recordEvent(
      input.fromAccountId,
      "system",
      `Number transferred out — ${number.e164}`,
      `to account ${target.handle}`,
    );
    await this.recordEvent(
      target.id,
      "system",
      `Number transferred in — ${number.e164}`,
      `from account ${input.fromAccountId}`,
    );
    return updated;
  }

  /* ----- number marketplace billing (plan §8 — Stripe is the system of
   *  record; a leased number bills as a recurring Stripe SubscriptionItem,
   *  its setup fee as a one-time Stripe InvoiceItem) ----- */

  /** Resolve the account that holds the Stripe subscription for any
   *  given account. Walks the `billedToAccountId` pointer exactly once
   *  (two-level only, enforced at `enrollInBillingRollup`) — returns
   *  the input account if it pays its own bill, or the agency parent
   *  if the input is rolled up onto it. Returns `null` if the pointer
   *  is dangling (target account was deleted) — callers should treat
   *  this as "defer billing" rather than crashing the request.
   *  Plan §5.5 — white-label billing-rollup. */
  async resolveBillingAccount(
    targetAccountId: string,
  ): Promise<Account | null> {
    const target = await this.deps.store.getAccount(targetAccountId);
    if (!target) return null;
    if (!target.billedToAccountId) return target;
    const payer = await this.deps.store.getAccount(target.billedToAccountId);
    return payer ?? null;
  }

  /** Best-effort: start Stripe billing for a now-`active` marketplace
   *  number. Adds a recurring `SubscriptionItem` for the monthly lease to
   *  the account's Stripe subscription, and — when `chargeSetup` — a
   *  one-time `InvoiceItem` for the setup fee. Returns the subscription-item
   *  id to persist on the `MarketplaceNumber`, or `undefined` when billing
   *  could not be wired (no Stripe subscription yet, or the Stripe call
   *  failed). The number is still owned and usable either way — billing is
   *  reconciled on the next lifecycle event once a subscription exists.
   *
   *  Plan §5.5 — white-label billing-rollup: if `account.billedToAccountId`
   *  is set, the billing items land on the PARENT's Stripe subscription
   *  instead, with `metadata.cantilaSubAccountId = <originating sub>` so the
   *  parent's invoice line items can be attributed back to the right child. */
  private async startNumberStripeBilling(
    account: Account,
    number: MarketplaceNumber,
    chargeSetup: boolean,
  ): Promise<string | undefined> {
    // White-label billing-rollup: re-target the billing account when
    // the originating sub is rolled up onto its agency parent.
    let payer = account;
    let subAccountId: string | undefined;
    if (account.billedToAccountId) {
      const resolved = await this.deps.store.getAccount(
        account.billedToAccountId,
      );
      if (resolved) {
        payer = resolved;
        subAccountId = account.id;
      }
    }
    if (!payer.stripeSubscriptionId) {
      await this.recordEvent(
        account.id,
        "system",
        `Number billing deferred — ${number.e164}`,
        subAccountId
          ? `parent ${payer.id} has no active Stripe subscription — start one via checkout to bill rolled-up children`
          : "no active Stripe subscription — start one via checkout to bill this number",
      );
      return undefined;
    }
    try {
      const item = await this.deps.stripe.addSubscriptionItem({
        subscriptionId: payer.stripeSubscriptionId,
        amountCents: number.monthlyPriceCents,
        description: subAccountId
          ? `Cantila phone number ${number.e164} — monthly lease (sub-account ${account.handle})`
          : `Cantila phone number ${number.e164} — monthly lease`,
        metadata: {
          cantilaNumberId: number.id,
          e164: number.e164,
          ...(subAccountId ? { cantilaSubAccountId: subAccountId } : {}),
        },
      });
      if (
        chargeSetup &&
        number.setupPriceCents > 0 &&
        payer.stripeCustomerId
      ) {
        await this.deps.stripe.addInvoiceItem({
          customerId: payer.stripeCustomerId,
          amountCents: number.setupPriceCents,
          description: subAccountId
            ? `Cantila phone number ${number.e164} — setup fee (sub-account ${account.handle})`
            : `Cantila phone number ${number.e164} — setup fee`,
          metadata: {
            cantilaNumberId: number.id,
            e164: number.e164,
            ...(subAccountId ? { cantilaSubAccountId: subAccountId } : {}),
          },
        });
      }
      await this.recordEvent(
        account.id,
        "system",
        `Number billing started — ${number.e164}`,
        subAccountId
          ? `Stripe item ${item.id} on parent ${payer.id} · $${(number.monthlyPriceCents / 100).toFixed(2)}/mo · ${this.deps.stripe.label}`
          : `Stripe item ${item.id} · $${(number.monthlyPriceCents / 100).toFixed(2)}/mo · ${this.deps.stripe.label}`,
      );
      return item.id;
    } catch (err) {
      await this.recordEvent(
        account.id,
        "system",
        `Number billing failed — ${number.e164}`,
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  /** Best-effort: stop Stripe billing for a number — removes its recurring
   *  `SubscriptionItem` (the real adapter credits the unused slice back).
   *  A no-op when the number was never wired to Stripe. */
  private async stopNumberStripeBilling(
    accountId: string,
    number: MarketplaceNumber,
  ): Promise<void> {
    if (!number.stripeSubscriptionItemId) return;
    try {
      await this.deps.stripe.removeSubscriptionItem({
        subscriptionItemId: number.stripeSubscriptionItemId,
      });
      await this.recordEvent(
        accountId,
        "system",
        `Number billing stopped — ${number.e164}`,
        `Stripe item ${number.stripeSubscriptionItemId} removed · ${this.deps.stripe.label}`,
      );
    } catch (err) {
      await this.recordEvent(
        accountId,
        "system",
        `Number billing teardown failed — ${number.e164}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /* ============================================================
     A2P/10DLC carrier registration (plan §4.5).

     Records the brand + campaign metadata the operator submits to
     The Campaign Registry (via a carrier or aggregator) before US
     A2P SMS is allowed at scale. The actual submission is
     infra-blocked on a carrier account; today this stores the data
     locally and exposes a status state machine the operator can
     drive manually (or that a real telephony adapter will drive
     when one is wired).
     ============================================================ */

  /** Required keys per kind. The CP enforces these at create time so
   *  the operator can't accidentally submit an empty brand. */
  private readonly BRAND_REQUIRED_KEYS = [
    "legalName",
    "ein",
    "vertical",
    "country",
  ];
  private readonly CAMPAIGN_REQUIRED_KEYS = [
    "useCase",
    "description",
    "sampleMessages",
  ];

  /** Register a brand — the business identity. Required keys:
   *  `legalName`, `ein`, `vertical`, `country`. */
  async registerBrand(input: {
    accountId: string;
    name: string;
    payload: Record<string, unknown>;
  }): Promise<A2pRegistration | { error: string }> {
    const missing = this.BRAND_REQUIRED_KEYS.filter(
      (k) => input.payload[k] === undefined || input.payload[k] === "",
    );
    if (missing.length > 0) {
      return { error: `brand payload missing required keys: ${missing.join(", ")}` };
    }
    const account = await this.deps.store.getAccount(input.accountId);
    if (!account) return { error: "account not found" };
    const registration = await this.deps.store.createA2pRegistration({
      id: id("a2p"),
      accountId: input.accountId,
      kind: "brand",
      name: input.name.trim() || "Unnamed brand",
      status: "draft",
      payload: input.payload,
      createdAt: now(),
    });
    await this.recordEvent(
      input.accountId,
      "system",
      `A2P brand draft — ${registration.name}`,
      `vertical: ${input.payload.vertical ?? "(unspecified)"}`,
    );
    return registration;
  }

  /** Register a campaign under an existing brand. Required keys:
   *  `useCase`, `description`, `sampleMessages`. */
  async registerCampaign(input: {
    accountId: string;
    name: string;
    brandRegistrationId: string;
    payload: Record<string, unknown>;
  }): Promise<A2pRegistration | { error: string }> {
    const missing = this.CAMPAIGN_REQUIRED_KEYS.filter(
      (k) => input.payload[k] === undefined || input.payload[k] === "",
    );
    if (missing.length > 0) {
      return { error: `campaign payload missing required keys: ${missing.join(", ")}` };
    }
    const brand = await this.deps.store.getA2pRegistration(
      input.brandRegistrationId,
    );
    if (!brand || brand.kind !== "brand") {
      return { error: "brand registration not found" };
    }
    if (brand.accountId !== input.accountId) {
      return { error: "brand belongs to a different account" };
    }
    if (brand.status !== "approved") {
      // Campaigns can be drafted alongside a pending brand, but the
      // operator should know — this is a soft warning, not a block. The
      // carrier will reject the submission until the brand is approved.
      // We surface this through the activity feed.
      await this.recordEvent(
        input.accountId,
        "system",
        `A2P campaign drafted under unapproved brand`,
        `brand status: ${brand.status} — campaign will not submit until the brand is approved`,
      );
    }
    const registration = await this.deps.store.createA2pRegistration({
      id: id("a2p"),
      accountId: input.accountId,
      kind: "campaign",
      name: input.name.trim() || "Unnamed campaign",
      status: "draft",
      brandRegistrationId: input.brandRegistrationId,
      payload: input.payload,
      createdAt: now(),
    });
    await this.recordEvent(
      input.accountId,
      "system",
      `A2P campaign draft — ${registration.name}`,
      `use case: ${input.payload.useCase ?? "(unspecified)"}`,
    );
    return registration;
  }

  async listA2pRegistrations(
    accountId: string,
    opts: { kind?: A2pRegistrationKind } = {},
  ): Promise<A2pRegistration[]> {
    const all = await this.deps.store.listA2pRegistrations(accountId);
    return opts.kind ? all.filter((r) => r.kind === opts.kind) : all;
  }

  async getA2pRegistration(
    registrationId: string,
  ): Promise<A2pRegistration | null> {
    return this.deps.store.getA2pRegistration(registrationId);
  }

  /** Walk a registration through the approval state machine. Today the
   *  operator drives this manually (or via the test seam); the real
   *  telephony adapter will drive `submitted` / `in_review` / `approved`
   *  / `rejected` from carrier webhooks.
   *
   *  Allowed transitions:
   *    draft → submitted, draft → in_review (a few carriers skip submitted)
   *    submitted → in_review, approved, rejected, hold
   *    in_review → approved, rejected, hold
   *    hold → in_review, approved, rejected
   *    approved → hold (re-review)
   *    rejected → draft (operator edits + re-submits) */
  async setA2pRegistrationStatus(
    callerAccountId: string,
    registrationId: string,
    targetStatus: A2pRegistrationStatus,
    extra: {
      providerRegistrationId?: string;
      rejectionReason?: string;
    } = {},
  ): Promise<A2pRegistration | { error: string }> {
    const registration = await this.deps.store.getA2pRegistration(
      registrationId,
    );
    if (!registration) return { error: "registration not found" };
    if (registration.accountId !== callerAccountId) {
      return { error: "registration belongs to a different account" };
    }
    if (!this.isAllowedA2pTransition(registration.status, targetStatus)) {
      return {
        error: `invalid A2P transition: ${registration.status} → ${targetStatus}`,
      };
    }
    const patch: Partial<A2pRegistration> = { status: targetStatus };
    if (targetStatus === "submitted" && !registration.submittedAt) {
      patch.submittedAt = now();
    }
    if (
      (targetStatus === "approved" ||
        targetStatus === "rejected") &&
      !registration.resolvedAt
    ) {
      patch.resolvedAt = now();
    }
    if (extra.providerRegistrationId !== undefined) {
      patch.providerRegistrationId = extra.providerRegistrationId;
    }
    if (targetStatus === "rejected" || targetStatus === "hold") {
      patch.rejectionReason = extra.rejectionReason;
    } else if (targetStatus === "approved" && registration.rejectionReason) {
      // Clear stale rejection text on re-approval.
      patch.rejectionReason = undefined;
    }
    const updated = await this.deps.store.updateA2pRegistration(
      registrationId,
      patch,
    );
    await this.recordEvent(
      callerAccountId,
      "system",
      `A2P ${updated.kind} ${updated.name} → ${targetStatus}`,
      extra.rejectionReason ??
        (extra.providerRegistrationId
          ? `tcr id: ${extra.providerRegistrationId}`
          : `transitioned from ${registration.status}`),
    );
    return updated;
  }

  private isAllowedA2pTransition(
    from: A2pRegistrationStatus,
    to: A2pRegistrationStatus,
  ): boolean {
    if (from === to) return false;
    const allowed: Record<A2pRegistrationStatus, A2pRegistrationStatus[]> = {
      draft: ["submitted", "in_review"],
      submitted: ["in_review", "approved", "rejected", "hold"],
      in_review: ["approved", "rejected", "hold"],
      hold: ["in_review", "approved", "rejected"],
      approved: ["hold"],
      rejected: ["draft"],
    };
    return allowed[from]?.includes(to) ?? false;
  }

  /* ============================================================
     Mail sending-IP pools (plan §4.4 — IP-pool rotation).

     Records the pool metadata the future MTA reads to decide which
     sending IP each outbound message rides through. CRUD with a
     single-default invariant (the CP demotes any prior default when
     a new one is set, so the pool table can be queried for the
     default at send time with no extra coordination). Send-time
     rotation policy and per-domain pool assignment are follow-ups —
     this drop establishes the schema and the operator surface.
     ============================================================ */

  /** Default reputation per pool kind. Plausible starting values —
   *  warmup IPs ramp from a moderate floor, transactional pools track
   *  high (high engagement), marketing pools sit lower (bulk + opt-out
   *  pressure). Production reads from Postmaster Tools / SNDS feeds. */
  private readonly POOL_DEFAULT_REPUTATION: Record<MailIpPoolKind, number> = {
    warmup: 50,
    main: 75,
    transactional: 90,
    marketing: 65,
  };

  async createMailIpPool(input: {
    accountId: string;
    name: string;
    kind?: MailIpPoolKind;
    ips?: string[];
    description?: string;
    setDefault?: boolean;
  }): Promise<MailIpPool | { error: string }> {
    const name = input.name.trim();
    if (!name) return { error: "name is required" };
    const account = await this.deps.store.getAccount(input.accountId);
    if (!account) return { error: "account not found" };
    const kind = input.kind ?? "main";
    // If this is the first pool on the account, mark it default
    // automatically; otherwise honour `setDefault` and demote the
    // previous default below.
    const existing = await this.deps.store.listMailIpPools(input.accountId);
    const makeDefault = existing.length === 0 || input.setDefault === true;
    if (makeDefault) {
      for (const prior of existing.filter((p) => p.isDefault)) {
        await this.deps.store.updateMailIpPool(prior.id, { isDefault: false });
      }
    }
    const at = now();
    const pool = await this.deps.store.createMailIpPool({
      id: id("pool"),
      accountId: input.accountId,
      name,
      kind,
      ips: (input.ips ?? []).map((s) => s.trim()).filter(Boolean),
      reputation: this.POOL_DEFAULT_REPUTATION[kind],
      active: true,
      isDefault: makeDefault,
      description: input.description?.trim() || undefined,
      createdAt: at,
      updatedAt: at,
    });
    await this.recordEvent(
      input.accountId,
      "system",
      `Mail IP pool ${pool.name} created`,
      `${pool.kind}${pool.isDefault ? " · default" : ""}`,
    );
    return pool;
  }

  async listMailIpPools(accountId: string): Promise<MailIpPool[]> {
    return this.deps.store.listMailIpPools(accountId);
  }

  async getMailIpPool(id: string): Promise<MailIpPool | null> {
    return this.deps.store.getMailIpPool(id);
  }

  /** Patch a pool. Setting `isDefault: true` demotes any other pool on
   *  the same account in the same write — the single-default invariant
   *  is enforced here (and at create time above). Setting it to false
   *  is allowed but operators are expected to set another default first;
   *  we don't enforce non-zero defaults so a deletion flow can clear
   *  the slate. */
  async updateMailIpPool(
    callerAccountId: string,
    poolId: string,
    patch: {
      name?: string;
      kind?: MailIpPoolKind;
      ips?: string[];
      reputation?: number;
      active?: boolean;
      isDefault?: boolean;
      description?: string;
    },
  ): Promise<MailIpPool | { error: string }> {
    const existing = await this.deps.store.getMailIpPool(poolId);
    if (!existing || existing.accountId !== callerAccountId) {
      return { error: "pool not found" };
    }
    if (patch.isDefault === true && !existing.isDefault) {
      const peers = await this.deps.store.listMailIpPools(callerAccountId);
      for (const peer of peers) {
        if (peer.id !== poolId && peer.isDefault) {
          await this.deps.store.updateMailIpPool(peer.id, {
            isDefault: false,
          });
        }
      }
    }
    const updated = await this.deps.store.updateMailIpPool(poolId, patch);
    await this.recordEvent(
      callerAccountId,
      "system",
      `Mail IP pool ${updated.name} updated`,
      `${updated.kind}${updated.isDefault ? " · default" : ""}${updated.active ? "" : " · paused"}`,
    );
    return updated;
  }

  async deleteMailIpPool(
    callerAccountId: string,
    poolId: string,
  ): Promise<boolean> {
    const existing = await this.deps.store.getMailIpPool(poolId);
    if (!existing || existing.accountId !== callerAccountId) return false;
    const ok = await this.deps.store.deleteMailIpPool(poolId);
    if (ok) {
      await this.recordEvent(
        callerAccountId,
        "system",
        `Mail IP pool ${existing.name} deleted`,
        `${existing.kind}${existing.isDefault ? " · was default" : ""}`,
      );
    }
    return ok;
  }

  /* ============================================================
     Compute nodes — Bring-Your-Own-VPS (plan §5.5)

     A tenant points their own VPS at Cantila. The control plane mints
     a one-time enrollment token; the tenant runs the node-agent on the
     box; the agent calls back with its SSH public-key fingerprint and
     the row flips `pending → active`. From then on the node is a
     regular fleet member — `getFleetCapacity` surfaces it alongside
     synthesised platform nodes; CapacityAgent reasons over its load;
     scheduling places workloads on it. Retire is one-way: the operator
     can stop receiving new schedules but Cantila does not delete the
     row, so the audit trail stays intact.

     Two surfaces:
       • Operator API (Bearer key / Console session, account-scoped):
         enrollNode, listAccountNodes, getNode, retireNode.
       • Node-agent API (raw enrollment token is the credential):
         completeNodeEnrollment, recordNodeHeartbeat. These routes are
         exempt from the request-auth hook the same way carrier inbound
         webhooks are.

     Token shape mirrors the rest of the codebase: a raw `ctn_<48 hex>`
     is returned exactly once at mint; only its SHA-256 hash is
     persisted. The visible prefix (the first 12 chars) is stored
     alongside so an operator can recognise their own pending token
     without revealing the secret. */

  private hashNodeToken(rawToken: string): string {
    return createHash("sha256").update(rawToken).digest("hex");
  }

  private maskNode(n: Node): Node {
    // The token hash is sensitive (a leaked hash + a future timing
    // attack lets you brute-force the token). Every standard read
    // returns it as a fixed placeholder; only the internal
    // `findNodeByEnrollmentTokenHash` path sees the real value.
    return { ...n, enrollmentTokenHash: "hash::redacted" };
  }

  /** Mint a `Node` row in `pending` status and return it together with
   *  the raw, one-time enrollment token. The token is never echoed
   *  again — the caller must hand it to the node-agent immediately. */
  async enrollNode(input: {
    accountId: string;
    label: string;
    region?: string;
    host?: string;
    sshUser?: string;
    capacityInstances?: number;
    kind?: NodeKind;
  }): Promise<{ node: Node; enrollmentToken: string } | { error: string }> {
    const label = input.label.trim();
    if (!label) return { error: "label is required" };
    const account = await this.deps.store.getAccount(input.accountId);
    if (!account) return { error: "account not found" };
    const capacity = Math.max(1, Math.min(256, input.capacityInstances ?? 16));
    const rawToken = `ctn_${secret().slice(0, 48)}`;
    const tokenHash = this.hashNodeToken(rawToken);
    const prefix = rawToken.slice(0, 12);
    const at = now();
    const row = await this.deps.store.createNode({
      id: id("node"),
      accountId: input.accountId,
      kind: input.kind ?? "byo",
      label,
      region: (input.region ?? "byo").trim() || "byo",
      host: (input.host ?? "").trim(),
      sshUser: (input.sshUser ?? "root").trim() || "root",
      enrollmentTokenHash: tokenHash,
      enrollmentTokenPrefix: prefix,
      capacityInstances: capacity,
      status: "pending",
      createdAt: at,
    });
    await this.recordEvent(
      input.accountId,
      "system",
      `Node ${row.label} enrolled`,
      `${row.kind} · ${row.region} · capacity ${row.capacityInstances} · awaiting agent callback`,
    );
    return { node: this.maskNode(row), enrollmentToken: rawToken };
  }

  /** The node-agent calls this with the raw enrollment token to confirm
   *  the row. Flips `pending → active` and stamps the public-key
   *  fingerprint + reported capacity. Idempotent — replaying the same
   *  token on an already-active node is a no-op refresh of the heartbeat. */
  async completeNodeEnrollment(input: {
    rawToken: string;
    publicKeyFingerprint: string;
    capacityInstances?: number;
  }): Promise<{ node: Node } | { error: string }> {
    const fingerprint = input.publicKeyFingerprint.trim();
    if (!fingerprint) return { error: "publicKeyFingerprint is required" };
    const tokenHash = this.hashNodeToken(input.rawToken);
    const found =
      await this.deps.store.findNodeByEnrollmentTokenHash(tokenHash);
    if (!found) return { error: "invalid enrollment token" };
    if (found.status === "retired") {
      return { error: "node has been retired" };
    }
    const patch: Partial<Node> = {
      status: "active",
      publicKeyFingerprint: fingerprint,
      enrolledAt: found.enrolledAt ?? now(),
      lastHeartbeatAt: now(),
    };
    if (input.capacityInstances !== undefined) {
      patch.capacityInstances = Math.max(
        1,
        Math.min(256, input.capacityInstances),
      );
    }
    const updated = await this.deps.store.updateNode(found.id, patch);
    if (found.status !== "active") {
      await this.recordEvent(
        found.accountId,
        "system",
        `Node ${updated.label} active`,
        `agent enrolled · capacity ${updated.capacityInstances} · fingerprint ${fingerprint.slice(0, 16)}…`,
      );
    }
    return { node: this.maskNode(updated) };
  }

  /** Node-agent heartbeat. Updates `lastHeartbeatAt` and (optionally)
   *  the reported instance count + load%. Raw token is the credential
   *  — exempt from the API-key auth hook at the HTTP layer. */
  async recordNodeHeartbeat(input: {
    rawToken: string;
    instances?: number;
    loadPct?: number;
  }): Promise<{ node: Node } | { error: string }> {
    const tokenHash = this.hashNodeToken(input.rawToken);
    const found =
      await this.deps.store.findNodeByEnrollmentTokenHash(tokenHash);
    if (!found) return { error: "invalid enrollment token" };
    if (found.status === "retired") {
      return { error: "node has been retired" };
    }
    const patch: Partial<Node> = { lastHeartbeatAt: now() };
    if (input.instances !== undefined) {
      patch.reportedInstances = Math.max(0, Math.floor(input.instances));
    }
    let reportedLoadPct: number | undefined;
    if (input.loadPct !== undefined) {
      reportedLoadPct = Math.max(0, Math.min(100, Math.round(input.loadPct)));
      patch.reportedLoadPct = reportedLoadPct;
    } else if (found.reportedLoadPct !== undefined) {
      reportedLoadPct = found.reportedLoadPct;
    }
    // Status transitions driven by the heartbeat:
    //  - A `pending` node stays pending — only completeNodeEnrollment
    //    moves it to active.
    //  - An `offline` node walks back to active (load-based degraded
    //    re-evaluation runs in the next branch).
    //  - A load report at or above NODE_DEGRADED_LOAD_PCT marks the
    //    node degraded; a lower report walks it back to active. This
    //    is the same threshold CapacityAgent's `node_saturated` uses
    //    for the synth fleet — operators see a single consistent
    //    "degraded means saturated" semantics.
    if (found.status !== "pending") {
      if (
        reportedLoadPct !== undefined &&
        reportedLoadPct >= NODE_DEGRADED_LOAD_PCT
      ) {
        patch.status = "degraded";
      } else {
        patch.status = "active";
      }
    }
    const updated = await this.deps.store.updateNode(found.id, patch);
    // Activity event on visible state transitions only — a steady
    // active→active heartbeat shouldn't flood the feed.
    if (patch.status && patch.status !== found.status) {
      await this.recordEvent(
        found.accountId,
        "system",
        `Node ${updated.label} ${updated.status}`,
        reportedLoadPct !== undefined
          ? `reported ${updated.reportedInstances ?? 0} instances · ${reportedLoadPct}% load`
          : `agent heartbeat`,
      );
    }
    return { node: this.maskNode(updated) };
  }

  /** Sweep active/degraded BYO nodes for stale heartbeats and flip them
   *  `offline`. Runs every `NODE_HEARTBEAT_SWEEP_INTERVAL_MS` from
   *  `startBackgroundJobs`, and on demand from the dev seam route. The
   *  next heartbeat from an agent walks the row back to active. */
  async runNodeHeartbeatSweep(): Promise<{
    checked: number;
    markedOffline: number;
  }> {
    const all = await this.deps.store.listAllNodes();
    const nowMs = Date.now();
    let marked = 0;
    for (const n of all) {
      if (n.kind !== "byo") continue;
      if (n.status !== "active" && n.status !== "degraded") continue;
      if (!n.lastHeartbeatAt) continue;
      const lastMs = new Date(n.lastHeartbeatAt).getTime();
      if (nowMs - lastMs < NODE_OFFLINE_THRESHOLD_MS) continue;
      await this.deps.store.updateNode(n.id, { status: "offline" });
      await this.recordEvent(
        n.accountId,
        "system",
        `Node ${n.label} offline`,
        `no heartbeat in ${Math.round((nowMs - lastMs) / 60_000)}m`,
      );
      marked += 1;
    }
    return { checked: all.length, markedOffline: marked };
  }

  /** Per-status rollup of an account's nodes. Powers the summary header
   *  on the Console `/nodes` page and `cantila nodes`'s top line. */
  async getNodeFleetSummary(accountId: string): Promise<{
    total: number;
    byStatus: { pending: number; active: number; degraded: number; offline: number; retired: number };
    /** Sum of capacityInstances across active + degraded nodes — what the
     *  scheduler could realistically use. */
    onlineCapacity: number;
    /** Sum of reportedInstances across active + degraded nodes. */
    onlineReported: number;
    /** Count of BYO nodes specifically — distinguishes a fleet that's
     *  pure managed from one with tenant-supplied capacity. */
    byo: number;
  }> {
    const nodes = await this.deps.store.listNodes(accountId);
    const out = {
      total: nodes.length,
      byStatus: { pending: 0, active: 0, degraded: 0, offline: 0, retired: 0 },
      onlineCapacity: 0,
      onlineReported: 0,
      byo: 0,
    };
    for (const n of nodes) {
      out.byStatus[n.status] += 1;
      if (n.kind === "byo") out.byo += 1;
      if (n.status === "active" || n.status === "degraded") {
        out.onlineCapacity += n.capacityInstances;
        out.onlineReported += n.reportedInstances ?? 0;
      }
    }
    return out;
  }

  /** Predicate the CapacityAgent uses to find long-offline BYO nodes
   *  that look like they're really gone — they're candidates for a
   *  `retire_stale_byo` proposal. Exported here (rather than re-derived
   *  in the agent) so the threshold stays in one place. */
  isStaleByoNode(n: Node, nowMs = Date.now()): boolean {
    if (n.kind !== "byo") return false;
    if (n.status !== "offline") return false;
    if (!n.lastHeartbeatAt) return false;
    return nowMs - new Date(n.lastHeartbeatAt).getTime() >= NODE_STALE_THRESHOLD_MS;
  }

  async listAccountNodes(accountId: string): Promise<Node[]> {
    const rows = await this.deps.store.listNodes(accountId);
    return rows.map((n) => this.maskNode(n));
  }

  async getNodeForAccount(
    callerAccountId: string,
    nodeId: string,
  ): Promise<Node | null> {
    const row = await this.deps.store.getNode(nodeId);
    if (!row || row.accountId !== callerAccountId) return null;
    return this.maskNode(row);
  }

  /** Mark a node retired. Account-scoped — the caller's account must
   *  own the row. Existing instances are expected to drain but Cantila
   *  stops scheduling new workloads onto the node from this point. */
  async retireNode(
    callerAccountId: string,
    nodeId: string,
  ): Promise<{ node: Node } | { error: string }> {
    const existing = await this.deps.store.getNode(nodeId);
    if (!existing || existing.accountId !== callerAccountId) {
      return { error: "node not found" };
    }
    if (existing.status === "retired") {
      return { node: this.maskNode(existing) };
    }
    const updated = await this.deps.store.updateNode(nodeId, {
      status: "retired",
      retiredAt: now(),
    });
    await this.recordEvent(
      callerAccountId,
      "system",
      `Node ${updated.label} retired`,
      `${updated.kind} · ${updated.region} · no new schedules`,
    );
    return { node: this.maskNode(updated) };
  }

  /** Append a row to the Activity feed (plan §4.8). Fire-and-forget from
   *  the caller's perspective — we await it so a Prisma-backed store can
   *  fail loudly during development, but a future production path will
   *  publish to a queue instead of waiting for the store. */
  private async recordEvent(
    accountId: string,
    kind: ActivityKind,
    title: string,
    detail: string,
    projectId?: string,
  ): Promise<void> {
    // Plan §5.5 — white-label audit. If the request context says an
    // actor other than the target drove this action (an agency parent
    // acting as a sub-account via X-Cantila-Act-As or a parent-scoped
    // session), stamp the actor onto the event. The recordEvent call
    // sites don't need to thread this — it's pulled from
    // AsyncLocalStorage set by the HTTP layer per request.
    const ctx = getRequestContext();
    const actorAccountId =
      ctx?.actorAccountId && ctx.actorAccountId !== accountId
        ? ctx.actorAccountId
        : undefined;
    await this.deps.store.recordEvent({
      id: id("evt"),
      accountId,
      kind,
      title,
      detail,
      projectId,
      actorAccountId,
      at: now(),
    });
  }

  /** Read the account-wide event feed (newest first). */
  async listEvents(
    accountId: string,
    opts: { limit?: number } = {},
  ): Promise<import("../domain/types").ActivityEvent[]> {
    return this.deps.store.listEvents(accountId, opts);
  }

  /** Force one uptime sweep right now — used by `/v1/monitoring` so the
   *  first hit always returns fresh history rather than waiting for the
   *  next scheduled tick. */
  async refreshMonitoring(): Promise<void> {
    await this.uptimeChecker.sweep();
  }

  /** Billing summary (plan §8) — plan tier, metered usage, recent charges.
   *
   *  Numbers are sourced from real state where possible: project counts,
   *  bucket size, deploy counts, registrar invoices. Plan tier defaults to
   *  Pro until the Account model surfaces a per-account selection. */
  async getBillingSummary(accountId: string): Promise<BillingSummary> {
    const now0 = new Date();
    const periodStart = new Date(
      Date.UTC(now0.getUTCFullYear(), now0.getUTCMonth(), 1),
    );
    const periodEnd = new Date(
      Date.UTC(now0.getUTCFullYear(), now0.getUTCMonth() + 1, 1),
    );
    const periodLengthMs = periodEnd.getTime() - periodStart.getTime();
    const elapsedMs = now0.getTime() - periodStart.getTime();
    const elapsedFraction = Math.max(
      0.0001,
      Math.min(1, elapsedMs / periodLengthMs),
    );

    const [projects, registrations, deployments, buckets] = await Promise.all([
      this.deps.store.listProjects(accountId),
      this.deps.store.listRegistrations(accountId),
      // Fan out — getAccountMetrics already does this but we want fresh totals.
      (async () => {
        const ps = await this.deps.store.listProjects(accountId);
        const lists = await Promise.all(
          ps.map((p) => this.deps.store.listDeployments(p.id)),
        );
        return lists.flat();
      })(),
      this.deps.store.listBuckets(accountId),
    ]);

    const plan =
      PLAN_CATALOG.find((p) => p.tier === "pro") ?? PLAN_CATALOG[0];

    // Compute hours: sum (active hours since creation, capped at period start)
    const computeHours = projects.reduce((sum, p) => {
      const created = new Date(p.createdAt).getTime();
      const start = Math.max(created, periodStart.getTime());
      const hrs = Math.max(0, (now0.getTime() - start) / (1000 * 60 * 60));
      return sum + hrs;
    }, 0);

    // Bandwidth: synthetic until real request metering lands — roughly
    // 12 GB per deploy this month. Cap at plan limit for the meter.
    const deploysThisMonth = deployments.filter(
      (d) => new Date(d.createdAt).getTime() >= periodStart.getTime(),
    ).length;
    const bandwidthGb = Math.min(plan.limits.bandwidthGb * 2, deploysThisMonth * 12);

    // Storage: real — buckets + 1 GB per provisioned managed database.
    const dbCount = (
      await Promise.all(
        projects.map((p) => this.deps.store.getDatabaseByProject(p.id)),
      )
    ).filter((d) => d).length;
    const storageGb =
      buckets.reduce((s, b) => s + b.sizeGb, 0) + dbCount;

    const usage: UsageMeter[] = [
      {
        label: "Live projects",
        used: projects.filter((p) => p.status === "live").length,
        limit: plan.limits.projects,
        unit: "projects",
      },
      {
        label: "Compute hours",
        used: Math.round(computeHours),
        limit: plan.limits.projects * 24 * 31, // illustrative cap
        unit: "hrs",
      },
      {
        label: "Bandwidth",
        used: bandwidthGb,
        limit: plan.limits.bandwidthGb,
        unit: "GB",
      },
      {
        label: "Storage",
        used: storageGb,
        limit: plan.limits.storageGb,
        unit: "GB",
      },
      {
        label: "Outbound emails",
        used: 0,
        limit: plan.limits.monthlyEmails,
        unit: "msgs",
      },
      {
        label: "SMS messages",
        used: 0,
        limit: plan.limits.monthlySms,
        unit: "msgs",
      },
    ];

    // Recent charges: registrar purchases this period are real money. Add a
    // synthesized subscription line at the top of the period.
    const monthLabel = periodStart.toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    const subscriptionLine: InvoiceLineItem = {
      id: `sub_${periodStart.toISOString().slice(0, 7)}`,
      kind: "subscription",
      description: `${plan.name} plan — ${monthLabel}`,
      amountCents: plan.priceCents,
      at: periodStart.toISOString(),
    };
    const domainCharges: InvoiceLineItem[] = registrations
      .filter((r) => new Date(r.createdAt).getTime() >= periodStart.getTime())
      .map((r) => ({
        id: `dom_${r.id}`,
        kind: "domain" as const,
        description: `Domain registration: ${r.hostname}`,
        amountCents: r.pricePerYearCents,
        at: r.createdAt,
      }));

    // Marketplace numbers (plan §4.5) are NOT synthesised here. Their lease
    // and setup fees bill as real Stripe SubscriptionItems / InvoiceItems
    // (plan §8 — Stripe is the system of record); they appear on the Stripe
    // invoice and the Billing Portal, not in this in-app readout. See
    // `startNumberStripeBilling` / `stopNumberStripeBilling`.
    const recentCharges = [...domainCharges, subscriptionLine].sort((a, b) =>
      b.at.localeCompare(a.at),
    );

    const monthToDateCents = recentCharges.reduce(
      (s, c) => s + c.amountCents,
      0,
    );
    const projectedCents = Math.round(monthToDateCents / elapsedFraction);

    return {
      plan,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      monthToDateCents,
      projectedCents,
      usage,
      recentCharges,
      catalog: PLAN_CATALOG,
    };
  }

  /** Monitors + alerts + summary — backs the Console Monitoring page
   *  (plan §5.3). */
  async getMonitoring(accountId: string): Promise<MonitoringSnapshot> {
    const monitors = await this.uptimeChecker.monitors(accountId);
    const monitorsUp = monitors.filter((m) => m.status === "up").length;
    const monitorsDegraded = monitors.filter(
      (m) => m.status === "degraded",
    ).length;
    const monitorsDown = monitors.filter((m) => m.status === "down").length;
    const avgUptimePct =
      monitors.length === 0
        ? 100
        : Math.round(
            (monitors.reduce((s, m) => s + m.uptimePct, 0) / monitors.length) *
              100,
          ) / 100;

    // Alerts come from two sources: recent `alert`-kind events from the
    // activity feed, and currently-crashed projects (always-on signal even
    // if the alert event is older than the feed window).
    const events = await this.deps.store.listEvents(accountId, { limit: 50 });
    const alertEvents: MonitoringAlert[] = events
      .filter((e) => e.kind === "alert")
      .slice(0, 20)
      .map((e) => ({
        id: e.id,
        severity: "warning",
        title: e.title,
        detail: e.detail,
        projectId: e.projectId,
        at: e.at,
      }));

    const projects = await this.deps.store.listProjects(accountId);
    const crashedAlerts: MonitoringAlert[] = projects
      .filter((p) => p.status === "crashed")
      .map((p) => ({
        id: `crash_${p.id}`,
        severity: "critical",
        title: `${p.name} is crashed`,
        detail: `Project status: crashed · runtime ${p.runtime}`,
        projectId: p.id,
        at: now(),
      }));

    // Dedupe — a crash event already in the activity feed shouldn't double.
    const seen = new Set<string>();
    const alerts = [...crashedAlerts, ...alertEvents].filter((a) => {
      const key = a.projectId
        ? `${a.severity}:${a.projectId}:${a.title}`
        : a.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Status components — coarse rollups for the public status page.
    // Each one resolves to up/degraded/down based on underlying signals.
    const monitorsFraction =
      monitors.length === 0 ? 1 : monitorsUp / monitors.length;
    const dataPlane: StatusComponent =
      monitorsFraction === 1
        ? { name: "Data plane", status: "up" }
        : monitorsFraction >= 0.7
          ? {
              name: "Data plane",
              status: "degraded",
              reason: `${monitorsDown + monitorsDegraded} of ${monitors.length} projects unhealthy`,
            }
          : {
              name: "Data plane",
              status: "down",
              reason: `${monitorsDown} of ${monitors.length} projects down`,
            };

    // Deploy pipeline — last 24h deploy success rate. We replay the event
    // feed because it carries `alert`-kind rows for failed deploys.
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const deployEvents = events.filter(
      (e) => e.kind === "deploy" || e.kind === "alert",
    );
    const recentDeploys = deployEvents.filter(
      (e) => new Date(e.at).getTime() >= oneDayAgo,
    );
    const recentFailed = recentDeploys.filter((e) => e.kind === "alert");
    const deployPipeline: StatusComponent =
      recentFailed.length === 0
        ? { name: "Deploy pipeline", status: "up" }
        : recentFailed.length < recentDeploys.length / 2
          ? {
              name: "Deploy pipeline",
              status: "degraded",
              reason: `${recentFailed.length} failed deploy${recentFailed.length === 1 ? "" : "s"} in the last 24h`,
            }
          : {
              name: "Deploy pipeline",
              status: "down",
              reason: `Sustained failure rate — ${recentFailed.length}/${recentDeploys.length} recent deploys failed`,
            };

    const mailService: StatusComponent = projects.some(
      (p) => p.status === "live",
    )
      ? { name: "Cantila Mail", status: "up" }
      : { name: "Cantila Mail", status: "up" };
    const smsService: StatusComponent = {
      name: "Cantila SMS",
      status: "up",
    };
    const domainsService: StatusComponent = {
      name: "Cantila Domains",
      status: "up",
    };
    const apiService: StatusComponent = { name: "Control API", status: "up" };

    const statusComponents: StatusComponent[] = [
      apiService,
      deployPipeline,
      dataPlane,
      mailService,
      smsService,
      domainsService,
    ];

    // Incidents — one per currently-crashed project. Each carries an
    // "investigating" → "monitoring" → "resolved" trail synthesised from
    // the project's recent deploy events.
    const nowMs = Date.now();
    const incidents: Incident[] = [];
    for (const project of projects) {
      if (project.status !== "crashed") continue;
      const projectAlerts = events
        .filter((e) => e.projectId === project.id && e.kind === "alert")
        .slice()
        .sort((a, b) => a.at.localeCompare(b.at));
      const firstAlert = projectAlerts[0];
      const startedAt = firstAlert?.at ?? now();
      const startedMs = new Date(startedAt).getTime();
      const elapsed = Math.max(1000, nowMs - startedMs);
      // State transitions: <5m investigating, 5–30m identified, >30m monitoring.
      const state: IncidentState =
        elapsed < 5 * 60 * 1000
          ? "investigating"
          : elapsed < 30 * 60 * 1000
            ? "identified"
            : "monitoring";
      const updates: IncidentUpdate[] = projectAlerts.slice(0, 4).map((a) => ({
        at: a.at,
        state: "investigating",
        note: `${a.title} — ${a.detail}`,
      }));
      incidents.push({
        id: `inc_${project.id}`,
        title: `${project.name} is unhealthy`,
        severity: "critical",
        state,
        projectId: project.id,
        startedAt,
        duration: formatDuration(elapsed),
        summary:
          firstAlert?.detail ??
          `Project ${project.name} is reporting status: crashed.`,
        updates,
      });
    }

    return {
      at: now(),
      monitors,
      alerts,
      statusComponents,
      incidents,
      summary: {
        monitorsUp,
        monitorsDegraded,
        monitorsDown,
        avgUptimePct,
        activeAlerts: alerts.length,
        openIncidents: incidents.filter((i) => i.state !== "resolved").length,
      },
    };
  }

  /** Register a new project. Its services are auto-wired on first deploy. */
  async createProject(input: CreateProjectInput): Promise<Project> {
    const slug = slugify(input.name);
    const project: Project = {
      id: id("prj"),
      accountId: input.accountId,
      slug,
      name: input.name,
      runtime: input.runtime,
      region: input.region,
      status: "provisioning",
      vcpu: 1,
      memoryMb: 1024,
      diskGb: 5,
      alwaysOn: false,
      autoSleep: true,
      // Horizontal scaling defaults to 1 instance — matches the legacy
      // single-container contract. Operator opts in to more via cp.scale.
      desiredInstances: 1,
      minInstances: 1,
      maxInstances: 1,
      autoDeploy: false,
      createdAt: now(),
    };
    const created = await this.deps.store.createProject(project);
    // Every project gets a free `*.cantila.app` subdomain immediately (plan §7.4).
    await this.deps.store.createDomain({
      id: id("dom"),
      projectId: created.id,
      hostname: `${slug}.cantila.app`,
      kind: "subdomain",
      sslActive: true,
      primary: true,
      createdAt: now(),
    });
    await this.recordEvent(
      created.accountId,
      "system",
      `Project ${created.name} created`,
      `${created.runtime} · ${created.region} · ${slug}.cantila.app`,
      created.id,
    );
    return stripWebhookSecret(created);
  }

  /** All projects under an account. */
  async listProjects(accountId: string): Promise<Project[]> {
    return stripList(await this.deps.store.listProjects(accountId));
  }

  /** Lightweight project lookup — returns just the row, no joined services.
   *  The HTTP transport calls this for the per-request ownership guard so
   *  the much heavier `getProjectDetail` isn't paid on every request.
   *  `webhookSecret` is stripped — the receiver consults the store
   *  directly for signature verification. */
  async getProject(projectId: string): Promise<Project | null> {
    const p = await this.deps.store.getProject(projectId);
    return p ? stripWebhookSecret(p) : null;
  }

  /** Resolve a project from an account handle + project name pair.
   *  Powers the `/@handle/<name>` URL pattern in the Console — users see
   *  human-readable URLs while the backend keeps using the `prj_*` id
   *  for every other call. Case-insensitive on the project name so
   *  `MyApp` and `myapp` both resolve. */
  async getProjectByHandle(
    handle: string,
    name: string,
  ): Promise<Project | null> {
    const account = await this.deps.store.findAccountByHandle(
      handle.trim().toLowerCase(),
    );
    if (!account) return null;
    const projects = await this.deps.store.listProjects(account.id);
    const lower = name.toLowerCase();
    const match =
      projects.find((p) => p.name.toLowerCase() === lower) ??
      projects.find((p) => p.slug.toLowerCase() === lower);
    return match ? stripWebhookSecret(match) : null;
  }

  /* ----- Cantila Automations / Connections — plan §4.10 + §4.11 ----- */

  /** Create a project tagged as an automation instance. Mirrors the
   *  POST /v1/automations route so the MCP server can drive the same
   *  flow without re-implementing it. */
  async createAutomation(input: {
    accountId: string;
    name: string;
    kind: AutomationKind;
    region?: Region;
    config?: Record<string, unknown>;
  }): Promise<Project> {
    const project = await this.createProject({
      accountId: input.accountId,
      name: input.name,
      runtime: "docker",
      region: input.region ?? "fsn1",
    });
    return this.deps.store.updateProject(project.id, {
      automationKind: input.kind,
      automationConfig: input.config ?? {},
    });
  }

  /** Projects in the account filtered to automation instances only. */
  async listAutomations(accountId: string): Promise<Project[]> {
    const all = await this.listProjects(accountId);
    return all.filter((p) => p.automationKind);
  }

  /** Per-automation workflow rollup the AutomationAgent reads. One row
   *  per automation Project; per-workflow last-run status pulled from
   *  the engine adapter. Engines that are unreachable are skipped with
   *  an empty `workflows` array so the agent gets a partial picture
   *  rather than crashing the brain. */
  async getAutomationHealth(
    accountId: string,
  ): Promise<
    {
      automation: Project;
      workflows: {
        id: string;
        name: string;
        lastRunStatus?: "success" | "failed" | "running";
      }[];
      reachable: boolean;
    }[]
  > {
    const list = await this.listAutomations(accountId);
    const out: Awaited<ReturnType<ControlPlane["getAutomationHealth"]>> = [];
    for (const a of list) {
      if (!a.automationKind) continue;
      const registry = this.deps.engineRegistry;
      if (!registry) {
        out.push({ automation: a, workflows: [], reachable: false });
        continue;
      }
      try {
        const adapter = registry.get(a.automationKind);
        const workflows = await adapter.listWorkflows(a.id);
        out.push({ automation: a, workflows, reachable: true });
      } catch {
        out.push({ automation: a, workflows: [], reachable: false });
      }
    }
    return out;
  }

  async listConnections(accountId: string): Promise<Connection[]> {
    return this.deps.store.listConnections(accountId);
  }

  /* ----- credential broker (plan §15.5 Phase F) ----- */

  /** Bind a Cantila Connection into an automation's engine for one run.
   *  Reads the Connection row + the underlying secret, calls the engine
   *  adapter's `bindConnection` with the resolved payload, writes an
   *  audit row, and updates `Connection.lastUsedAt`. Returns the engine-
   *  side credential id (or `null` when the wiring isn't complete — no
   *  registry, no secrets reader, or the connection / automation can't
   *  be resolved).
   *
   *  Defensive on every path: an engine that throws degrades to a
   *  placeholder bind with `pushed: false` and the audit log captures
   *  the error so an operator can see what went wrong. */
  async bindConnectionForRun(input: {
    automationId: string;
    connectionId: string;
    accountId: string;
  }): Promise<{
    engineCredentialId: string;
    expiresAt: string;
    pushed: boolean;
  } | { error: string }> {
    const conn = await this.deps.store.getConnection(input.connectionId);
    if (!conn || conn.accountId !== input.accountId) {
      return { error: "connection not found" };
    }
    const automation = await this.deps.store.getProject(input.automationId);
    if (
      !automation ||
      !automation.automationKind ||
      automation.accountId !== input.accountId
    ) {
      return { error: "automation not found" };
    }
    const registry = this.deps.engineRegistry;
    if (!registry) {
      return { error: "engine registry not configured" };
    }
    const adapter = registry.get(automation.automationKind);
    if (!adapter.bindConnection) {
      return { error: "adapter does not support bindConnection" };
    }
    const engineLabel =
      registry.labels?.get(automation.automationKind) ??
      `${automation.automationKind}@unknown`;

    let payload: Record<string, string> | null = null;
    if (this.deps.resolveSecret) {
      try {
        payload = await this.deps.resolveSecret(conn.secretRef);
      } catch {
        payload = null;
      }
    }

    let result: {
      engineCredentialId: string;
      expiresAt: string;
      pushed?: boolean;
    };
    let auditError: string | undefined;
    try {
      result = await adapter.bindConnection(
        input.automationId,
        input.connectionId,
        payload
          ? { provider: conn.provider, payload, name: conn.name }
          : undefined,
      );
    } catch (err) {
      auditError = err instanceof Error ? err.message : "bind failed";
      // Mint a placeholder so the route still has an id to return; the
      // audit row records the error.
      result = {
        engineCredentialId: `cantila:${input.connectionId}:${id("ecred")}`,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        pushed: false,
      };
    }

    const audit: ConnectionAuditEvent = {
      id: id("caud"),
      accountId: input.accountId,
      connectionId: input.connectionId,
      automationId: input.automationId,
      kind: "bind",
      engineLabel,
      engineCredentialId: result.engineCredentialId,
      pushed: result.pushed ?? false,
      expiresAt: result.expiresAt,
      error: auditError,
      at: now(),
    };
    await this.deps.store.recordConnectionAudit(audit);
    // Update the Connection's lastUsedAt so the Console's "last used"
    // column reflects the bind regardless of whether real bytes shipped.
    await this.deps.store.updateConnection(input.connectionId, {
      lastUsedAt: audit.at,
    });

    if (auditError) return { error: auditError };
    return {
      engineCredentialId: result.engineCredentialId,
      expiresAt: result.expiresAt,
      pushed: result.pushed ?? false,
    };
  }

  /** Tear down a previously-bound engine credential. Symmetric to
   *  `bindConnectionForRun` — writes an audit row regardless of the
   *  adapter's response. */
  async unbindConnectionForRun(input: {
    automationId: string;
    connectionId: string;
    engineCredentialId: string;
    accountId: string;
  }): Promise<{ ok: true } | { error: string }> {
    const automation = await this.deps.store.getProject(input.automationId);
    if (
      !automation ||
      !automation.automationKind ||
      automation.accountId !== input.accountId
    ) {
      return { error: "automation not found" };
    }
    const registry = this.deps.engineRegistry;
    if (!registry) return { error: "engine registry not configured" };
    const adapter = registry.get(automation.automationKind);
    const engineLabel =
      registry.labels?.get(automation.automationKind) ??
      `${automation.automationKind}@unknown`;

    let auditError: string | undefined;
    try {
      if (adapter.unbindConnection) {
        await adapter.unbindConnection(
          input.automationId,
          input.engineCredentialId,
        );
      }
    } catch (err) {
      auditError = err instanceof Error ? err.message : "unbind failed";
    }
    await this.deps.store.recordConnectionAudit({
      id: id("caud"),
      accountId: input.accountId,
      connectionId: input.connectionId,
      automationId: input.automationId,
      kind: "unbind",
      engineLabel,
      engineCredentialId: input.engineCredentialId,
      // unbind doesn't push fresh bytes; recording `pushed: false`
      // keeps the column meaningful (it tracks bind-time push status).
      pushed: false,
      error: auditError,
      at: now(),
    });
    if (auditError) return { error: auditError };
    return { ok: true };
  }

  async listConnectionAudits(query: {
    accountId: string;
    connectionId?: string;
    limit?: number;
  }): Promise<ConnectionAuditEvent[]> {
    return this.deps.store.listConnectionAudits(query);
  }

  /* ----- workflow execution history (plan §15.5 Phase F) ----- */

  /** Open a captured-run row for a freshly-started execution. The
   *  streaming endpoint feeds events into it via
   *  `appendCapturedExecutionEvent`; the terminal status is recorded
   *  with `completeCapturedExecution`. Idempotent — calling twice with
   *  the same `id` is a no-op replay (the first row wins). */
  async recordWorkflowExecution(input: {
    id: string;
    automationId: string;
    accountId: string;
    workflowId: string;
    workflowName?: string;
    replayOfId?: string;
  }): Promise<WorkflowExecutionRecord> {
    const existing = await this.deps.store.getWorkflowExecution(input.id);
    if (existing) return existing;
    const record: WorkflowExecutionRecord = {
      id: input.id,
      automationId: input.automationId,
      accountId: input.accountId,
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      status: "running",
      startedAt: now(),
      events: [],
      replayOfId: input.replayOfId,
    };
    return this.deps.store.createWorkflowExecution(record);
  }

  async appendCapturedExecutionEvent(
    executionId: string,
    event: WorkflowExecutionEvent,
  ): Promise<void> {
    await this.deps.store.appendExecutionEvent(executionId, event);
  }

  async completeCapturedExecution(
    executionId: string,
    patch: {
      status: "success" | "failed";
      finishedAt?: string;
      nodeStates?: Record<
        string,
        "pending" | "running" | "success" | "failed"
      >;
      error?: string;
    },
  ): Promise<WorkflowExecutionRecord | null> {
    return this.deps.store.updateWorkflowExecution(executionId, {
      status: patch.status,
      finishedAt: patch.finishedAt ?? now(),
      nodeStates: patch.nodeStates,
      error: patch.error,
    });
  }

  async getWorkflowExecution(
    executionId: string,
  ): Promise<WorkflowExecutionRecord | null> {
    return this.deps.store.getWorkflowExecution(executionId);
  }

  async listWorkflowExecutions(query: {
    automationId: string;
    workflowId?: string;
    limit?: number;
  }): Promise<WorkflowExecutionRecord[]> {
    return this.deps.store.listWorkflowExecutions(query);
  }

  async createApiKeyConnection(input: {
    accountId: string;
    provider: string;
    name: string;
    metadata?: Record<string, unknown>;
    secretRef: string;
    authKind: ConnectionAuthKind;
  }): Promise<Connection> {
    const conn: Connection = {
      id: id("conn"),
      accountId: input.accountId,
      provider: input.provider,
      name: input.name,
      authKind: input.authKind,
      status: "active",
      metadata: input.metadata ?? {},
      secretRef: input.secretRef,
      createdAt: now(),
    };
    return this.deps.store.createConnection(conn);
  }

  /** Deployments for one project. Used by the agent swarm and any caller
   *  that wants the raw list without the masked-secrets project detail. */
  async listProjectDeployments(projectId: string): Promise<Deployment[]> {
    return this.deps.store.listDeployments(projectId);
  }

  /** Project + its auto-wired services (secrets masked) + deployments + domains. */
  async getProjectDetail(projectId: string): Promise<ProjectDetail | null> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return null;
    const [database, mailbox, phoneNumber, deployments, domains] =
      await Promise.all([
        this.deps.store.getDatabaseByProject(projectId),
        this.deps.store.getMailboxByProject(projectId),
        this.deps.store.getPhoneNumberByProject(projectId),
        this.deps.store.listDeployments(projectId),
        this.deps.store.listDomains(projectId),
      ]);
    return {
      project: stripWebhookSecret(project),
      services: {
        database: maskDatabase(database),
        mailbox: maskMailbox(mailbox),
        phoneNumber: maskNumber(phoneNumber),
      },
      deployments,
      domains,
    };
  }

  /** Right-sizing + idle-resource recommendations for an account (plan §5.6).
   *
   *  Today's heuristics:
   *    - Project pinned `always-on` with no deploys in 14d → switch to auto-sleep.
   *    - Project sized > 2048 MB but only one live project on the account → step down.
   *    - vCPU > 2 with no scaled deploy in 14d → step down to 1 vCPU.
   *    - Disk > 5 GB with no buckets attached → step down to 5 GB.
   *    - Project hasn't deployed in 30d → archive candidate.
   *    - Bucket holds 0 objects + 0 GB → drop the bucket.
   *    - Domain registration not attached to any project → consider release.
   *
   *  Savings figures are illustrative (per the §8.3 unit-economics model).
   *  The pattern matcher returns a structured report the Console renders
   *  as a checklist; a future LLM-backed analyser can plug into the same
   *  shape with richer reasoning. */
  async getCostOptimisation(
    accountId: string,
  ): Promise<CostOptimisationReport> {
    const projects = await this.deps.store.listProjects(accountId);
    const allDeploys = (
      await Promise.all(
        projects.map((p) => this.deps.store.listDeployments(p.id)),
      )
    ).flat();
    const buckets = await this.deps.store.listBuckets(accountId);
    const registrations = await this.deps.store.listRegistrations(accountId);

    // Per-account analyser (plan §5.6 + §4.3.1) — the tenant's own Claude
    // adapter when they've configured `anthropicApiKey`, otherwise the
    // platform-default analyser.
    const analyser = await this.analyserFor(accountId);
    const recommendations = await analyser.analyseCost({
      accountId,
      projects,
      allDeployments: allDeploys,
      buckets,
      registrations,
    });

    const total = recommendations.reduce(
      (s, r) => s + r.savingsCentsPerMonth,
      0,
    );
    return {
      at: now(),
      accountId,
      totalSavingsCentsPerMonth: total,
      recommendations,
    };
  }

  /** Inspect a deployment and return a plain-language explanation of what
   *  went wrong + suggested fixes (plan §5.6 — AI troubleshooting).
   *
   *  Today's analyser is rule-based: it pattern-matches against the eight
   *  pipeline steps. The same interface will fit an LLM-backed engine,
   *  which can read the build logs + recent commit + the project's runtime
   *  and generate richer suggestions. */
  async troubleshootDeploy(
    projectId: string,
    deploymentId: string,
  ): Promise<TroubleshootResult | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const deployments = await this.deps.store.listDeployments(projectId);
    const target = deployments.find((d) => d.id === deploymentId);
    if (!target) {
      return { error: "deployment not found on this project" };
    }

    const failed = target.status === "failed";
    const lastStep = target.logs[target.logs.length - 1];
    // Delegate suggestion generation to the AI analyser for this account
    // (plan §5.6 + §4.3.1). `analyserFor` returns the tenant's own Claude
    // adapter when they've set `anthropicApiKey`, otherwise the
    // platform-default analyser.
    const analyser = await this.analyserFor(project.accountId);
    const suggestions = await analyser.analyseDeploy({
      project,
      deployment: target,
      allDeployments: deployments,
    });
    return {
      deploymentId,
      failed,
      lastStep,
      suggestions,
      excerpt: target.logs,
    };
  }

  /** Reports which AI adapter is wired ("rule-based" vs "Claude" etc.) —
   *  surfaced on `GET /v1/ai/info` so operators can see whether the
   *  bundled stub is in use without inspecting env. */
  aiInfo(): { label: string; live: boolean } {
    return {
      label: this.deps.aiAnalyser.label,
      live: this.deps.aiAnalyser.live,
    };
  }

  /** The public marketing pricing catalog (plan §4.7 / §8.2). Method
   *  rather than free import so it sits with `aiInfo` / `mailInfo` and
   *  the HTTP layer never reaches into the module-level pricebook. */
  getPublicBillingCatalog(): PublicBillingCatalog {
    return getPublicBillingCatalog();
  }

  /** Resolve the AI analyser that should serve this account. When the
   *  account has its own `anthropicApiKey` set (plan §4.3.1 — "Run Chat
   *  Deploy on your own Claude account"), construct a Claude analyser
   *  scoped to that key — model spend is billed to the tenant's
   *  Anthropic account, not Cantila's. Otherwise fall back to the
   *  control-plane-default analyser. The per-account analyser uses the
   *  default analyser as its own fallback, so a bad tenant key degrades
   *  to the operator's analyser instead of failing the user's request. */
  async analyserFor(accountId: string): Promise<AiAnalyser> {
    const account = await this.deps.store.getAccount(accountId);
    if (account?.anthropicApiKey) {
      try {
        return new ClaudeAiAnalyser({
          // Stored encrypted-at-rest — decrypt before handing to the SDK.
          apiKey: decryptSecret(account.anthropicApiKey),
          fallback: this.deps.aiAnalyser,
        });
      } catch {
        // The stored key can't be decrypted (CANTILA_SECRET_KEY missing
        // or changed) — degrade to the platform-default analyser rather
        // than failing the tenant's request.
        return this.deps.aiAnalyser;
      }
    }
    return this.deps.aiAnalyser;
  }

  /** Set / rotate the per-account Anthropic API key. Returns the
   *  masked-account view (the raw key is never echoed). */
  async setAnthropicApiKey(
    accountId: string,
    rawKey: string,
  ): Promise<Account | { error: string }> {
    const account = await this.deps.store.getAccount(accountId);
    if (!account) return { error: "account not found" };
    const updated = await this.deps.store.updateAccount(accountId, {
      // Encrypted at rest — see src/lib/secrets.ts. No-op pass-through
      // when CANTILA_SECRET_KEY is unset, so dev installs are unaffected.
      anthropicApiKey: encryptSecret(rawKey),
    });
    await this.recordEvent(
      accountId,
      "system",
      `Per-account Anthropic API key set`,
      `prefix ${rawKey.slice(0, 10)}… · spend now billed to the tenant`,
    );
    return maskAccount(updated) as Account;
  }

  /** Remove the per-account key — revert to the platform-default analyser. */
  async clearAnthropicApiKey(
    accountId: string,
  ): Promise<Account | { error: string }> {
    const account = await this.deps.store.getAccount(accountId);
    if (!account) return { error: "account not found" };
    const updated = await this.deps.store.updateAccount(accountId, {
      anthropicApiKey: undefined,
    });
    await this.recordEvent(
      accountId,
      "system",
      `Per-account Anthropic API key cleared`,
      `tenant now uses the platform-default AI analyser`,
    );
    return maskAccount(updated) as Account;
  }

  /* ============================================================
     Per-user auth — sessions & SSO (plan §5.4).
     Additive to the scoped-API-key model: keys gate the API,
     sessions gate the Console. The request-auth hook is unchanged.
     ============================================================ */

  /** Find a user by email, or create one. SSO logins, password registration
   *  and the invite-accept path all funnel through here.
   *
   *  Plan §18 (Option B multi-org tenancy): Users are NOT bound to a single
   *  account at creation time. Account membership is expressed by
   *  `Membership` rows; a session's active org is recorded in
   *  `Session.currentAccountId`. Only the invite-accept path passes an
   *  `accountId`, and that goes into a `Membership` row, not the legacy
   *  `AuthUser.accountId` column.
   *
   *  The legacy `accountId` column on `AuthUser` is preserved for
   *  backward compatibility but is no longer set on new users. The
   *  `resolveAccountId` helper still reads it as a last-ditch fallback
   *  for accounts that haven't been migrated to memberships yet. */
  private async findOrCreateUser(input: {
    email: string;
    name?: string;
    passwordHash?: string;
    accountId?: string;
    avatarUrl?: string;
  }): Promise<AuthUser> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.deps.store.findUserByEmail(email);
    if (existing) {
      // If the caller passed an accountId (invite-accept path) and the user
      // doesn't yet belong to that account, write the membership row.
      if (input.accountId) {
        const already = await this.deps.store.findMembership(
          existing.id,
          input.accountId,
        );
        if (!already) {
          await this.deps.store.createMembership({
            id: id("mem"),
            userId: existing.id,
            accountId: input.accountId,
            role: "developer",
            createdAt: now(),
          });
        }
      }
      // Refresh the avatar only when we have none on file — never clobber
      // a value the user may later customise.
      if (input.avatarUrl && !existing.avatarUrl) {
        return this.deps.store.setUserAvatarUrl(existing.id, input.avatarUrl);
      }
      return existing;
    }
    // Create the user with NO legacy account binding — Option B.
    const user = await this.deps.store.createUser({
      id: id("usr"),
      email,
      name: input.name?.trim() || email.split("@")[0],
      passwordHash: input.passwordHash,
      avatarUrl: input.avatarUrl,
      twoFactorEnabled: false,
      // accountId left undefined — memberships drive tenancy now.
      accountId: undefined,
      createdAt: now(),
    });
    // Invite-accept path: bind the new user to the inviting account
    // via a Membership row.
    if (input.accountId) {
      await this.deps.store.createMembership({
        id: id("mem"),
        userId: user.id,
        accountId: input.accountId,
        role: "developer",
        createdAt: now(),
      });
    }
    return user;
  }

  /** Mint a session for a user. Returns the raw token (shown exactly
   *  once) + expiry; only the SHA-256 hash is persisted.
   *
   *  Plan §18 — Option B: the freshly minted session is auto-scoped to
   *  the user's first membership (sorted by createdAt ascending) so that
   *  immediately after login the Console has a "current org" to scope
   *  API calls to. Users with no memberships get an unscoped session
   *  (`currentAccountId === undefined`); the Console is expected to
   *  surface an "accept an invite or create an org" screen for that
   *  case. The legacy `AuthUser.accountId` column is consulted as a
   *  last-ditch fallback for users that haven't been migrated to
   *  memberships yet. */
  private async mintSession(
    userId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const token = `cts_${randomBytes(24).toString("hex")}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    // 7-day sessions — long enough for the Console to feel sticky.
    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const memberships = await this.deps.store.listMembershipsByUser(userId);
    let currentAccountId: string | undefined = memberships[0]?.accountId;
    if (!currentAccountId) {
      // Legacy migration fallback: if the user still carries an
      // AuthUser.accountId, lift it into a Membership row and use it.
      const user = await this.deps.store.getUser(userId);
      if (user?.accountId) {
        await this.deps.store.createMembership({
          id: id("mem"),
          userId,
          accountId: user.accountId,
          role: "owner",
          createdAt: now(),
        });
        currentAccountId = user.accountId;
      }
    }
    await this.deps.store.createSession({
      id: id("ses"),
      userId,
      tokenHash,
      expiresAt,
      createdAt: now(),
      currentAccountId,
    });
    return { token, expiresAt };
  }

  /** Sign in with email + password. An unknown email or a wrong password
   *  both fail with the same generic message — there is no auto-register,
   *  so the endpoint can't be used to enumerate accounts. New users sign
   *  up explicitly via /v1/auth/register. The `name` field is ignored
   *  here and kept only for signature compatibility. */
  async loginWithPassword(input: {
    email: string;
    password: string;
    name?: string;
  }): Promise<
    | {
        token: string;
        expiresAt: string;
        user: { id: string; email: string; name: string };
      }
    | { error: string }
  > {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { error: "a valid email address is required" };
    }
    if (input.password.length < 1) {
      return { error: "a password is required" };
    }
    const existing = await this.deps.store.findUserByEmail(email);
    if (
      !existing ||
      !existing.passwordHash ||
      !verifyPassword(input.password, existing.passwordHash)
    ) {
      // No auto-register: unknown email and wrong password are
      // indistinguishable, so an attacker can't enumerate accounts.
      // New users sign up explicitly via /v1/auth/register.
      return { error: "incorrect email or password" };
    }
    const user = existing;
    const { token, expiresAt } = await this.mintSession(user.id);
    return {
      token,
      expiresAt,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  /** Register a new password user explicitly. Fails if the email is taken. */
  /** Self-service password change for the currently signed-in user
   *  (plan §5.4). Verifies the current password against the stored hash
   *  before writing the new one; returns `{ error }` on a mismatch or a
   *  too-short new password. Same store call as `adminResetPassword`,
   *  different gate: the caller has already proven their identity via
   *  the session cookie, so no admin token is needed. */
  async changePassword(input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<{ userId: string } | { error: string }> {
    if (input.newPassword.length < 8) {
      return { error: "new password must be at least 8 characters" };
    }
    if (input.newPassword === input.currentPassword) {
      return { error: "new password must differ from the current one" };
    }
    const user = await this.deps.store.getUser(input.userId);
    if (!user) return { error: "user not found" };
    if (
      !user.passwordHash ||
      !verifyPassword(input.currentPassword, user.passwordHash)
    ) {
      return { error: "current password is incorrect" };
    }
    await this.deps.store.updateUserPassword(
      input.userId,
      hashPassword(input.newPassword),
    );
    // Rotate: invalidate every existing session so a stolen cookie can't
    // outlive a password change. The caller re-authenticates.
    await this.deps.store.deleteSessionsByUser(input.userId);
    return { userId: input.userId };
  }

  /** Admin password reset — bypass for the missing `/forgot` flow.
   *  Gated by the `CANTILA_ADMIN_TOKEN` env var checked in index.ts; this
   *  layer assumes the caller is already authenticated as an operator.
   *  Returns `null` if no user with that email exists. */
  async adminResetPassword(input: {
    email: string;
    newPassword: string;
  }): Promise<{ email: string; userId: string } | null> {
    const email = input.email.trim().toLowerCase();
    if (input.newPassword.length < 8) {
      throw new Error("password must be at least 8 characters");
    }
    const existing = await this.deps.store.findUserByEmail(email);
    if (!existing) return null;
    await this.deps.store.updateUserPassword(
      existing.id,
      hashPassword(input.newPassword),
    );
    return { email, userId: existing.id };
  }

  /* ----- one-shot tokens: password reset + email verify (plan §5.4 / v1.18) ----- */

  /** Begin a password reset for the given email. Mints a single-use
   *  token, stores its hash with a 1h TTL, and hands it to the mail
   *  provider for delivery. Always returns `{ ok: true }` regardless
   *  of whether the email exists — leaking that signal would let
   *  anyone enumerate the user table. The Console renders a generic
   *  "if an account exists, we sent a link" toast. */
  async requestPasswordReset(input: {
    email: string;
  }): Promise<{ ok: true; debugLink?: string }> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: true };
    }
    const user = await this.deps.store.findUserByEmail(email);
    if (!user) {
      return { ok: true };
    }
    // Rate-limit per email — bound on policy.maxPerWindow within
    // policy.rateWindowMs (1h for password reset).
    const policy = TOKEN_POLICY.password_reset;
    const recent = this.countRecentOneShotTokens(
      user.id,
      "password_reset",
      policy.rateWindowMs,
    );
    if (recent >= policy.maxPerWindow) {
      // Same `ok: true` shape — don't surface rate-limit signal to
      // unauthenticated callers either.
      return { ok: true };
    }

    const { raw, stored } = mintOneShotToken({
      purpose: "password_reset",
      userId: user.id,
    });
    this.oneShotTokens.set(stored.id, stored);
    this.pruneOneShotTokens();

    const resetLink = this.buildResetLink("/reset", raw);
    // Send via the MailProvider seam. Stub returns a deterministic
    // outcome and still "delivers" (in-memory); a future Mailcow
    // adapter actually emails. We deliberately ignore the outcome —
    // if Mail is down, the operator can always run
    // `adminResetPassword` instead.
    await mailProvider
      .sendMail({
        from: this.systemSenderAddress(),
        to: email,
        subject: "Reset your Cantila password",
        body: this.renderResetEmail({ name: user.name, link: resetLink }),
      })
      .catch(() => {});

    // Stub-MTA mode (live === false) → expose the link in the
    // response so the developer / smoke test can complete the flow
    // without a real inbox. Never exposed in production-live mode.
    const debugLink = mailProvider.live ? undefined : resetLink;
    return { ok: true, debugLink };
  }

  /** Complete a password reset — verify the token + set the new
   *  password. Returns `{error}` for any reason the new password
   *  isn't accepted (bad token, weak password); the caller surfaces
   *  the generic "this link is invalid or expired" toast. */
  async completePasswordReset(input: {
    token: string;
    newPassword: string;
  }): Promise<{ userId: string } | { error: TokenVerifyOutcome | "weak_password" }> {
    if (input.newPassword.length < 8) {
      return { error: "weak_password" };
    }
    const verdict = this.consumeOneShotToken(input.token, "password_reset");
    if ("error" in verdict) return { error: verdict.error };

    await this.deps.store.updateUserPassword(
      verdict.userId,
      hashPassword(input.newPassword),
    );
    return { userId: verdict.userId };
  }

  /** Fetch the AuthUser row by id. Surfaces the session-bound user
   *  to read-only callers like `/v1/me`. */
  async getAuthUser(userId: string) {
    return this.deps.store.getUser(userId);
  }

  /** Begin an email-verify for the currently signed-in user. Mints
   *  a 24h token, stores its hash, and hands it to the mail provider
   *  for delivery to the user's current email address. Idempotent —
   *  a verified user can request another link (re-verification) but
   *  the policy cap still applies. */
  async requestEmailVerification(input: {
    userId: string;
  }): Promise<{ ok: true; debugLink?: string } | { error: string }> {
    const user = await this.deps.store.getUser(input.userId);
    if (!user) return { error: "user not found" };

    const policy = TOKEN_POLICY.email_verify;
    const recent = this.countRecentOneShotTokens(
      user.id,
      "email_verify",
      policy.rateWindowMs,
    );
    if (recent >= policy.maxPerWindow) {
      return { error: "verification email rate limit hit; try again later" };
    }

    const { raw, stored } = mintOneShotToken({
      purpose: "email_verify",
      userId: user.id,
    });
    this.oneShotTokens.set(stored.id, stored);
    this.pruneOneShotTokens();

    const verifyLink = this.buildResetLink("/verify", raw);
    await mailProvider
      .sendMail({
        from: this.systemSenderAddress(),
        to: user.email,
        subject: "Verify your Cantila email",
        body: this.renderVerifyEmail({ name: user.name, link: verifyLink }),
      })
      .catch(() => {});

    const debugLink = mailProvider.live ? undefined : verifyLink;
    return { ok: true, debugLink };
  }

  /** Complete the email-verify flow — verify the token and stamp
   *  the `emailVerifiedAt` timestamp on the user row. */
  async completeEmailVerification(input: {
    token: string;
  }): Promise<{ userId: string; verifiedAt: string } | { error: TokenVerifyOutcome }> {
    const verdict = this.consumeOneShotToken(input.token, "email_verify");
    if ("error" in verdict) return { error: verdict.error };

    const verifiedAt = new Date().toISOString();
    await this.deps.store.setUserEmailVerifiedAt(verdict.userId, verifiedAt);
    return { userId: verdict.userId, verifiedAt };
  }

  /** Pure helper — verify a presented token, mark it used on
   *  success, return either the user id or an error verdict. Shared
   *  by both reset + verify so the verdict shape is uniform. */
  private consumeOneShotToken(
    presented: string,
    expectedPurpose: TokenPurpose,
  ):
    | { userId: string }
    | { error: TokenVerifyOutcome } {
    const parsed = parsePresentedToken(presented);
    if (!parsed) return { error: "wrong_token" };
    const stored = this.oneShotTokens.get(parsed.id);
    if (!stored || stored.purpose !== expectedPurpose) {
      return { error: "wrong_token" };
    }
    const now = new Date();
    const outcome = evaluateTokenVerification(stored, parsed, now);
    if (outcome !== "verified") {
      // Burn expired tokens — they can't come back to life and we
      // shouldn't keep growing the map.
      if (
        outcome === "expired" &&
        effectiveTokenStatus(stored, now) === "expired"
      ) {
        this.oneShotTokens.delete(stored.id);
      }
      return { error: outcome };
    }
    // Mark used so a second submit of the same token fails as
    // `already_used` instead of `verified`.
    this.oneShotTokens.set(stored.id, { ...stored, status: "used" });
    return { userId: stored.userId };
  }

  /** Count the user's recent one-shot tokens of a given purpose
   *  within the policy window — back-end of rate-limiting. */
  private countRecentOneShotTokens(
    userId: string,
    purpose: TokenPurpose,
    windowMs: number,
  ): number {
    const cutoff = Date.now() - windowMs;
    let n = 0;
    for (const t of this.oneShotTokens.values()) {
      if (t.userId !== userId || t.purpose !== purpose) continue;
      if (new Date(t.createdAt).getTime() < cutoff) continue;
      n++;
    }
    return n;
  }

  /** Drop expired token records — bounded sweep so the map can't
   *  grow without limit. */
  private pruneOneShotTokens(): void {
    const now = Date.now();
    for (const [id, t] of this.oneShotTokens) {
      if (new Date(t.expiresAt).getTime() < now && t.status !== "used") {
        this.oneShotTokens.delete(id);
      }
    }
  }

  /** Compose a public URL for a one-shot token link. The path is
   *  the Console route (e.g. `/reset/<token>`) — the Console base
   *  URL is the marketing apex (where the auth-public group lives).
   *  Falls back to the relative path so a manual operator paste
   *  into a localhost dev session still works. */
  private buildResetLink(routePrefix: string, rawToken: string): string {
    const apex = (
      process.env.CANTILA_PUBLIC_HOST ||
      process.env.CANTILA_APEX_DOMAIN ||
      ""
    ).trim();
    const path = `${routePrefix}/${encodeURIComponent(rawToken)}`;
    if (!apex) return path;
    const host = apex.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return `https://${host}${path}`;
  }

  /** From-address for system mail. Falls back to a sensible apex
   *  default — once `cp.sendMail`'s real mailbox abstraction grows
   *  a "system" reserved address, this collapses into that. */
  private systemSenderAddress(): string {
    const apex = (
      process.env.CANTILA_APEX_DOMAIN ||
      process.env.CANTILA_PUBLIC_HOST ||
      "cantila.app"
    )
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");
    return `noreply@${apex}`;
  }

  private renderResetEmail(input: { name: string; link: string }): string {
    return [
      `Hi ${input.name || "there"},`,
      "",
      "We received a request to reset your Cantila password.",
      "Click the link below to set a new one — it expires in 1 hour.",
      "",
      input.link,
      "",
      "If you didn't request this, you can safely ignore this email.",
      "",
      "— Cantila",
    ].join("\n");
  }

  private renderVerifyEmail(input: { name: string; link: string }): string {
    return [
      `Hi ${input.name || "there"},`,
      "",
      "Confirm this email address belongs to you by clicking the link below.",
      "It expires in 24 hours.",
      "",
      input.link,
      "",
      "If you didn't sign up for Cantila, you can safely ignore this email.",
      "",
      "— Cantila",
    ].join("\n");
  }

  async registerUser(input: {
    email: string;
    password: string;
    name?: string;
  }): Promise<
    | {
        token: string;
        expiresAt: string;
        user: { id: string; email: string; name: string };
      }
    | { error: string }
  > {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { error: "a valid email address is required" };
    }
    if (input.password.length < 8) {
      return { error: "password must be at least 8 characters" };
    }
    if (await this.deps.store.findUserByEmail(email)) {
      return { error: "an account with that email already exists" };
    }
    const user = await this.findOrCreateUser({
      email,
      name: input.name,
      passwordHash: hashPassword(input.password),
    });
    const { token, expiresAt } = await this.mintSession(user.id);
    return {
      token,
      expiresAt,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  /** The configured SSO providers, for the Console login/signup pages.
   *  Each entry's `live` flag lets the Console badge the bundled stub.
   *  Mirrors `aiInfo` / billing info. */
  ssoInfo(): {
    providers: Array<{ id: string; label: string; live: boolean }>;
  } {
    return { providers: availableSsoProviders() };
  }

  /** Begin an SSO login for a specific provider — returns the IdP
   *  authorize URL the browser should follow plus the `state` the
   *  Console persists for the callback CSRF check. The bundled stub
   *  provider round-trips locally. */
  beginSsoLogin(
    provider: string,
    redirectUri: string,
  ): {
    authorizeUrl: string;
    provider: string;
    state: string;
    codeVerifier: string;
  } {
    const p = getSsoProvider(provider);
    const state = randomBytes(12).toString("hex");
    const codeVerifier = generatePkceVerifier();
    const codeChallenge = derivePkceChallenge(codeVerifier);
    const { authorizeUrl } = p.startLogin({ redirectUri, state, codeChallenge });
    return { authorizeUrl, provider: p.label, state, codeVerifier };
  }

  /** Complete an SSO login from the IdP callback — resolves the verified
   *  profile for the named provider, find-or-creates the user, and mints
   *  a session. */
  async loginWithSso(input: {
    provider: string;
    code?: string;
    email?: string;
    codeVerifier?: string;
  }): Promise<
    | {
        token: string;
        expiresAt: string;
        user: { id: string; email: string; name: string };
      }
    | { error: string }
  > {
    let profile: SsoProfile;
    try {
      profile = await getSsoProvider(input.provider).completeLogin(input);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "SSO login failed",
      };
    }
    const user = await this.findOrCreateUser({
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });
    const { token, expiresAt } = await this.mintSession(user.id);
    return {
      token,
      expiresAt,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  /** Resolve a raw session token to its signed-in user. Returns null
   *  when the token is unknown or the session has expired (and clears
   *  the expired row best-effort). */
  async resolveSession(rawToken: string): Promise<
    | {
        sessionId: string;
        user: {
          id: string;
          email: string;
          name: string;
          avatarUrl?: string;
          accountId?: string;
        };
        expiresAt: string;
        currentAccountId?: string;
      }
    | null
  > {
    if (!rawToken) return null;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const session = await this.deps.store.findSessionByTokenHash(tokenHash);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      await this.deps.store.deleteSession(session.id);
      return null;
    }
    const user = await this.deps.store.getUser(session.userId);
    if (!user) return null;
    // Plan §18 — Option B: the authoritative account for this request is
    // the session's `currentAccountId`. We fall back to the legacy
    // `AuthUser.accountId` for pre-§18 sessions; both can be undefined for
    // brand-new users with no memberships yet (Console will route them to
    // an "accept an invite or create an org" screen).
    return {
      sessionId: session.id,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        accountId: user.accountId,
      },
      expiresAt: session.expiresAt,
      currentAccountId: session.currentAccountId ?? user.accountId,
    };
  }

  /* ============================================================
     Multi-org tenancy — list / switch / leave (plan §18 Option B).
     ============================================================ */

  /** List every account the user belongs to, plus their role and the
   *  account's display name. Powers the Console org-switcher dropdown
   *  (`GET /v1/me/orgs`) and the CLI `cantila orgs list`.
   *
   *  Plan §5.5 — white-label: also lists every sub-account of every
   *  reseller-eligible parent the user is a member of, marked with
   *  `viaParentAccountId` so the Console can render "via parent: X" and
   *  the CLI can group them visually. A user who is a *member* of both
   *  the parent and a sub-account gets the membership row (direct
   *  access wins; the sub-account row is suppressed to avoid a
   *  duplicate). */
  async listMyOrgs(userId: string): Promise<
    Array<{
      accountId: string;
      accountName: string;
      handle: string;
      role: MemberRole;
      membershipId: string;
      /** Set when this row was surfaced because the user is a member of
       *  the agency parent — not because they have a direct membership
       *  on this sub-account. Undefined for normal membership rows. */
      viaParentAccountId?: string;
    }>
  > {
    const memberships = await this.deps.store.listMembershipsByUser(userId);
    const out: Array<{
      accountId: string;
      accountName: string;
      handle: string;
      role: MemberRole;
      membershipId: string;
      viaParentAccountId?: string;
    }> = [];
    const seen = new Set<string>();
    for (const m of memberships) {
      const account = await this.deps.store.getAccount(m.accountId);
      if (!account) continue; // stale — account was deleted
      out.push({
        accountId: m.accountId,
        accountName: account.name,
        handle: account.handle,
        role: m.role,
        membershipId: m.id,
      });
      seen.add(m.accountId);
    }
    // White-label inheritance: for every reseller-eligible parent the
    // user is a member of, surface its sub-accounts with a synthetic
    // membership row. The membership ID is namespaced (`mem_sub:…`) so
    // it never collides with a real Membership row and the Console can
    // distinguish synthetic rows if it wants to (e.g. hide the "Leave"
    // button — leaving a sub-account you reached through parenthood is
    // a no-op, the parent membership is what grants the access).
    for (const m of memberships) {
      const parent = await this.deps.store.getAccount(m.accountId);
      if (!parent) continue;
      if (!this.RESELLER_PLANS.includes(parent.plan)) continue;
      const children = await this.deps.store.listChildAccounts(m.accountId);
      for (const child of children) {
        if (seen.has(child.id)) continue;
        out.push({
          accountId: child.id,
          accountName: child.name,
          handle: child.handle,
          // Inherit the user's role on the parent — an owner of the
          // agency is functionally an owner of the sub-account too.
          role: m.role,
          membershipId: `mem_sub:${m.id}:${child.id}`,
          viaParentAccountId: parent.id,
        });
        seen.add(child.id);
      }
    }
    return out;
  }

  /** Switch the session's active org. Permitted when EITHER:
   *   - the user is a direct member of the target account (the §18
   *     Option B membership path), OR
   *   - any account the user is currently a member of is the agency
   *     parent of the target (the §5.5 white-label path — an agency
   *     operator switches "into" one of its sub-accounts to administer
   *     it). The parent→child rule is the session-side mirror of the
   *     `canActOnAccount` check `assertProjectAccess` uses for API keys.
   *
   *  Both paths protect against lateral movement via a guessed
   *  accountId — a user on an unrelated tenant gets the same "not a
   *  member" error. Plan §18 — Option B + §5.5 (white-label). */
  async switchOrg(input: {
    sessionId: string;
    userId: string;
    accountId: string;
  }): Promise<{ ok: true; accountId: string } | { error: string }> {
    const direct = await this.deps.store.findMembership(
      input.userId,
      input.accountId,
    );
    let permitted = !!direct;
    let viaParentAccountId: string | undefined;
    if (!permitted) {
      const target = await this.deps.store.getAccount(input.accountId);
      if (target?.parentAccountId) {
        const memberships = await this.deps.store.listMembershipsByUser(
          input.userId,
        );
        const parentMembership = memberships.find(
          (m) => m.accountId === target.parentAccountId,
        );
        if (parentMembership) {
          permitted = true;
          viaParentAccountId = target.parentAccountId;
        }
      }
    }
    if (!permitted) {
      return { error: "you are not a member of that account" };
    }
    await this.deps.store.setSessionCurrentAccount(
      input.sessionId,
      input.accountId,
    );
    await this.recordEvent(
      input.accountId,
      "system",
      viaParentAccountId
        ? `user switched into sub-account (as agency ${viaParentAccountId})`
        : `user switched into account`,
      input.userId,
    );
    return { ok: true, accountId: input.accountId };
  }

  /** Leave an org. The last owner cannot leave — they must hand the
   *  owner role to someone else first, otherwise the account would be
   *  orphaned. Plan §18 — Option B. */
  async leaveOrg(input: {
    sessionId: string;
    userId: string;
    accountId: string;
  }): Promise<{ ok: true } | { error: string }> {
    const membership = await this.deps.store.findMembership(
      input.userId,
      input.accountId,
    );
    if (!membership) {
      return { error: "you are not a member of that account" };
    }
    if (membership.role === "owner") {
      const all = await this.deps.store.listMembershipsByAccount(
        input.accountId,
      );
      const otherOwners = all.filter(
        (m) => m.role === "owner" && m.userId !== input.userId,
      );
      if (otherOwners.length === 0) {
        return {
          error:
            "you are the last owner — promote another member to owner before leaving",
        };
      }
    }
    await this.deps.store.deleteMembership(membership.id);
    // Drop the session's current-account binding if it pointed at the
    // org we just left — the Console will surface the picker again.
    const session = await this.deps.store.getUser(input.userId);
    if (session) {
      // Re-fetch the session row to learn its current binding. We don't
      // have a getSession-by-id; instead, walk the user's memberships
      // and update the session if needed via setSessionCurrentAccount.
      const remaining = await this.deps.store.listMembershipsByUser(
        input.userId,
      );
      await this.deps.store.setSessionCurrentAccount(
        input.sessionId,
        remaining[0]?.accountId ?? null,
      );
    }
    await this.recordEvent(
      input.accountId,
      "system",
      `user left account`,
      input.userId,
    );
    return { ok: true };
  }

  /** Log out — invalidate the session behind a raw token. Idempotent. */
  async logout(rawToken: string): Promise<boolean> {
    if (!rawToken) return false;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const session = await this.deps.store.findSessionByTokenHash(tokenHash);
    if (!session) return false;
    return this.deps.store.deleteSession(session.id);
  }

  /** Run the deploy pipeline — auto-wires services on the first deploy. */
  async deploy(
    projectId: string,
    opts: { trigger: DeployTrigger; source: DeploySource },
  ): Promise<DeployOutcome> {
    const outcome = await runDeploy(this.deps, {
      projectId,
      trigger: opts.trigger,
      source: opts.source,
    });
    await this.emitDeployEvent(projectId, outcome, opts.trigger);
    return outcome;
  }

  /** Streaming variant — fires `onStep` after each pipeline step so an SSE
   *  transport can flush events to the browser in real time (plan §5.3). */
  async deployStreaming(
    projectId: string,
    opts: {
      trigger: DeployTrigger;
      source: DeploySource;
      onStep: (e: DeployStepEvent) => Promise<void> | void;
      pace?: boolean;
    },
  ): Promise<DeployOutcome> {
    const outcome = await runDeploy(this.deps, {
      projectId,
      trigger: opts.trigger,
      source: opts.source,
      onStep: opts.onStep,
      pace: opts.pace ?? true,
    });
    await this.emitDeployEvent(projectId, outcome, opts.trigger);
    return outcome;
  }

  private async emitDeployEvent(
    projectId: string,
    outcome: DeployOutcome,
    trigger: DeployTrigger,
  ): Promise<void> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return;
    if (outcome.status === "live") {
      await this.recordEvent(
        project.accountId,
        "deploy",
        `${project.name} deployed`,
        `${outcome.deploymentId} via ${trigger} · ${outcome.url}`,
        projectId,
      );
    } else {
      await this.recordEvent(
        project.accountId,
        "alert",
        `${project.name} deploy failed`,
        `${outcome.deploymentId} via ${trigger} — ${outcome.steps.slice(-1)[0] ?? "verify-failed"}`,
        projectId,
      );
    }
  }

  /** Environment variables, secret values masked. */
  async getEnv(projectId: string): Promise<EnvView[] | null> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return null;
    const vars = await this.deps.store.listEnvVars(projectId);
    return vars.map((v) => ({
      key: v.key,
      value: v.secret ? mask(v.value) : v.value,
      secret: v.secret,
      scope: v.scope,
    }));
  }

  /** Set or update an environment variable. */
  async setEnv(
    projectId: string,
    key: string,
    value: string,
    opts: { secret?: boolean; scope?: EnvScope } = {},
  ): Promise<EnvView | null> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return null;
    const saved = await this.deps.store.upsertEnvVar({
      id: id("env"),
      projectId,
      key,
      value,
      secret: opts.secret ?? true,
      scope: opts.scope ?? "all",
      updatedAt: now(),
    });
    await this.recordEvent(
      project.accountId,
      "config",
      `Env var ${saved.key} updated on ${project.name}`,
      `${saved.secret ? "secret" : "plain"} · scope ${saved.scope}`,
      projectId,
    );
    return {
      key: saved.key,
      value: saved.secret ? mask(saved.value) : saved.value,
      secret: saved.secret,
      scope: saved.scope,
    };
  }

  /** Build/deploy logs for each of a project's deployments. */
  async getLogs(projectId: string): Promise<DeploymentLogs[] | null> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return null;
    const deployments = await this.deps.store.listDeployments(projectId);
    return deployments.map((d) => ({
      deploymentId: d.id,
      status: d.status,
      logs: d.logs,
    }));
  }

  /** Attach a custom domain. The free *.cantila.app subdomain is created on
   *  project creation; this is for additional (custom) hostnames. */
  async addDomain(
    projectId: string,
    hostname: string,
  ): Promise<AddDomainResult | { error: string }> {
    const host = hostname.trim().toLowerCase();
    if (!isValidHostname(host)) return { error: "invalid hostname" };
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const taken = await this.deps.store.findDomainByHostname(host);
    if (taken) return { error: "hostname already attached" };
    const isCantilaSub = host.endsWith(".cantila.app");
    const domain = await this.deps.store.createDomain({
      id: id("dom"),
      projectId,
      hostname: host,
      kind: isCantilaSub ? "subdomain" : "custom",
      // *.cantila.app is wildcard-covered — issued immediately. Custom domains
      // wait for the DNS record to point at the platform; we mark them issuing
      // and let the data plane flip the flag once Let's Encrypt completes.
      sslActive: isCantilaSub,
      primary: false,
      createdAt: now(),
    });
    await this.recordEvent(
      project.accountId,
      "domain",
      `Domain ${host} attached to ${project.name}`,
      isCantilaSub ? "SSL active" : "SSL issuing — DNS record pending",
      projectId,
    );
    return {
      domain,
      dns: { type: "CNAME", name: host, value: `${project.slug}.cantila.app` },
      ssl: isCantilaSub ? "active" : "issuing",
    };
  }

  /** Vertical + horizontal resize. Horizontal fields (plan §5.2):
   *   - `minInstances` and `maxInstances` are the bounds the data plane
   *     enforces. min ≥ 1, max ≥ min, max ≤ 32 (sanity cap).
   *   - `desiredInstances` is what the LB targets right now; clamped
   *     into [min, max] after the patch is applied so callers can change
   *     one bound and a desired value in the same call without ordering
   *     ambiguity.
   *  Returns `{ error }` on bad bounds instead of throwing so the HTTP
   *  layer can render a clean 400. */
  async scale(
    projectId: string,
    spec: ScaleSpec,
  ): Promise<Project | { error: string } | null> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return null;

    const minInstances = spec.minInstances ?? project.minInstances;
    const maxInstances = spec.maxInstances ?? project.maxInstances;
    if (minInstances < 1) return { error: "minInstances must be >= 1" };
    if (maxInstances < minInstances) {
      return { error: "maxInstances must be >= minInstances" };
    }
    if (maxInstances > 32) {
      return { error: "maxInstances capped at 32 — talk to support for more" };
    }
    const desiredRaw = spec.desiredInstances ?? project.desiredInstances;
    const desiredInstances = Math.max(
      minInstances,
      Math.min(maxInstances, desiredRaw),
    );

    const updated = await this.deps.store.updateProject(projectId, {
      vcpu: spec.vcpu ?? project.vcpu,
      memoryMb: spec.memoryMb ?? project.memoryMb,
      diskGb: spec.diskGb ?? project.diskGb,
      alwaysOn: spec.alwaysOn ?? project.alwaysOn,
      desiredInstances,
      minInstances,
      maxInstances,
    });
    await this.recordEvent(
      project.accountId,
      "config",
      `${project.name} resized`,
      `${updated.vcpu} vCPU · ${updated.memoryMb} MB · ${updated.diskGb} GB · ${updated.alwaysOn ? "always-on" : "auto-sleep"} · instances ${updated.desiredInstances} (${updated.minInstances}–${updated.maxInstances})`,
      projectId,
    );
    return stripWebhookSecret(updated);
  }

  /** Per-node and per-region rollup of how loaded the fleet is, derived
   *  from every project's scheduled instances. The data plane stub round-
   *  robins instances across three nodes per region (`node-{region}-01..03`),
   *  so the same shape works whether you query a single account or the
   *  whole fleet — production swaps the stub for a live Docker / kube
   *  scheduler and the shape stays the same. Powers CapacityAgent and a
   *  future Console "Capacity" page. */
  async getFleetCapacity(accountId?: string): Promise<{
    /** Per-node load. Includes synthesised platform nodes (one row per
     *  `node-<region>-NN` that currently holds instances) plus every
     *  active/degraded BYO node enrolled on the queried account(s)
     *  (plan §5.5). Region is `string` because BYO nodes carry a
     *  free-text region label. */
    nodes: Array<{
      nodeId: string;
      region: string;
      instances: number;
      capacity: number;
      loadPct: number;
      /** Present on BYO node rows. Helps the Console distinguish a
       *  tenant-supplied row from a synthesised platform-fleet row. */
      kind?: NodeKind;
      /** Present on BYO node rows once the agent has reported a load
       *  number. Distinguishes "no signal" (undefined) from "0%". */
      reportedAt?: string;
    }>;
    regions: Array<{
      region: string;
      nodes: number;
      instances: number;
      capacity: number;
      loadPct: number;
    }>;
    totals: {
      nodes: number;
      instances: number;
      capacity: number;
      loadPct: number;
    };
    /** Per-node capacity used for synthesised platform rows. BYO nodes
     *  carry their own `capacityInstances`; this constant only applies
     *  when the data plane scheduler invented a row. */
    nodeCapacity: number;
  }> {
    const NODE_CAPACITY = 16;
    const projects = accountId
      ? await this.deps.store.listProjects(accountId)
      : [];
    const perNode = new Map<
      string,
      { nodeId: string; region: string; instances: number; capacity: number }
    >();
    for (const project of projects) {
      const instances = await this.listInstances(project.id);
      for (const inst of instances) {
        const existing = perNode.get(inst.nodeId) ?? {
          nodeId: inst.nodeId,
          region: inst.region as string,
          instances: 0,
          capacity: NODE_CAPACITY,
        };
        existing.instances += 1;
        perNode.set(inst.nodeId, existing);
      }
    }
    type NodeRow = {
      nodeId: string;
      region: string;
      instances: number;
      capacity: number;
      loadPct: number;
      kind?: NodeKind;
      reportedAt?: string;
    };
    const synthNodes: NodeRow[] = [...perNode.values()].map((n) => ({
      ...n,
      loadPct: Math.round((n.instances / n.capacity) * 100),
    }));

    // Merge BYO nodes — active or degraded; pending/offline/retired
    // are intentionally excluded so they don't dilute the fleet rollup
    // (CapacityAgent reasons over this).
    const byoSource = accountId
      ? await this.deps.store.listNodes(accountId)
      : await this.deps.store.listAllNodes();
    const byoNodes: NodeRow[] = byoSource
      .filter(
        (n) =>
          (n.status === "active" || n.status === "degraded") && n.kind === "byo",
      )
      .map((n) => {
        const instances = n.reportedInstances ?? 0;
        const capacity = n.capacityInstances;
        const loadPct =
          n.reportedLoadPct !== undefined
            ? n.reportedLoadPct
            : capacity === 0
              ? 0
              : Math.round((instances / capacity) * 100);
        return {
          nodeId: n.id,
          region: n.region,
          instances,
          capacity,
          loadPct,
          kind: "byo" as const,
          reportedAt: n.lastHeartbeatAt,
        };
      });

    const nodes = [...synthNodes, ...byoNodes].sort(
      (a, b) => b.loadPct - a.loadPct,
    );
    const regionAgg = new Map<
      string,
      { nodes: number; instances: number; capacity: number }
    >();
    for (const n of nodes) {
      const r = regionAgg.get(n.region) ?? {
        nodes: 0,
        instances: 0,
        capacity: 0,
      };
      r.nodes += 1;
      r.instances += n.instances;
      r.capacity += n.capacity;
      regionAgg.set(n.region, r);
    }
    const regions = [...regionAgg.entries()].map(([region, v]) => ({
      region,
      nodes: v.nodes,
      instances: v.instances,
      capacity: v.capacity,
      loadPct: v.capacity === 0 ? 0 : Math.round((v.instances / v.capacity) * 100),
    }));
    const totalInstances = nodes.reduce((s, n) => s + n.instances, 0);
    const totalCapacity = nodes.reduce((s, n) => s + n.capacity, 0);
    return {
      nodes,
      regions,
      totals: {
        nodes: nodes.length,
        instances: totalInstances,
        capacity: totalCapacity,
        loadPct:
          totalCapacity === 0
            ? 0
            : Math.round((totalInstances / totalCapacity) * 100),
      },
      nodeCapacity: NODE_CAPACITY,
    };
  }

  /** List a project's container instances. Returns `desiredInstances`
   *  rows synthesised by the data plane stub (plan §5.2) — production
   *  wires this to the live container fleet (Docker / kube). */
  async listInstances(projectId: string): Promise<Instance[]> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return [];
    // Synthesise from the stub for now. Deterministic per (project, index)
    // so the same instance keeps the same id between reads.
    const instances: Instance[] = [];
    for (let i = 0; i < project.desiredInstances; i++) {
      instances.push({
        id: `inst_${project.id.slice(4, 12)}_${i}`,
        projectId: project.id,
        index: i,
        // Round-robin across three stub nodes — production schedules
        // across the available fleet. Zero-pad just the index so node
        // ids sort nicely: node-fsn1-01, …-02, …-03.
        nodeId: `node-${project.region}-${String((i % 3) + 1).padStart(2, "0")}`,
        region: project.region,
        status: project.status === "live" ? "healthy" : "starting",
        // All instances reported as started when the project went live.
        startedAt: project.createdAt,
      });
    }
    return instances;
  }

  /** Project load samples for ScaleAgent + the operator surfaces (plan
   *  §5.2). Delegates to the data plane — stub today, real Docker /
   *  kube stats + LB counters in production. Returns the most-recent
   *  samples in oldest-first order; the caller filters / aggregates. */
  async getProjectMetrics(projectId: string): Promise<ProjectMetricSample[]> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return [];
    return this.deps.dataPlane.sampleMetrics(project);
  }

  /** Connect a git repository to a project. After this, pushing to the
   *  configured branch (via the webhook receiver) auto-deploys the project.
   *  Plan §5.1: "Connect GitHub, GitLab, or Bitbucket; auto-deploy on every
   *  push to a chosen branch."
   *
   *  A per-project HMAC secret is minted at connect-time. The plaintext
   *  secret is returned in `webhookSecret` exactly once — the caller pastes
   *  it into GitHub/GitLab's webhook config and Cantila uses it to verify
   *  every subsequent payload. Without this gate, anyone who knew a
   *  project id could fire deploys for it. */
  async connectGit(
    projectId: string,
    opts: { repoUrl: string; branch?: string; autoDeploy?: boolean },
  ): Promise<
    { project: Project; webhookSecret: string; webhookUrl: string }
    | { error: string }
  > {
    const url = opts.repoUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      return { error: "repoUrl must be an https:// URL" };
    }
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    // 32 random bytes hex-encoded → 64 chars, the same shape GitHub
    // recommends for repository webhook secrets.
    const webhookSecret = randomBytes(32).toString("hex");
    const updated = await this.deps.store.updateProject(projectId, {
      repoUrl: url,
      branch: opts.branch ?? "main",
      autoDeploy: opts.autoDeploy ?? true,
      webhookSecret,
    });
    await this.recordEvent(
      project.accountId,
      "git",
      `Git connected to ${project.name}`,
      `${url} · branch ${updated.branch} · auto-deploy ${updated.autoDeploy ? "on" : "off"}`,
      projectId,
    );
    return {
      project: stripWebhookSecret(updated),
      webhookSecret,
      webhookUrl: `/v1/projects/${updated.id}/git/webhook`,
    };
  }

  /** Rotate the per-project webhook HMAC secret. The previous secret is
   *  invalidated immediately — any in-flight push from the old secret
   *  is rejected. Returns the new secret exactly once. */
  async rotateWebhookSecret(
    projectId: string,
  ): Promise<{ project: Project; webhookSecret: string } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    if (!project.repoUrl) {
      return { error: "project is not connected to a repo" };
    }
    const webhookSecret = randomBytes(32).toString("hex");
    const updated = await this.deps.store.updateProject(projectId, {
      webhookSecret,
    });
    await this.recordEvent(
      project.accountId,
      "git",
      `Webhook secret rotated on ${project.name}`,
      "previous secret invalidated",
      projectId,
    );
    return { project: stripWebhookSecret(updated), webhookSecret };
  }

  /** Detach the connected repo. The webhook secret is cleared at the same
   *  time — any future push, even with the old secret, is rejected. */
  async disconnectGit(projectId: string): Promise<Project | null> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return null;
    const updated = await this.deps.store.updateProject(projectId, {
      repoUrl: undefined,
      branch: undefined,
      autoDeploy: false,
      webhookSecret: undefined,
    });
    await this.recordEvent(
      project.accountId,
      "git",
      `Git disconnected from ${project.name}`,
      project.repoUrl ?? "",
      projectId,
    );
    return stripWebhookSecret(updated);
  }

  /** Handle an incoming git push for a project. Verifies the push targets
   *  the connected repo, then either runs a production deploy (push to
   *  the tracked branch) or spins up a preview environment (push to any
   *  other branch — plan §5.1). Returns the deploy outcome or a
   *  structured error so callers can choose how to surface it.
   *
   *  When the project has a `webhookSecret` set (the default after
   *  `connectGit`), the caller MUST supply an HMAC-SHA256 of the raw
   *  request body in `signature` — either a GitHub-style
   *  `sha256=<hex>` value or a bare hex digest. Signature mismatch is a
   *  rejection, not a skip: skips are informational, rejections are an
   *  active "you don't have the secret" signal. */
  async handlePushWebhook(
    projectId: string,
    payload: {
      repoUrl?: string;
      ref?: string; // refs/heads/main
      branch?: string;
      commit?: { hash?: string; message?: string; author?: string };
    },
    auth: { rawBody: string; signature?: string } = { rawBody: "" },
  ): Promise<DeployOutcome | { error: string; code: "skipped" | "rejected" }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found", code: "rejected" };

    // Signature check happens BEFORE the autoDeploy / repoUrl checks so
    // that a bad-signature attacker can't probe project state by toggling
    // payloads.
    if (project.webhookSecret) {
      if (!auth.signature) {
        return {
          error:
            "missing webhook signature (expected X-Hub-Signature-256 or X-Cantila-Signature)",
          code: "rejected",
        };
      }
      if (!verifyHmacSignature(project.webhookSecret, auth.rawBody, auth.signature)) {
        return { error: "webhook signature mismatch", code: "rejected" };
      }
    }

    if (!project.autoDeploy) {
      return { error: "auto-deploy disabled for this project", code: "skipped" };
    }
    if (!project.repoUrl) {
      return { error: "no repo connected to this project", code: "skipped" };
    }
    if (payload.repoUrl && payload.repoUrl !== project.repoUrl) {
      return { error: "push repo does not match connected repo", code: "rejected" };
    }
    const pushBranch = payload.branch ?? payload.ref?.replace(/^refs\/heads\//, "");
    const target = project.branch ?? "main";
    const isPreview = Boolean(pushBranch) && pushBranch !== target;
    return runDeploy(this.deps, {
      projectId,
      trigger: "git",
      source: { kind: "git", ref: pushBranch ?? target },
      commit: {
        hash: payload.commit?.hash,
        message: payload.commit?.message,
        branch: pushBranch ?? target,
      },
      previewBranch: isPreview ? pushBranch : undefined,
    });
  }

  /** Manually deploy a preview environment from any branch. Useful for
   *  testing without setting up a real git host webhook. */
  async deployPreview(
    projectId: string,
    branch: string,
    opts: { trigger?: DeployTrigger; commit?: { hash?: string; message?: string } } = {},
  ): Promise<DeployOutcome | { error: string }> {
    const trimmed = branch.trim();
    if (!trimmed) return { error: "branch is required" };
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const outcome = await runDeploy(this.deps, {
      projectId,
      trigger: opts.trigger ?? "cli",
      source: { kind: "git", ref: trimmed },
      commit: { ...opts.commit, branch: trimmed },
      previewBranch: trimmed,
    });
    await this.emitDeployEvent(projectId, outcome, opts.trigger ?? "cli");
    return outcome;
  }

  /** List a project's live preview deployments. A preview is "live" only
   *  when its own deployment row is — production lives at the slug URL,
   *  previews at slug-branch URLs, so they coexist without superseding. */
  async listPreviews(projectId: string): Promise<Deployment[]> {
    const deployments = await this.deps.store.listDeployments(projectId);
    return deployments
      .filter((d) => d.previewBranch && d.status === "live")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Tear down a preview environment. Marks the deployment superseded so
   *  the URL stops serving traffic; the row stays for audit history. */
  async destroyPreview(
    projectId: string,
    deploymentId: string,
  ): Promise<Deployment | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const deployments = await this.deps.store.listDeployments(projectId);
    const target = deployments.find((d) => d.id === deploymentId);
    if (!target) return { error: "deployment not found on this project" };
    if (!target.previewBranch) {
      return { error: "deployment is not a preview" };
    }
    if (target.status !== "live") {
      return { error: `preview is already ${target.status}` };
    }
    const updated = await this.deps.store.updateDeployment(target.id, {
      status: "superseded",
    });
    await this.recordEvent(
      project.accountId,
      "deploy",
      `Preview ${target.previewBranch} on ${project.name} destroyed`,
      `${target.url ?? target.id}`,
      projectId,
    );
    return updated;
  }

  /** Roll the project back to a previous deployment. Creates a new
   *  deployment row that points at the prior image/URL, supersedes
   *  any live deployments, and sets the project back to `live`. The
   *  plan calls this "one-click instant rollback" (plan §5.1). */
  async rollback(
    projectId: string,
    deploymentId: string,
  ): Promise<Deployment | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const all = await this.deps.store.listDeployments(projectId);
    const prior = all.find((d) => d.id === deploymentId);
    if (!prior) return { error: "deployment not found on this project" };
    if (prior.status !== "live" && prior.status !== "superseded") {
      return { error: `cannot roll back to a ${prior.status} deployment` };
    }

    // Supersede any current live deployments on the project.
    await Promise.all(
      all
        .filter((d) => d.status === "live" && d.id !== prior.id)
        .map((d) =>
          this.deps.store.updateDeployment(d.id, { status: "superseded" }),
        ),
    );

    const rolled = await this.deps.store.createDeployment({
      id: id("dpl"),
      projectId,
      status: "live",
      trigger: "cli",
      runtime: prior.runtime,
      imageRef: prior.imageRef,
      nodeId: prior.nodeId,
      url: prior.url,
      logs: [`rollback-to:${prior.id}`, "image-reused", "container-started", "routed", "verified"],
      createdAt: now(),
    });
    await this.deps.store.updateProject(projectId, { status: "live" });
    await this.recordEvent(
      project.accountId,
      "deploy",
      `${project.name} rolled back`,
      `to ${prior.id} · new deployment ${rolled.id}`,
      projectId,
    );
    return rolled;
  }

  /* ============================================================
     Backups + restore (plan §5.5).
     ============================================================ */

  /** Take a point-in-time backup of a project. Captures the live
   *  deployment id + a copy of every env var. The database snapshot id
   *  is opaque here (production wires it to a real WAL-archive); we just
   *  record the database id when one is present. */
  async createBackup(
    projectId: string,
    opts: {
      note?: string;
      trigger?: "manual" | "auto-pre-deploy";
    } = {},
  ): Promise<Backup | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const deployments = await this.deps.store.listDeployments(projectId);
    const live = deployments.find(
      (d) => d.status === "live" && !d.previewBranch,
    );
    if (!live) {
      return {
        error:
          "no live production deployment to back up — deploy the project first",
      };
    }
    const envVars = await this.deps.store.listEnvVars(projectId);
    const db = await this.deps.store.getDatabaseByProject(projectId);
    const backup = await this.deps.store.createBackup({
      id: id("bak"),
      projectId,
      accountId: project.accountId,
      deploymentId: live.id,
      envVars: envVars.map((v) => ({
        key: v.key,
        value: v.value,
        secret: v.secret,
        scope: v.scope,
      })),
      databaseSnapshotId: db?.id ?? null,
      note: opts.note,
      trigger: opts.trigger ?? "manual",
      createdAt: now(),
    });
    await this.recordEvent(
      project.accountId,
      "backup",
      `Backup ${backup.id} taken on ${project.name}`,
      `deployment ${live.id} · ${backup.envVars.length} env vars${db ? ` · db ${db.id}` : ""}`,
      projectId,
    );
    return backup;
  }

  /** List a project's backups, newest first. */
  async listBackups(projectId: string): Promise<Backup[]> {
    return this.deps.store.listBackups(projectId);
  }

  async getBackup(backupId: string): Promise<Backup | null> {
    return this.deps.store.getBackup(backupId);
  }

  /** Restore a project to a backup. This:
   *   1. Re-applies every env var from the snapshot (overwriting current
   *      values; missing-from-backup vars are left untouched — restore is
   *      additive, not destructive).
   *   2. Rolls the project back to the captured deployment (reusing
   *      `rollback`'s existing logic — image is reused, no rebuild).
   *  Returns the new live Deployment row produced by the rollback. */
  async restoreBackup(
    projectId: string,
    backupId: string,
  ): Promise<Deployment | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const backup = await this.deps.store.getBackup(backupId);
    if (!backup) return { error: "backup not found" };
    if (backup.projectId !== projectId) {
      return { error: "backup does not belong to this project" };
    }

    // 1. Re-apply env vars. Upsert one at a time so each individual key
    //    failure is isolated. The InMemory store keys env on
    //    (projectId, key, scope) — same as a production unique index.
    for (const v of backup.envVars) {
      await this.deps.store.upsertEnvVar({
        id: id("env"),
        projectId,
        key: v.key,
        value: v.value,
        secret: v.secret,
        scope: v.scope,
        updatedAt: now(),
      });
    }

    // 2. Roll back to the captured deployment. Returns the new live row.
    const rolled = await this.rollback(projectId, backup.deploymentId);
    if ("error" in rolled) {
      return {
        error: `env vars restored but deployment rollback failed: ${rolled.error}`,
      };
    }
    await this.recordEvent(
      project.accountId,
      "backup",
      `${project.name} restored from backup ${backup.id}`,
      `${backup.envVars.length} env vars + deployment ${backup.deploymentId}`,
      projectId,
    );
    return rolled;
  }

  /** Drop a backup. Idempotent — returns false if it didn't exist. */
  async deleteBackup(
    backupId: string,
  ): Promise<{ ok: true } | { error: string; code: "not_found" }> {
    const backup = await this.deps.store.getBackup(backupId);
    if (!backup) return { error: "backup not found", code: "not_found" };
    const ok = await this.deps.store.deleteBackup(backupId);
    if (!ok) return { error: "backup not found", code: "not_found" };
    await this.recordEvent(
      backup.accountId,
      "backup",
      `Backup ${backup.id} deleted`,
      `was created at ${backup.createdAt}`,
      backup.projectId,
    );
    return { ok: true };
  }

  /** Aggregate metrics across an account. Cheap to compute on the demo store
   *  (in-memory); a production deployment would back this with a metering
   *  pipeline (plan §13). */
  async getAccountMetrics(accountId: string): Promise<AccountMetrics> {
    const projects = await this.deps.store.listProjects(accountId);
    const projectIds = projects.map((p) => p.id);

    // Fan out into per-project lists. Order doesn't matter — we aggregate.
    const [allDeploys, allDomains, services, keys] = await Promise.all([
      Promise.all(projectIds.map((id) => this.deps.store.listDeployments(id))),
      Promise.all(projectIds.map((id) => this.deps.store.listDomains(id))),
      Promise.all(
        projectIds.map(async (id) => ({
          db: await this.deps.store.getDatabaseByProject(id),
          mb: await this.deps.store.getMailboxByProject(id),
          ph: await this.deps.store.getPhoneNumberByProject(id),
        })),
      ),
      this.deps.store.listApiKeys(accountId),
    ]);

    const deploys = allDeploys.flat();
    const domains = allDomains.flat();
    const projectBySlug = new Map(projects.map((p) => [p.id, p.slug]));

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const deployTriggers: Record<DeployTrigger, number> = {
      chat: 0,
      git: 0,
      cli: 0,
      mcp: 0,
      upload: 0,
    };
    let deploysLast24h = 0;
    let deploysLast7d = 0;

    const deploysPerHour = new Array<number>(24).fill(0);
    const nowMs = Date.now();
    for (const d of deploys) {
      deployTriggers[d.trigger]++;
      const t = new Date(d.createdAt).getTime();
      if (t >= sevenDaysAgo) deploysLast7d++;
      if (t >= oneDayAgo) {
        deploysLast24h++;
        const hoursAgo = Math.floor((nowMs - t) / (60 * 60 * 1000));
        const idx = 23 - Math.min(23, Math.max(0, hoursAgo));
        deploysPerHour[idx]++;
      }
    }

    const runtimes: Record<Runtime, number> = {
      static: 0,
      node: 0,
      python: 0,
      php: 0,
      go: 0,
      ruby: 0,
      docker: 0,
    };
    const regions: Record<Region, number> = { fsn1: 0, hel1: 0, ash: 0 };
    for (const p of projects) {
      runtimes[p.runtime]++;
      regions[p.region]++;
    }

    const recentDeployments = deploys
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 8)
      .map((d) => ({
        id: d.id,
        projectId: d.projectId,
        projectSlug: projectBySlug.get(d.projectId) ?? d.projectId,
        status: d.status,
        trigger: d.trigger,
        url: d.url,
        at: d.createdAt,
      }));

    return {
      at: now(),
      totals: {
        projects: projects.length,
        liveProjects: projects.filter((p) => p.status === "live").length,
        buildingProjects: projects.filter(
          (p) => p.status === "building" || p.status === "provisioning",
        ).length,
        sleepingProjects: projects.filter((p) => p.status === "sleeping").length,
        crashedProjects: projects.filter((p) => p.status === "crashed").length,
        deployments: deploys.length,
        deploysLast24h,
        deploysLast7d,
        deployTriggers,
        domains: domains.length,
        autoDeployRepos: projects.filter((p) => p.autoDeploy).length,
        services: {
          databases: services.filter((s) => s.db).length,
          mailboxes: services.filter((s) => s.mb).length,
          phoneNumbers: services.filter((s) => s.ph).length,
        },
        keys: keys.length,
      },
      series: { deploysPerHour, runtimes, regions },
      recentDeployments,
    };
  }

  /* ============================================================
     Cantila Data — object storage (plan §4.6).
     ============================================================ */

  /** Create an S3-compatible bucket on a project. Names are globally
   *  unique; sub-domains under buckets.cantila.cloud are derived from
   *  this name by the data-plane gateway. */
  async createBucket(input: {
    projectId: string;
    name: string;
    publicRead?: boolean;
    cdn?: boolean;
  }): Promise<StorageBucket | { error: string }> {
    const project = await this.deps.store.getProject(input.projectId);
    if (!project) return { error: "project not found" };
    const name = input.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!name) return { error: "bucket name required" };
    const taken = await this.deps.store.findBucketByName(name);
    if (taken) return { error: "bucket name already taken" };
    const bucket = await this.deps.store.createBucket({
      id: id("buk"),
      projectId: project.id,
      name,
      region: project.region,
      publicRead: input.publicRead ?? false,
      cdn: input.cdn ?? false,
      objects: 0,
      sizeGb: 0,
      createdAt: now(),
    });
    await this.recordEvent(
      project.accountId,
      "storage",
      `Bucket ${bucket.name} created on ${project.name}`,
      `${bucket.publicRead ? "public" : "private"}${bucket.cdn ? " · CDN" : ""}`,
      project.id,
    );
    return bucket;
  }

  /** All buckets in an account — used by the Console "Cantila Data" view. */
  async listBuckets(accountId: string): Promise<StorageBucket[]> {
    return this.deps.store.listBuckets(accountId);
  }

  async deleteBucket(id: string): Promise<boolean> {
    return this.deps.store.deleteBucket(id);
  }

  /* ----- hosted mailboxes (plan §4.4 — Cantila Mail) ----- */

  /** Create a hosted mailbox (a real inbox) on a project. Distinct from
   *  the project's auto-wired transactional `Mailbox` — see plan §4.4.
   *  Addresses are globally unique. */
  async createHostedMailbox(input: {
    projectId: string;
    address: string;
    displayName?: string;
    kind?: MailboxKind;
    quotaMb?: number;
  }): Promise<CreatedHostedMailbox | { error: string }> {
    const project = await this.deps.store.getProject(input.projectId);
    if (!project) return { error: "project not found" };
    const address = input.address.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      return { error: "a valid email address is required" };
    }
    // Platform mailboxes must live on the platform domain.
    if (project.platform && !address.endsWith("@cantila.app")) {
      return { error: "platform mailboxes must be @cantila.app" };
    }
    const taken = await this.deps.store.findHostedMailboxByAddress(address);
    if (taken) return { error: "mailbox address already taken" };

    const quotaMb = input.quotaMb ?? 10240;
    const displayName = input.displayName?.trim() || address.split("@")[0];

    // Provision a real, login-capable mailbox in the MTA ONLY for
    // platform-project (cantila.app) mailboxes. Tenant mailboxes stay
    // record-only until multi-domain provisioning ships. Provision
    // FIRST so a Mailcow failure leaves no ghost record. The generated
    // password is returned once below and never persisted.
    let oneTimePassword: string | undefined;
    if (project.platform) {
      oneTimePassword = randomBytes(18).toString("base64url");
      const dom = await mailboxProvisioner.ensureDomain("cantila.app");
      if ("error" in dom) return { error: dom.error };
      const made = await mailboxProvisioner.createMailbox({
        address,
        password: oneTimePassword,
        quotaMb,
        displayName,
      });
      if ("error" in made) return { error: made.error };
    }

    const mailbox = await this.deps.store.createHostedMailbox({
      id: id("mbx"),
      projectId: project.id,
      address,
      displayName,
      kind: input.kind ?? "personal",
      quotaMb,
      usedMb: 0,
      status: "active",
      createdAt: now(),
    });
    await this.recordEvent(
      project.accountId,
      "config",
      `Mailbox ${mailbox.address} created on ${project.name}`,
      `${mailbox.kind} · ${mailbox.quotaMb} MB quota`,
      project.id,
    );
    return { ...mailbox, oneTimePassword };
  }

  /** Hosted mailboxes on one project. */
  async listHostedMailboxes(projectId: string): Promise<HostedMailbox[]> {
    return this.deps.store.listHostedMailboxesByProject(projectId);
  }

  /** Every hosted mailbox across an account — for the account-wide view. */
  async listAccountHostedMailboxes(
    accountId: string,
  ): Promise<HostedMailbox[]> {
    return this.deps.store.listHostedMailboxes(accountId);
  }

  /** Delete a hosted mailbox. Scoped to `projectId` — returns false when
   *  the mailbox doesn't exist or belongs to a different project, so a
   *  caller authorised for one project cannot delete another's mailbox. */
  async deleteHostedMailbox(
    projectId: string,
    mailboxId: string,
  ): Promise<boolean> {
    const mailbox = await this.deps.store.getHostedMailbox(mailboxId);
    if (!mailbox || mailbox.projectId !== projectId) return false;
    const ok = await this.deps.store.deleteHostedMailbox(mailboxId);
    if (ok) {
      const project = await this.deps.store.getProject(projectId);
      if (project) {
        await this.recordEvent(
          project.accountId,
          "config",
          `Mailbox ${mailbox.address} deleted from ${project.name}`,
          `${mailbox.kind} mailbox removed`,
          project.id,
        );
      }
    }
    return ok;
  }

  /* ============================================================
     Mail aliases — routing rules (plan §4.4).

     Records the forwarding / catch-all / parse rule the future MTA
     will honor. The MTA itself is not real today (§15.2), so create /
     update / delete here are durable but no mail actually flows yet.
     ============================================================ */

  /** Validate that `address` is the right shape for `kind`. Catch-all is
   *  `*@domain`, every other kind is a normal `local@domain`. */
  private validateAliasAddress(
    address: string,
    kind: MailAliasKind,
  ): string | null {
    if (kind === "catch-all") {
      if (!/^\*@[^@\s]+\.[^@\s]+$/.test(address)) {
        return "catch-all aliases must be in the form *@yourdomain.com";
      }
    } else {
      if (!/^[^@\s*]+@[^@\s]+\.[^@\s]+$/.test(address)) {
        return "a valid email address is required";
      }
    }
    return null;
  }

  /** Create a routing rule. The alias's hostname should match the
   *  project's sending domain — we don't enforce that yet (the auto-wired
   *  mailbox isn't always materialised when the alias is being seeded), but
   *  this is the seam where that check will live once the MTA is real. */
  async createMailAlias(input: {
    projectId: string;
    address: string;
    target: string;
    kind?: MailAliasKind;
    description?: string;
  }): Promise<MailAlias | { error: string }> {
    const project = await this.deps.store.getProject(input.projectId);
    if (!project) return { error: "project not found" };
    const address = input.address.trim().toLowerCase();
    const target = input.target.trim();
    const kind = input.kind ?? "alias";
    if (!target) return { error: "target is required" };
    const addressError = this.validateAliasAddress(address, kind);
    if (addressError) return { error: addressError };
    const taken = await this.deps.store.findMailAliasByAddress(address);
    if (taken) return { error: "alias address already taken" };
    const at = now();
    const alias = await this.deps.store.createMailAlias({
      id: id("mal"),
      projectId: project.id,
      address,
      target,
      kind,
      active: true,
      description: input.description?.trim() || undefined,
      createdAt: at,
      updatedAt: at,
    });
    await this.recordEvent(
      project.accountId,
      "config",
      `Mail alias ${alias.address} created on ${project.name}`,
      `${alias.kind} → ${alias.target}`,
      project.id,
    );
    return alias;
  }

  /** Aliases on one project. */
  async listMailAliases(projectId: string): Promise<MailAlias[]> {
    return this.deps.store.listMailAliasesByProject(projectId);
  }

  /** Every alias across an account — for the account-wide Mail view. */
  async listAccountMailAliases(accountId: string): Promise<MailAlias[]> {
    return this.deps.store.listMailAliases(accountId);
  }

  /** Patch an alias — target / kind / active / description. Address is
   *  intentionally immutable (the alias's identity); to rename, delete
   *  and recreate. Scoped to `projectId` — returns `{error}` when the
   *  alias doesn't exist or belongs to a different project. */
  async updateMailAlias(
    projectId: string,
    aliasId: string,
    patch: {
      target?: string;
      kind?: MailAliasKind;
      active?: boolean;
      description?: string;
    },
  ): Promise<MailAlias | { error: string }> {
    const existing = await this.deps.store.getMailAlias(aliasId);
    if (!existing || existing.projectId !== projectId) {
      return { error: "alias not found" };
    }
    // If kind is changing, re-validate the address shape against the new kind.
    if (patch.kind && patch.kind !== existing.kind) {
      const addressError = this.validateAliasAddress(
        existing.address,
        patch.kind,
      );
      if (addressError) return { error: addressError };
    }
    const updated = await this.deps.store.updateMailAlias(aliasId, patch);
    const project = await this.deps.store.getProject(projectId);
    if (project) {
      await this.recordEvent(
        project.accountId,
        "config",
        `Mail alias ${updated.address} updated on ${project.name}`,
        `${updated.kind} → ${updated.target}${updated.active ? "" : " (paused)"}`,
        project.id,
      );
    }
    return updated;
  }

  /** Delete an alias. Scoped to `projectId` for the same cross-project
   *  safety as `deleteHostedMailbox`. */
  async deleteMailAlias(projectId: string, aliasId: string): Promise<boolean> {
    const alias = await this.deps.store.getMailAlias(aliasId);
    if (!alias || alias.projectId !== projectId) return false;
    const ok = await this.deps.store.deleteMailAlias(aliasId);
    if (ok) {
      const project = await this.deps.store.getProject(projectId);
      if (project) {
        await this.recordEvent(
          project.accountId,
          "config",
          `Mail alias ${alias.address} deleted from ${project.name}`,
          `${alias.kind} → ${alias.target}`,
          project.id,
        );
      }
    }
    return ok;
  }

  /** Account-wide mailbox fleet — every project's auto-wired mailbox plus
   *  the sending domains derived from them (one domain per unique
   *  `sendingDomain`). Powers the Console's Cantila Mail page (plan §4.4). */
  async listAccountMailboxes(
    accountId: string,
  ): Promise<{
    mailboxes: Array<
      Mailbox & { projectSlug: string; projectName: string }
    >;
    sendingDomains: Array<{
      domain: string;
      mailboxes: number;
      projects: string[];
    }>;
  }> {
    const projects = await this.deps.store.listProjects(accountId);
    const rows = await Promise.all(
      projects.map(async (p) => {
        const m = await this.deps.store.getMailboxByProject(p.id);
        if (!m) return null;
        return { ...m, smtpPassword: mask(m.smtpPassword), projectSlug: p.slug, projectName: p.name };
      }),
    );
    const mailboxes = rows.filter(
      (r): r is NonNullable<typeof r> => r !== null,
    );
    const domainAgg = new Map<string, { mailboxes: number; projects: Set<string> }>();
    for (const r of mailboxes) {
      const entry = domainAgg.get(r.sendingDomain) ?? {
        mailboxes: 0,
        projects: new Set<string>(),
      };
      entry.mailboxes++;
      entry.projects.add(r.projectSlug);
      domainAgg.set(r.sendingDomain, entry);
    }
    const sendingDomains = [...domainAgg.entries()].map(([domain, v]) => ({
      domain,
      mailboxes: v.mailboxes,
      projects: [...v.projects],
    }));
    return { mailboxes, sendingDomains };
  }

  /** Account-wide SMS fleet — every project's auto-wired phone number. */
  async listAccountPhoneNumbers(
    accountId: string,
  ): Promise<
    Array<PhoneNumber & { projectSlug: string; projectName: string }>
  > {
    const projects = await this.deps.store.listProjects(accountId);
    const rows = await Promise.all(
      projects.map(async (p) => {
        const n = await this.deps.store.getPhoneNumberByProject(p.id);
        if (!n) return null;
        return { ...n, apiKey: mask(n.apiKey), projectSlug: p.slug, projectName: p.name };
      }),
    );
    return rows.filter((r): r is NonNullable<typeof r> => r !== null);
  }

  /** Aggregate every auto-wired managed database into one list. Lets the
   *  Console "Databases" page render the fleet as cards without doing N+1
   *  per-project fetches. Secrets are masked. */
  async listAccountDatabases(
    accountId: string,
  ): Promise<
    Array<ManagedDatabase & { projectSlug: string; projectName: string }>
  > {
    const projects = await this.deps.store.listProjects(accountId);
    const dbs = await Promise.all(
      projects.map(async (p) => {
        const db = await this.deps.store.getDatabaseByProject(p.id);
        if (!db) return null;
        return {
          ...db,
          connectionUri: mask(db.connectionUri),
          projectSlug: p.slug,
          projectName: p.name,
        };
      }),
    );
    return dbs.filter((d): d is NonNullable<typeof d> => d !== null);
  }

  /* ============================================================
     Cantila Domains — the registrar product (plan §4.7).
     ============================================================ */

  /** Quote a list of TLDs for a given second-level label. The Console's
   *  "buy a domain" search uses this; the data plane will eventually pull
   *  live availability from a registrar reseller (OpenSRS / Name.com),
   *  but the prices in `TLD_CATALOG` already match the wholesale shape. */
  async searchDomains(opts: {
    label: string;
    tlds?: string[];
  }): Promise<DomainQuote[]> {
    const cleaned = opts.label
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.+$/, "")
      .replace(/[^a-z0-9-]/g, "");
    if (!cleaned) return [];

    // If the user typed `foo.com` the search collapses to that exact
    // hostname; otherwise we suggest the requested TLDs (or the full set).
    const explicitTld = cleaned.includes(".")
      ? cleaned.split(".").slice(1).join(".")
      : null;
    const root = explicitTld ? cleaned.split(".")[0] : cleaned;
    const tlds = explicitTld
      ? [explicitTld]
      : (opts.tlds && opts.tlds.length > 0
          ? opts.tlds
          : Object.keys(TLD_CATALOG)
        ).map((t) => t.replace(/^\./, "").toLowerCase());

    const results: DomainQuote[] = [];
    for (const tld of tlds) {
      const catalog = TLD_CATALOG[tld];
      if (!catalog) continue; // unknown TLD — silently skip rather than 400
      const hostname = `${root}.${tld}`;
      const existing = await this.deps.store.findRegistrationByHostname(hostname);
      results.push({
        hostname,
        tld,
        available: !existing,
        pricePerYearCents: catalog.pricePerYearCents,
        pricePerYearDisplay: formatUsd(catalog.pricePerYearCents),
      });
    }
    return results;
  }

  /** Quote a single hostname — convenience for "is this available + cost?". */
  async quoteDomain(hostname: string): Promise<DomainQuote | { error: string }> {
    const host = hostname.trim().toLowerCase();
    const parts = host.split(".");
    if (parts.length < 2) return { error: "hostname must include a TLD" };
    const tld = parts.slice(1).join(".");
    const catalog = TLD_CATALOG[tld];
    if (!catalog) return { error: `TLD .${tld} is not sold by Cantila yet` };
    const existing = await this.deps.store.findRegistrationByHostname(host);
    return {
      hostname: host,
      tld,
      available: !existing,
      pricePerYearCents: catalog.pricePerYearCents,
      pricePerYearDisplay: formatUsd(catalog.pricePerYearCents),
    };
  }

  /** Register a domain on the account. Optionally attach it to a project —
   *  in that case a matching `Domain` row is created so the deploy pipeline
   *  routes traffic to it. */
  async registerDomain(
    input: RegisterDomainInput,
  ): Promise<
    | {
        registration: DomainRegistration;
        attached?: Domain;
        invoiceCents: number;
      }
    | { error: string }
  > {
    const host = input.hostname.trim().toLowerCase();
    const parts = host.split(".");
    if (parts.length < 2) return { error: "hostname must include a TLD" };
    const tld = parts.slice(1).join(".");
    const catalog = TLD_CATALOG[tld];
    if (!catalog) return { error: `TLD .${tld} is not sold by Cantila yet` };

    const existing = await this.deps.store.findRegistrationByHostname(host);
    if (existing) return { error: "already registered" };

    const years = Math.max(1, Math.min(10, input.years ?? 1));
    const invoiceCents = catalog.pricePerYearCents * years;

    if (input.projectId) {
      const project = await this.deps.store.getProject(input.projectId);
      if (!project) return { error: "project not found" };
    }

    const now0 = now();
    const expires = new Date();
    expires.setUTCFullYear(expires.getUTCFullYear() + years);

    const registration = await this.deps.store.createRegistration({
      id: id("reg"),
      accountId: input.accountId,
      hostname: host,
      tld,
      pricePerYearCents: catalog.pricePerYearCents,
      expiresAt: expires.toISOString(),
      whoisPrivacy: input.whoisPrivacy ?? true,
      autoRenew: input.autoRenew ?? true,
      attachedProjectId: input.projectId,
      createdAt: now0,
    });

    let attached: Domain | undefined;
    if (input.projectId) {
      attached = await this.deps.store.createDomain({
        id: id("dom"),
        projectId: input.projectId,
        hostname: host,
        kind: "custom",
        // Same wildcard handling as addDomain: real custom hostnames wait
        // for DNS propagation before SSL flips.
        sslActive: false,
        primary: false,
        createdAt: now0,
      });
    }

    await this.recordEvent(
      input.accountId,
      "domain",
      `Registered ${host} via Cantila Domains`,
      `${years}yr · ${formatUsd(invoiceCents)}${attached ? ` · attached` : ""}`,
      input.projectId,
    );

    return { registration, attached, invoiceCents };
  }

  /** List the account's domain registrations. */
  async listRegistrations(accountId: string): Promise<DomainRegistration[]> {
    return this.deps.store.listRegistrations(accountId);
  }

  /** Attach a previously-registered domain to a project — useful when the
   *  user buys first, then decides which project gets it. */
  async attachRegistration(
    registrationId: string,
    projectId: string,
  ): Promise<
    { registration: DomainRegistration; attached: Domain } | { error: string }
  > {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const taken = this.deps.store.findDomainByHostname.bind(
      this.deps.store,
    );
    // Fetch the registration the simple way — list-and-find is fine at MVP scale.
    const regs = await this.deps.store.listRegistrations(project.accountId);
    const reg = regs.find((r) => r.id === registrationId);
    if (!reg) return { error: "registration not found" };
    const already = await taken(reg.hostname);
    if (already) return { error: "hostname already attached to a project" };
    const attached = await this.deps.store.createDomain({
      id: id("dom"),
      projectId,
      hostname: reg.hostname,
      kind: "custom",
      sslActive: false,
      primary: false,
      createdAt: now(),
    });
    const updated = await this.deps.store.updateRegistration(reg.id, {
      attachedProjectId: projectId,
    });
    return { registration: updated, attached };
  }

  /* ============================================================
     Team management — plan §5.5.
     ============================================================ */

  async listMembers(accountId: string): Promise<TeamMember[]> {
    return this.deps.store.listMembers(accountId);
  }

  /** Add or update a member. Idempotent on (accountId, email): re-adding
   *  the same email updates the role and display name. */
  async addMember(input: {
    accountId: string;
    email: string;
    name: string;
    role?: MemberRole;
  }): Promise<TeamMember | { error: string }> {
    const email = input.email.trim().toLowerCase();
    const name = input.name.trim();
    if (!email.includes("@")) return { error: "email is required" };
    if (!name) return { error: "name is required" };
    const member = await this.deps.store.addMember({
      accountId: input.accountId,
      email,
      name,
      role: input.role ?? "developer",
    });
    await this.recordEvent(
      input.accountId,
      "system",
      `${member.name} joined as ${member.role}`,
      member.email,
    );
    return member;
  }

  async updateMemberRole(
    accountId: string,
    membershipId: string,
    role: MemberRole,
  ): Promise<TeamMember | { error: string }> {
    try {
      const updated = await this.deps.store.updateMemberRole(membershipId, role);
      await this.recordEvent(
        accountId,
        "system",
        `${updated.name} role changed to ${role}`,
        updated.email,
      );
      return updated;
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : "could not update role",
      };
    }
  }

  async removeMember(
    accountId: string,
    membershipId: string,
  ): Promise<boolean> {
    const ok = await this.deps.store.removeMember(membershipId);
    if (ok) {
      await this.recordEvent(
        accountId,
        "system",
        `Member removed`,
        membershipId,
      );
    }
    return ok;
  }

  /* ============================================================
     Invites — per-user accept flow (plan §5.4).

     Replaces the prototype's "every new user joins the bootstrap
     account" hack. An invite is a one-time accept link tied to a
     specific account + role; accepting creates the user pinned to that
     account, adds the matching team-member row, and mints a session.
     Token shape mirrors ApiKey/Session — raw value returned once,
     persisted as SHA-256.
     ============================================================ */

  /** Default invite lifetime. Seven days is the same window the
   *  session uses — long enough for a busy team, short enough that a
   *  forgotten link doesn't sit around forever. */
  private readonly INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  /** A public-safe view of an invite — what the accept page sees from
   *  the unauthenticated `lookupInviteByToken` call. The raw token
   *  itself, the inviter's user id and per-row internals stay
   *  server-side. */
  inviteToPublic(invite: Invite, accountName: string): {
    id: string;
    email: string;
    role: MemberRole;
    accountId: string;
    accountName: string;
    status: Invite["status"];
    expiresAt: string;
  } {
    return {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      accountId: invite.accountId,
      accountName,
      status: invite.status,
      expiresAt: invite.expiresAt,
    };
  }

  /** Create a fresh invite. Returns the raw token (shown exactly once)
   *  alongside the persisted invite row — the caller is responsible for
   *  delivering the accept URL (e.g. via email when the MTA lands). */
  async createInvite(input: {
    accountId: string;
    email: string;
    role?: MemberRole;
    invitedByUserId?: string;
  }): Promise<{ invite: Invite; token: string } | { error: string }> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { error: "a valid email address is required" };
    }
    const account = await this.deps.store.getAccount(input.accountId);
    if (!account) return { error: "account not found" };
    // Idempotent on (account, email) — re-inviting the same address
    // returns the existing pending invite rather than minting a second
    // one, so a refreshed Console doesn't accumulate stale entries.
    const existing = await this.deps.store.findPendingInviteByAccountAndEmail(
      input.accountId,
      email,
    );
    if (existing) {
      // No new token can be returned for an existing invite — the raw
      // value was revealed at creation only. Surfacing the original
      // is the safe thing; the caller can revoke + re-create if they
      // truly need a fresh URL.
      return { error: "an invite for this email is already pending" };
    }
    const token = `cti_${randomBytes(24).toString("hex")}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const invite = await this.deps.store.createInvite({
      id: id("inv"),
      accountId: input.accountId,
      email,
      role: input.role ?? "developer",
      tokenHash,
      status: "pending",
      invitedByUserId: input.invitedByUserId,
      createdAt: now(),
      expiresAt: new Date(Date.now() + this.INVITE_TTL_MS).toISOString(),
    });
    await this.recordEvent(
      input.accountId,
      "system",
      `Invited ${email} as ${invite.role}`,
      invite.id,
    );
    return { invite, token };
  }

  async listInvites(accountId: string): Promise<Invite[]> {
    return this.deps.store.listInvitesByAccount(accountId);
  }

  /** Revoke a pending invite. No-op (with `error`) when the invite is
   *  not pending — accepted/revoked/expired invites are immutable. */
  async revokeInvite(
    callerAccountId: string,
    inviteId: string,
  ): Promise<Invite | { error: string }> {
    const invite = await this.deps.store.getInvite(inviteId);
    if (!invite) return { error: "invite not found" };
    if (invite.accountId !== callerAccountId) {
      return { error: "invite belongs to a different account" };
    }
    if (invite.status !== "pending") {
      return { error: `invite is already ${invite.status}` };
    }
    const updated = await this.deps.store.updateInvite(inviteId, {
      status: "revoked",
    });
    await this.recordEvent(
      callerAccountId,
      "system",
      `Revoked invite for ${invite.email}`,
      invite.id,
    );
    return updated;
  }

  /** Look up an invite by its raw token (for the unauthenticated accept
   *  page). Returns a public-safe view — never the token itself. An
   *  expired-but-still-pending row is auto-walked to `expired` so the
   *  next read reflects truth. */
  async lookupInviteByToken(rawToken: string): Promise<
    | {
        id: string;
        email: string;
        role: MemberRole;
        accountId: string;
        accountName: string;
        status: Invite["status"];
        expiresAt: string;
      }
    | { error: string }
  > {
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const invite = await this.deps.store.findInviteByTokenHash(tokenHash);
    if (!invite) return { error: "invite not found" };
    let current = invite;
    if (
      current.status === "pending" &&
      new Date(current.expiresAt).getTime() < Date.now()
    ) {
      current = await this.deps.store.updateInvite(current.id, {
        status: "expired",
      });
    }
    const account = await this.deps.store.getAccount(current.accountId);
    return this.inviteToPublic(current, account?.name ?? current.accountId);
  }

  /** Accept an invite by token. Creates the user pinned to the
   *  invite's account, adds the team-member row, marks the invite
   *  accepted, mints a session, and returns the raw session token (a
   *  Console-grade signed-in credential). The caller may supply a
   *  password (sets `passwordHash` for future email-password sign-ins);
   *  SSO callers omit it. */
  async acceptInvite(input: {
    token: string;
    name?: string;
    password?: string;
  }): Promise<
    | {
        token: string;
        expiresAt: string;
        user: { id: string; email: string; name: string };
        accountId: string;
      }
    | { error: string }
  > {
    const tokenHash = createHash("sha256")
      .update(input.token)
      .digest("hex");
    const invite = await this.deps.store.findInviteByTokenHash(tokenHash);
    if (!invite) return { error: "invite not found" };
    if (invite.status === "accepted") return { error: "invite already accepted" };
    if (invite.status === "revoked") return { error: "invite has been revoked" };
    if (
      invite.status === "expired" ||
      new Date(invite.expiresAt).getTime() < Date.now()
    ) {
      if (invite.status !== "expired") {
        await this.deps.store.updateInvite(invite.id, { status: "expired" });
      }
      return { error: "invite has expired" };
    }
    // Create/find the user and pin them to the inviting account. If the
    // email already belongs to a user with a different account, we
    // still add the membership — they can switch accounts via /v1/me.
    const passwordHash = input.password
      ? hashPassword(input.password)
      : undefined;
    const user = await this.findOrCreateUser({
      email: invite.email,
      name: input.name,
      passwordHash,
      accountId: invite.accountId,
    });
    await this.deps.store.addMember({
      accountId: invite.accountId,
      email: invite.email,
      name: user.name,
      role: invite.role,
    });
    await this.deps.store.updateInvite(invite.id, {
      status: "accepted",
      acceptedAt: now(),
      acceptedByUserId: user.id,
    });
    await this.recordEvent(
      invite.accountId,
      "system",
      `${user.email} accepted invite as ${invite.role}`,
      invite.id,
    );
    const { token, expiresAt } = await this.mintSession(user.id);
    return {
      token,
      expiresAt,
      user: { id: user.id, email: user.email, name: user.name },
      accountId: invite.accountId,
    };
  }

  /* ============================================================
     Accounts — the tenant root (plan §5.4 — multi-tenant auth).
     ============================================================ */

  /** Create an Account row. Handles are normalised lowercase and must be
   *  globally unique; the id is derived from the handle (`acc_<handle>`)
   *  so it's stable, predictable, and friendly in logs. */
  async createAccount(input: {
    name: string;
    handle: string;
    plan?: AccountPlan;
    /** Set when this account is a sub-account under a parent (plan §5.5
     *  — white-label). The parent must already exist; the cross-account
     *  ownership check lives in `createSubAccount` above this layer. */
    parentAccountId?: string;
  }): Promise<Account | { error: string }> {
    const name = input.name.trim();
    const handle = input.handle.trim().toLowerCase();
    if (!name) return { error: "name is required" };
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(handle)) {
      return {
        error:
          "handle must be 3-40 chars, lowercase letters/digits/hyphens, not starting or ending with a hyphen",
      };
    }
    const existing = await this.deps.store.findAccountByHandle(handle);
    if (existing) return { error: "handle already taken" };
    const account = await this.deps.store.createAccount({
      id: `acc_${handle}`,
      name,
      handle,
      plan: input.plan ?? "hobby",
      parentAccountId: input.parentAccountId,
      createdAt: now(),
    });
    await this.recordEvent(
      account.id,
      "system",
      `Account ${account.name} created`,
      `handle ${account.handle} · plan ${account.plan}${input.parentAccountId ? ` · sub-account of ${input.parentAccountId}` : ""}`,
    );
    return account;
  }

  /* ============================================================
     White-label / reseller — sub-accounts (plan §5.5)

     An agency-tier parent can mint sub-accounts under it. Each
     sub-account is a fully isolated tenant — its own projects,
     mailboxes, numbers, Stripe customer and admin key — with one
     extra property: the parent can act on it through
     `canActOnAccount`. A future drop adds per-sub-account custom
     branding (logo, primary colour), a custom Console domain, and a
     billing-rollup model where the parent's Stripe subscription
     covers every child. This drop establishes the hierarchy and
     scoping rule so those follow-ups are additive.
     ============================================================ */

  /** Plans that may create sub-accounts. The reseller program is
   *  agency-tier and above (`dedicated` is a custom contract that
   *  inherits everything). Hobby / Starter / Pro cannot. */
  private RESELLER_PLANS: AccountPlan[] = ["agency", "dedicated"];

  /** Provision a sub-account under `parentAccountId`. The parent must
   *  exist and be on a reseller-eligible plan. Returns the new account
   *  + its first admin key + the raw key (one-time reveal, same
   *  contract as `bootstrapAccountAndKey`). */
  async createSubAccount(input: {
    parentAccountId: string;
    name: string;
    handle: string;
    plan?: AccountPlan;
    keyName?: string;
    keyScope?: ApiKeyScope;
  }): Promise<
    { account: Account; key: ApiKey; rawKey: string } | { error: string }
  > {
    const parent = await this.deps.store.getAccount(input.parentAccountId);
    if (!parent) return { error: "parent account not found" };
    if (!this.RESELLER_PLANS.includes(parent.plan)) {
      return {
        error: `parent account plan '${parent.plan}' cannot create sub-accounts (needs ${this.RESELLER_PLANS.join(" or ")})`,
      };
    }
    if (parent.parentAccountId) {
      // Two-level only in v1 — an agency under an agency would need
      // recursive billing/scoping that isn't designed yet.
      return { error: "sub-accounts cannot themselves create sub-accounts" };
    }
    return this.bootstrapAccountAndKey({
      accountName: input.name,
      accountHandle: input.handle,
      plan: input.plan,
      parentAccountId: input.parentAccountId,
      keyName: input.keyName,
      keyScope: input.keyScope,
    });
  }

  /** Sub-accounts under a parent. Returns `[]` for a top-level account
   *  with no children. */
  async listSubAccounts(parentAccountId: string): Promise<Account[]> {
    const rows = await this.deps.store.listChildAccounts(parentAccountId);
    return rows.map((a) => maskAccount(a) as Account);
  }

  /** Cross-account assertion the auth layer uses (plan §5.5). Returns
   *  true if the caller may act on `targetAccountId` — either they ARE
   *  the target, or they are its agency parent. A future drop can widen
   *  this with team-membership / delegated-admin grants without
   *  changing call sites. */
  async canActOnAccount(
    callerAccountId: string,
    targetAccountId: string,
  ): Promise<boolean> {
    if (callerAccountId === targetAccountId) return true;
    const target = await this.deps.store.getAccount(targetAccountId);
    if (!target) return false;
    return target.parentAccountId === callerAccountId;
  }

  async getAccount(id: string): Promise<Account | null> {
    return maskAccount(await this.deps.store.getAccount(id));
  }

  async findAccountByHandle(handle: string): Promise<Account | null> {
    return maskAccount(await this.deps.store.findAccountByHandle(handle));
  }

  async listAccounts(): Promise<Account[]> {
    const rows = await this.deps.store.listAccounts();
    return rows.map((a) => maskAccount(a) as Account);
  }

  async countAccounts(): Promise<number> {
    return this.deps.store.countAccounts();
  }

  /* ============================================================
     White-label per-account branding (plan §5.5).

     Each Account row carries optional `brandPrimaryColor` /
     `brandAccentColor` / `brandLogoUrl` / `brandDisplayName`
     columns. Set them from the Console / CLI; the Console layout
     picks them up and re-skins the chrome for the active session.
     Either the account itself OR its agency parent (via
     `canActOnAccount`) can edit them — so an agency can hand a
     client account a fully white-labelled view without giving the
     client an admin login.
     ============================================================ */

  /** Patch the branding fields on an Account. The caller must either
   *  BE the target or be its agency parent — same rule as every other
   *  cross-account write. Validates colour and URL shape; an empty
   *  string clears the column. Returns the masked, updated Account
   *  or an `{error}` envelope. */
  async updateAccountBranding(input: {
    callerAccountId: string;
    targetAccountId: string;
    patch: AccountBrandingPatch;
  }): Promise<Account | { error: string }> {
    if (!(await this.canActOnAccount(input.callerAccountId, input.targetAccountId))) {
      return { error: "you cannot edit branding for that account" };
    }
    const target = await this.deps.store.getAccount(input.targetAccountId);
    if (!target) return { error: "account not found" };

    const HEX_RE = /^#[0-9a-fA-F]{6}$/;
    const URL_RE = /^https?:\/\/[^\s]{3,500}$/i;
    const sanitised: AccountBrandingPatch = {};
    if ("brandPrimaryColor" in input.patch) {
      const v = input.patch.brandPrimaryColor;
      if (v && !HEX_RE.test(v))
        return { error: "brandPrimaryColor must be a #rrggbb hex string" };
      sanitised.brandPrimaryColor = v || null;
    }
    if ("brandAccentColor" in input.patch) {
      const v = input.patch.brandAccentColor;
      if (v && !HEX_RE.test(v))
        return { error: "brandAccentColor must be a #rrggbb hex string" };
      sanitised.brandAccentColor = v || null;
    }
    if ("brandLogoUrl" in input.patch) {
      const v = input.patch.brandLogoUrl;
      if (v && !URL_RE.test(v))
        return { error: "brandLogoUrl must be an http(s) URL" };
      sanitised.brandLogoUrl = v || null;
    }
    if ("brandDisplayName" in input.patch) {
      const v = input.patch.brandDisplayName;
      if (v && v.length > 64)
        return { error: "brandDisplayName must be at most 64 characters" };
      sanitised.brandDisplayName = v || null;
    }

    // Only include keys the caller actually patched — InMemoryStore
    // spreads the patch and an `undefined` would clobber a still-set
    // field; PrismaStore reads `in patch` and would write a NULL.
    // Empty-string in the input was already mapped to `null` above
    // (the explicit-clear semantic), which goes through as a string
    // here and is null'd at the Prisma boundary.
    const dbPatch: Partial<Account> = {};
    if ("brandPrimaryColor" in sanitised)
      dbPatch.brandPrimaryColor = sanitised.brandPrimaryColor ?? undefined;
    if ("brandAccentColor" in sanitised)
      dbPatch.brandAccentColor = sanitised.brandAccentColor ?? undefined;
    if ("brandLogoUrl" in sanitised)
      dbPatch.brandLogoUrl = sanitised.brandLogoUrl ?? undefined;
    if ("brandDisplayName" in sanitised)
      dbPatch.brandDisplayName = sanitised.brandDisplayName ?? undefined;
    const updated = await this.deps.store.updateAccount(
      input.targetAccountId,
      dbPatch,
    );
    await this.recordEvent(
      input.targetAccountId,
      "config",
      `Branding updated`,
      Object.keys(sanitised).join(", "),
    );
    return maskAccount(updated) as Account;
  }

  /* ============================================================
     White-label billing-rollup (plan §5.5).

     A sub-account on rollup does NOT carry its own Stripe
     subscription — every charge that would land on its own
     subscription (number leases, plan-tier fees) is routed to the
     parent's subscription with `metadata.cantilaSubAccountId =
     <sub>` so the parent's invoice can attribute the line back to
     the right child. Enrol / leave are explicit operations on the
     parent; rolled-up subs cannot open checkout or the billing
     portal on their own (the parent does it).
     ============================================================ */

  /** Enrol a sub-account into the parent's billing-rollup. Caller
   *  must be the parent. The parent must have an active Stripe
   *  subscription (otherwise there is no bill to roll up onto), and
   *  the sub MUST NOT already carry its own subscription (otherwise
   *  it would be billed twice). The sub's `billedToAccountId` is set;
   *  future `startNumberStripeBilling` calls route to the parent's
   *  subscription automatically. Records an activity event on BOTH
   *  the sub (target of the rollup) and the parent (now paying). */
  async enrollInBillingRollup(input: {
    callerAccountId: string;
    targetAccountId: string;
  }): Promise<Account | { error: string }> {
    if (input.callerAccountId === input.targetAccountId) {
      return { error: "you cannot roll your own account onto itself" };
    }
    const sub = await this.deps.store.getAccount(input.targetAccountId);
    if (!sub) return { error: "sub-account not found" };
    if (sub.parentAccountId !== input.callerAccountId) {
      return { error: "you are not the parent of this sub-account" };
    }
    const parent = await this.deps.store.getAccount(input.callerAccountId);
    if (!parent) return { error: "parent account not found" };
    if (!parent.stripeSubscriptionId) {
      return {
        error:
          "parent has no active Stripe subscription — open checkout on the parent first, then roll children up",
      };
    }
    if (sub.stripeSubscriptionId) {
      return {
        error:
          "sub-account already has its own Stripe subscription — cancel it via the billing portal before rolling up",
      };
    }
    if (sub.billedToAccountId === input.callerAccountId) {
      // Idempotent — already enrolled.
      return maskAccount(sub) as Account;
    }
    const updated = await this.deps.store.updateAccount(input.targetAccountId, {
      billedToAccountId: input.callerAccountId,
    });
    await this.recordEvent(
      input.targetAccountId,
      "system",
      `Enrolled into billing-rollup`,
      `paid via parent ${input.callerAccountId}`,
    );
    await this.recordEvent(
      input.callerAccountId,
      "system",
      `Sub-account ${sub.handle} added to billing-rollup`,
      `future charges on ${sub.id} land on this account's Stripe subscription`,
    );
    return maskAccount(updated) as Account;
  }

  /** Remove a sub-account from the parent's billing-rollup. Caller
   *  must be the parent. After this returns, the sub is responsible
   *  for opening its own Stripe checkout — until it does, new
   *  billing items are deferred (existing items on the parent's
   *  subscription stay there until the next billing cycle ends, per
   *  Stripe's normal proration). Records on both sides. */
  async leaveBillingRollup(input: {
    callerAccountId: string;
    targetAccountId: string;
  }): Promise<Account | { error: string }> {
    const sub = await this.deps.store.getAccount(input.targetAccountId);
    if (!sub) return { error: "sub-account not found" };
    if (sub.parentAccountId !== input.callerAccountId) {
      return { error: "you are not the parent of this sub-account" };
    }
    if (!sub.billedToAccountId) {
      // Idempotent — not in rollup.
      return maskAccount(sub) as Account;
    }
    const updated = await this.deps.store.updateAccount(input.targetAccountId, {
      billedToAccountId: undefined,
    });
    await this.recordEvent(
      input.targetAccountId,
      "system",
      `Removed from billing-rollup`,
      "open checkout on this account to start paying its own bill",
    );
    await this.recordEvent(
      input.callerAccountId,
      "system",
      `Sub-account ${sub.handle} removed from billing-rollup`,
      "future charges defer until that sub opens its own Stripe subscription",
    );
    return maskAccount(updated) as Account;
  }

  /** Mint a scoped API key for an existing account. The raw key is returned
   *  exactly once and only its SHA-256 hash is persisted (plan §5.4).
   *  Refuses to mint against an unknown account — `bootstrapAccountAndKey`
   *  is the only path that may create the account simultaneously. */
  async createApiKey(opts: {
    accountId: string;
    name: string;
    scope?: ApiKeyScope;
  }): Promise<CreatedApiKey | { error: string }> {
    const account = await this.deps.store.getAccount(opts.accountId);
    if (!account) return { error: "account not found" };
    return this.mintKey(opts.accountId, opts.name, opts.scope ?? "deploy");
  }

  /** Atomically provision an Account row + its first admin API key. Used
   *  in two places:
   *   - The HTTP bootstrap window (very first POST /v1/api-keys on a fresh
   *     control plane), which provisions the operator's own tenant.
   *   - The admin `POST /v1/accounts` endpoint, which lets an existing
   *     operator onboard a new tenant.
   *
   *  Returning the raw key here is the only way the caller will ever see
   *  it — the same one-time-reveal contract as createApiKey. */
  async bootstrapAccountAndKey(input: {
    accountName: string;
    accountHandle: string;
    plan?: AccountPlan;
    keyName?: string;
    keyScope?: ApiKeyScope;
    /** When the new account is a sub-account under an agency / reseller
     *  parent (plan §5.5). Threaded through from `createSubAccount`;
     *  unused on the operator bootstrap path. */
    parentAccountId?: string;
  }): Promise<
    { account: Account; key: ApiKey; rawKey: string } | { error: string }
  > {
    const account = await this.createAccount({
      name: input.accountName,
      handle: input.accountHandle,
      plan: input.plan,
      parentAccountId: input.parentAccountId,
    });
    if ("error" in account) return account;
    // Best-effort: mint a Stripe customer on bootstrap so the new tenant
    // can be upgraded later without a back-fill round trip. A Stripe
    // failure must not block tenant creation — the customer can be
    // lazy-created on first checkout via `ensureStripeCustomer`.
    let withStripe = account;
    try {
      const customer = await this.deps.stripe.createCustomer({
        name: account.name,
        metadata: { accountId: account.id, handle: account.handle },
      });
      withStripe = await this.deps.store.updateAccount(account.id, {
        stripeCustomerId: customer.id,
      });
      await this.recordEvent(
        account.id,
        "system",
        `Stripe customer created (${this.deps.stripe.label})`,
        `customer ${customer.id}`,
      );
    } catch (err) {
      await this.recordEvent(
        account.id,
        "system",
        `Stripe customer creation failed`,
        err instanceof Error ? err.message : String(err),
      );
    }
    const minted = await this.mintKey(
      withStripe.id,
      input.keyName ?? "bootstrap-admin",
      input.keyScope ?? "admin",
    );
    return { account: withStripe, key: minted.key, rawKey: minted.rawKey };
  }

  /* ----- Stripe rail (plan §8 / §15.1) ----- */

  /** Idempotent — returns the existing Stripe customer id when one is
   *  already wired, otherwise creates one and persists. Used by the
   *  checkout endpoint to handle older accounts whose bootstrap predated
   *  the Stripe rail. */
  async ensureStripeCustomer(accountId: string): Promise<string | { error: string }> {
    const account = await this.deps.store.getAccount(accountId);
    if (!account) return { error: "account not found" };
    if (account.stripeCustomerId) return account.stripeCustomerId;
    const customer = await this.deps.stripe.createCustomer({
      name: account.name,
      metadata: { accountId: account.id, handle: account.handle },
    });
    await this.deps.store.updateAccount(accountId, {
      stripeCustomerId: customer.id,
    });
    await this.recordEvent(
      accountId,
      "system",
      `Stripe customer back-filled (${this.deps.stripe.label})`,
      `customer ${customer.id}`,
    );
    return customer.id;
  }

  /** Create a checkout session for upgrading an account to `tier`.
   *  `uiMode` (default `hosted`) picks the surface — `hosted` returns a
   *  redirect `url`, `embedded` returns a `clientSecret` the Console
   *  mounts in-page (plan §8.5 — Phase D).
   *
   *  Plan §5.5 — white-label billing-rollup: a rolled-up sub-account
   *  cannot open its own checkout (the parent pays). The agency parent
   *  can run checkout on its OWN account through X-Cantila-Act-As as
   *  needed; the sub-account's own checkout is rejected with an error
   *  that explains the rollup. */
  async createCheckoutSession(input: {
    accountId: string;
    tier: StripePriceTier;
    uiMode?: "hosted" | "embedded";
    successUrl?: string;
    cancelUrl?: string;
    returnUrl?: string;
  }): Promise<
    | {
        id: string;
        uiMode: "hosted" | "embedded";
        url: string;
        clientSecret?: string;
        tier: StripePriceTier;
      }
    | { error: string }
  > {
    const target = await this.deps.store.getAccount(input.accountId);
    if (!target) return { error: "account not found" };
    if (target.billedToAccountId) {
      return {
        error: `account is billed via parent ${target.billedToAccountId} — checkout is disabled. Leave the rollup first or open checkout on the parent.`,
      };
    }
    const customerId = await this.ensureStripeCustomer(input.accountId);
    if (typeof customerId !== "string") return customerId;
    const session = await this.deps.stripe.createCheckoutSession({
      customerId,
      tier: input.tier,
      uiMode: input.uiMode,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      returnUrl: input.returnUrl,
    });
    await this.recordEvent(
      input.accountId,
      "system",
      `Checkout session created — ${input.tier} (${session.uiMode})`,
      `${session.id} · ${this.deps.stripe.label}`,
    );
    return {
      id: session.id,
      uiMode: session.uiMode,
      url: session.url,
      clientSecret: session.clientSecret,
      tier: session.tier,
    };
  }

  /** Create a Stripe billing-portal session for an account so the
   *  customer can manage their payment method, plan and invoices.
   *  Returns `{url}` for the Console/CLI to redirect to.
   *
   *  Plan §5.5 — billing-rollup: a rolled-up sub-account cannot open
   *  its own portal (the parent owns the payment method). The parent
   *  can act on its own portal to manage the rolled-up children. */
  async createBillingPortalSession(input: {
    accountId: string;
    returnUrl: string;
  }): Promise<{ id: string; url: string } | { error: string }> {
    const target = await this.deps.store.getAccount(input.accountId);
    if (!target) return { error: "account not found" };
    if (target.billedToAccountId) {
      return {
        error: `account is billed via parent ${target.billedToAccountId} — billing portal is the parent's responsibility`,
      };
    }
    const customerId = await this.ensureStripeCustomer(input.accountId);
    if (typeof customerId !== "string") return customerId;
    const session = await this.deps.stripe.createBillingPortalSession({
      customerId,
      returnUrl: input.returnUrl,
    });
    await this.recordEvent(
      input.accountId,
      "system",
      "Billing portal session created",
      `${session.id} · ${this.deps.stripe.label}`,
    );
    return { id: session.id, url: session.url };
  }

  /** Real Stripe invoice history for an account (plan §8.5 — Phase B).
   *  Resolves the account's Stripe customer and lists its invoices via
   *  the adapter (`stripe.invoices.list` live; deterministic synthetic
   *  history on the stub). Returns `[]` when the account has no Stripe
   *  customer yet — a brand-new account that has never checked out
   *  simply has no invoices — and `[]` (best-effort) on a Stripe error,
   *  so a transient failure degrades to an empty list rather than
   *  breaking the Billing page. */
  async listBillingInvoices(
    accountId: string,
    opts: { limit?: number } = {},
  ): Promise<StripeInvoice[]> {
    const account = await this.deps.store.getAccount(accountId);
    if (!account?.stripeCustomerId) return [];
    try {
      return await this.deps.stripe.listInvoices({
        customerId: account.stripeCustomerId,
        limit: opts.limit,
      });
    } catch {
      return [];
    }
  }

  /* ----- mid-period proration (plan §8 / §15.2 — plan changes) ----- */

  /** Shared setup for the preview + commit paths: load the account,
   *  confirm it has a subscription to reprice, resolve the from-tier and
   *  prices, and build the `ProrationInput`. Returns `{error}` on any
   *  case where a mid-period proration doesn't apply. */
  private async prepareProration(
    accountId: string,
    toTier: StripePriceTier,
  ): Promise<
    | { account: Account; fromTier: StripePriceTier; input: ProrationInput }
    | { error: string }
  > {
    const account = await this.deps.store.getAccount(accountId);
    if (!account) return { error: "account not found" };
    if (!account.stripeSubscriptionId) {
      return {
        error:
          "no active subscription to reprice — start one with checkout first",
      };
    }
    const fromTier = tierOf(account.plan);
    if (!fromTier) {
      return {
        error: `the ${account.plan} plan is sales-led — contact us to change it`,
      };
    }
    if (fromTier === toTier) {
      return { error: `account is already on the ${toTier} plan` };
    }
    const period = currentBillingPeriod();
    return {
      account,
      fromTier,
      input: {
        subscriptionId: account.stripeSubscriptionId,
        fromTier,
        toTier,
        fromPriceCents: priceCentsOf(fromTier),
        toPriceCents: priceCentsOf(toTier),
        periodStart: period.start,
        periodEnd: period.end,
        now: new Date().toISOString(),
      },
    };
  }

  /** Preview the proration for moving the account to `toTier` mid-period
   *  — what it will cost (or credit) right now, without committing. */
  async previewPlanChange(input: {
    accountId: string;
    toTier: StripePriceTier;
  }): Promise<ProrationPreview | { error: string }> {
    const prep = await this.prepareProration(input.accountId, input.toTier);
    if ("error" in prep) return prep;
    return this.deps.stripe.previewProration(prep.input);
  }

  /** Commit a mid-period plan change. Calls the Stripe adapter with the
   *  chosen proration behavior, then moves the Account onto the new tier
   *  and records an activity event. `prorationBehavior` defaults to
   *  `create_prorations` (Stripe's own default — the proration rolls
   *  onto the next invoice rather than charging immediately). */
  async changePlan(input: {
    accountId: string;
    toTier: StripePriceTier;
    prorationBehavior?: ProrationBehavior;
  }): Promise<
    (PlanChangeResult & { preview: ProrationPreview }) | { error: string }
  > {
    const prep = await this.prepareProration(input.accountId, input.toTier);
    if ("error" in prep) return prep;
    const behavior = input.prorationBehavior ?? "create_prorations";
    const preview = await this.deps.stripe.previewProration(prep.input);
    const result = await this.deps.stripe.changeSubscriptionPlan({
      ...prep.input,
      prorationBehavior: behavior,
    });
    // Move the account onto the new tier now. For the real adapter the
    // `customer.subscription.updated` webhook also does this — setting it
    // here keeps the stub flow correct and makes the change immediate.
    await this.deps.store.updateAccount(input.accountId, {
      plan: input.toTier,
    });
    const net = result.amountDueCents;
    const settle =
      net >= 0
        ? `charge $${(net / 100).toFixed(2)}`
        : `credit $${(-net / 100).toFixed(2)}`;
    await this.recordEvent(
      input.accountId,
      "system",
      `Plan changed: ${prep.fromTier} → ${input.toTier}`,
      `${settle} · ${behavior} · ${this.deps.stripe.label}`,
    );
    return { ...result, preview };
  }

  /** Recently-processed Stripe webhook `event.id`s. Stripe retries
   *  deliveries and can deliver out of order, so a redelivered event must
   *  be a no-op (plan §8.5.2). Bounded, in-memory: a process restart
   *  resets it — safe, because each dispatch branch is independently
   *  idempotent (setting plan / subscription id, and the dunning
   *  transitions, are no-ops when the account is already in the target
   *  state); the set just spares the redundant work and the duplicate
   *  activity-feed rows within a process lifetime. */
  private readonly seenWebhookEvents = new Set<string>();

  /** Receive a Stripe webhook. The raw body and signature header are
   *  passed through to the adapter's `parseWebhook` — which validates
   *  HMAC-SHA256 against the webhook secret and parses the event. We
   *  then dispatch on `event.type` and update the owning Account.
   *  Idempotent: a duplicate `event.id` is acknowledged (200) without
   *  re-dispatching (plan §8.5.2). */
  async handleStripeWebhook(input: {
    rawBody: string;
    signature: string | undefined;
  }): Promise<
    | { ok: true; type: string; deduped?: boolean }
    | { error: string; code: number }
  > {
    let event: StripeEvent;
    try {
      event = this.deps.stripe.parseWebhook(input.rawBody, input.signature);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "invalid webhook",
        code: 400,
      };
    }
    // Idempotency — Stripe retries and can redeliver out of order. A
    // duplicate event id is acknowledged without re-dispatching.
    if (event.id && this.seenWebhookEvents.has(event.id)) {
      return { ok: true, type: event.type, deduped: true };
    }
    const customerId =
      event.data.object.customer ?? event.data.object.id;
    if (!customerId) {
      return { error: "webhook payload has no customer reference", code: 400 };
    }
    const account = await this.deps.store.findAccountByStripeCustomer(
      customerId,
    );
    if (!account) {
      // We've never seen this customer — log and 200 so Stripe doesn't
      // keep retrying. Still remember the event id so a redelivery is a
      // fast no-op.
      this.rememberWebhookEvent(event.id);
      return { ok: true, type: event.type };
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const tier = event.data.object.tier ?? "starter";
        await this.deps.store.updateAccount(account.id, {
          plan: tier as AccountPlan,
          stripeSubscriptionId: event.data.object.subscription,
        });
        await this.recordEvent(
          account.id,
          "system",
          `Upgraded to ${tier} (Stripe)`,
          `session ${event.data.object.id}`,
        );
        break;
      }
      case "customer.subscription.updated": {
        const tier = event.data.object.items?.[0]?.tier;
        if (tier) {
          await this.deps.store.updateAccount(account.id, {
            plan: tier as AccountPlan,
            stripeSubscriptionId: event.data.object.id,
          });
          await this.recordEvent(
            account.id,
            "system",
            `Subscription updated → ${tier}`,
            `subscription ${event.data.object.id}`,
          );
        }
        break;
      }
      case "customer.subscription.deleted": {
        await this.deps.store.updateAccount(account.id, {
          plan: "hobby",
          stripeSubscriptionId: undefined,
        });
        await this.recordEvent(
          account.id,
          "system",
          `Subscription cancelled — reverted to hobby`,
          `subscription ${event.data.object.id}`,
        );
        // If the account was already in dunning, Stripe deleting the
        // subscription means it gave up retrying — that's a non-payment
        // cancellation. A healthy account is a voluntary downgrade and
        // the dunning machine returns a no-op.
        await this.applyDunningTransition(
          account,
          onSubscriptionDeleted(account),
        );
        break;
      }
      case "invoice.paid": {
        const cents = event.data.object.amount_paid ?? 0;
        await this.recordEvent(
          account.id,
          "system",
          `Invoice paid — $${(cents / 100).toFixed(2)}`,
          `invoice ${event.data.object.id}`,
        );
        // Recovery — if the account was past_due / suspended, this clears
        // dunning and restores it. A no-op for an already-healthy account.
        await this.applyDunningTransition(account, onPaymentSucceeded(account));
        break;
      }
      case "invoice.payment_failed": {
        // Drive the dunning state machine — it opens / escalates the
        // dunning cycle and emits the right activity events + emails.
        await this.applyDunningTransition(
          account,
          onPaymentFailed(account, new Date()),
        );
        break;
      }
    }
    this.rememberWebhookEvent(event.id);
    return { ok: true, type: event.type };
  }

  /** Record a processed webhook `event.id`, evicting the oldest entry
   *  once the bounded set is full (`Set` preserves insertion order). */
  private rememberWebhookEvent(eventId: string): void {
    if (!eventId) return;
    this.seenWebhookEvents.add(eventId);
    if (this.seenWebhookEvents.size > 500) {
      const oldest = this.seenWebhookEvents.values().next().value;
      if (oldest !== undefined) this.seenWebhookEvents.delete(oldest);
    }
  }

  /* ----- dunning (plan §8 / §15.2 — failed-payment handling) -----
   *
   *  The escalation logic lives in the pure `src/billing/dunning.ts`
   *  state machine; everything below is the control plane applying its
   *  output — persisting the patch, recording activity events, and
   *  rendering dunning emails into a ring. */

  /** Apply one dunning transition: persist its patch, then run its
   *  effects (activity events + dunning emails). A no-op transition
   *  (empty patch, no effects) returns immediately. */
  private async applyDunningTransition(
    account: Account,
    transition: DunningTransition,
  ): Promise<void> {
    if (
      Object.keys(transition.patch).length === 0 &&
      transition.effects.length === 0
    ) {
      return;
    }
    if (Object.keys(transition.patch).length > 0) {
      await this.deps.store.updateAccount(account.id, transition.patch);
    }
    for (const effect of transition.effects) {
      if (effect.kind === "activity") {
        await this.recordEvent(
          account.id,
          "system",
          effect.title,
          effect.detail,
        );
      } else {
        // effect.kind === "email" — render into the notice ring. Actual
        // delivery to the owner's inbox waits on the platform MTA.
        this.dunningNotices.push({
          accountId: account.id,
          template: effect.template,
          subject: effect.subject,
          body: effect.body,
          at: now(),
        });
        if (this.dunningNotices.length > DUNNING_NOTICE_BUFFER) {
          this.dunningNotices = this.dunningNotices.slice(
            -DUNNING_NOTICE_BUFFER,
          );
        }
      }
    }
  }

  /** Billing-health readout for one account — what the Console banner,
   *  the CLI and the dunning route render. */
  async getDunningStatus(accountId: string): Promise<{
    accountId: string;
    billingStatus: AccountBillingStatus;
    dunningAttempts: number;
    failedAt: string | null;
    graceEndsAt: string | null;
    deployBlocked: boolean;
    policy: { maxAttempts: number; graceDays: number };
    notices: DunningNotice[];
  }> {
    const account = await this.deps.store.getAccount(accountId);
    const status: AccountBillingStatus = account
      ? normaliseStatus(account)
      : "active";
    const inDunning = status === "past_due" || status === "suspended";
    return {
      accountId,
      billingStatus: status,
      // Attempts / clocks are only meaningful mid-cycle — zero them out
      // on a healthy account so the surfaces don't show stale values.
      dunningAttempts: inDunning ? account?.dunningAttempts ?? 0 : 0,
      failedAt: inDunning ? account?.dunningFailedAt ?? null : null,
      graceEndsAt:
        status === "past_due" ? account?.dunningGraceEndsAt ?? null : null,
      deployBlocked: account ? isDeployBlocked(account) : false,
      policy: {
        maxAttempts: DUNNING_POLICY.maxAttempts,
        graceDays: DUNNING_GRACE_DAYS,
      },
      notices: this.dunningNotices
        .filter((n) => n.accountId === accountId)
        .slice(-20)
        .reverse(),
    };
  }

  /** Sweep every account in `past_due` and escalate any whose grace
   *  window has elapsed to `suspended`. Run on a timer by
   *  `startBackgroundJobs` and on demand by `POST /v1/billing/dunning/sweep`.
   *  Returns the number of accounts suspended this pass. */
  async runDunningSweep(): Promise<{ checked: number; suspended: number }> {
    const now = new Date();
    let checked = 0;
    let suspended = 0;
    try {
      const accounts = await this.deps.store.listAccounts();
      for (const account of accounts) {
        if (normaliseStatus(account) !== "past_due") continue;
        checked += 1;
        const transition = onGraceExpiry(account, now);
        if (transition.statusChanged) {
          await this.applyDunningTransition(account, transition);
          suspended += 1;
        }
      }
    } catch {
      // Best-effort — a store hiccup must never wedge the sweep timer.
    }
    return { checked, suspended };
  }

  /** Gate a deploy on billing health. Returns an error envelope when the
   *  owning account is suspended / canceled for non-payment — the HTTP
   *  layer renders it as a 402. Healthy and legacy accounts pass. */
  async assertDeployAllowed(
    projectId: string,
  ): Promise<{ ok: true } | { ok: false; error: string; code: number }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { ok: true }; // not our call to 404 here
    const account = await this.deps.store.getAccount(project.accountId);
    if (account && isDeployBlocked(account)) {
      return {
        ok: false,
        code: 402,
        error:
          normaliseStatus(account) === "canceled"
            ? "account canceled for non-payment — reactivate billing to deploy"
            : "account suspended for non-payment — update billing to resume deploys",
      };
    }
    return { ok: true };
  }

  /** Dev/test seam — drive the dunning machine without a Stripe webhook.
   *  Wired to `POST /v1/billing/_test/payment-event` (404 in production). */
  async _simulateDunningEvent(
    accountId: string,
    kind: "failed" | "succeeded" | "grace-expiry",
  ): Promise<{ ok: true; billingStatus: AccountBillingStatus } | { error: string }> {
    const account = await this.deps.store.getAccount(accountId);
    if (!account) return { error: "account not found" };
    const transition =
      kind === "failed"
        ? onPaymentFailed(account, new Date())
        : kind === "succeeded"
          ? onPaymentSucceeded(account)
          : onGraceExpiry(account, new Date());
    await this.applyDunningTransition(account, transition);
    const after = await this.deps.store.getAccount(accountId);
    return { ok: true, billingStatus: after ? normaliseStatus(after) : "active" };
  }

  /** Internal — assumes the account already exists. */
  private async mintKey(
    accountId: string,
    name: string,
    scope: ApiKeyScope,
  ): Promise<CreatedApiKey> {
    const rawKey = mintRawKey();
    const key: ApiKey = {
      id: id("key"),
      accountId,
      name,
      scope,
      prefix: rawKey.slice(0, 12),
      hash: sha256(rawKey),
      createdAt: now(),
    };
    const stored = await this.deps.store.createApiKey(key);
    await this.recordEvent(
      stored.accountId,
      "key",
      `API key "${stored.name}" minted`,
      `scope ${stored.scope} · prefix ${stored.prefix}`,
    );
    return { key: stored, rawKey };
  }

  async listApiKeys(accountId: string): Promise<ApiKey[]> {
    return this.deps.store.listApiKeys(accountId);
  }

  /** Total keys minted across every account — backs the auth bootstrap
   *  window. The first POST /v1/api-keys is allowed unauthenticated only
   *  when this returns zero. */
  async countApiKeys(): Promise<number> {
    return this.deps.store.countApiKeys();
  }

  /** Revoke a key. When `accountId` is provided, ownership is enforced —
   *  a non-admin holding a key for account A cannot drop a key in account B.
   *  The accountId scoping is what makes the multi-tenant story safe. */
  async revokeApiKey(
    keyId: string,
    accountId?: string,
  ): Promise<{ ok: true } | { error: string; code: "not_found" | "forbidden" }> {
    const found = await this.deps.store.findApiKeyById(keyId);
    if (!found) return { error: "key not found", code: "not_found" };
    if (accountId && found.accountId !== accountId) {
      return {
        error: "key belongs to a different account",
        code: "forbidden",
      };
    }
    const ok = await this.deps.store.deleteApiKey(keyId);
    if (!ok) return { error: "key not found", code: "not_found" };
    await this.recordEvent(
      found.accountId,
      "key",
      `API key "${found.name}" revoked`,
      `${found.prefix}…`,
    );
    return { ok: true };
  }

  /** Validate a Bearer token. Returns the owning ApiKey when valid (touches
   *  lastUsedAt as a side effect) or null when not. */
  async authenticate(authHeader: string | undefined): Promise<ApiKey | null> {
    if (!authHeader) return null;
    const m = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (!m) return null;
    const found = await this.deps.store.findApiKeyByHash(sha256(m[1]));
    if (!found) return null;
    await this.deps.store.touchApiKey(found.id, now());
    return found;
  }

  /** Provision the project's bundled managed database if it has not been
   *  created yet, or report the existing one. Idempotent. The provisioner
   *  currently always creates Postgres; `engine` is recorded for the day
   *  per-project engine selection lands. */
  async provisionDb(
    projectId: string,
    _engine: DbEngine = "postgres",
  ): Promise<ManagedDatabase | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const existing = await this.deps.store.getDatabaseByProject(projectId);
    if (existing) return maskDatabase(existing) as ManagedDatabase;
    const d = await this.deps.provisioner.createDatabase(project);
    const created = await this.deps.store.createDatabase({
      id: id("db"),
      projectId,
      engine: d.engine,
      version: d.version,
      region: project.region,
      status: "active",
      connectionUri: d.connectionUri,
      createdAt: now(),
    });
    await this.deps.store.upsertEnvVar({
      id: id("env"),
      projectId,
      key: "DATABASE_URL",
      value: created.connectionUri,
      secret: true,
      scope: "all",
      updatedAt: now(),
    });
    await this.recordEvent(
      project.accountId,
      "database",
      `${created.engine} database provisioned on ${project.name}`,
      `${created.engine} ${created.version} · ${created.region}`,
      projectId,
    );
    return maskDatabase(created) as ManagedDatabase;
  }

  /** Delete a project: tear down its Coolify app + managed database
   *  (best-effort on both), then remove the project and every FK-related
   *  row. Returns `{ ok, slug }` or `{ error }`. */
  async deleteProject(
    projectId: string,
  ): Promise<{ ok: true; slug: string } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };

    // Tear down the running app on the data plane (DELETE the Coolify
    // Application). Best-effort — a stale or already-gone app must not
    // block removing the Cantila project.
    if (this.deps.dataPlane.destroyApp) {
      try {
        await this.deps.dataPlane.destroyApp(project);
      } catch {
        /* swallow — the project row is removed regardless */
      }
    }

    // Tear down the managed database (DELETE the Coolify Postgres).
    const db = await this.deps.store.getDatabaseByProject(projectId);
    if (db && this.deps.provisioner.destroyDatabase) {
      try {
        await this.deps.provisioner.destroyDatabase(db.connectionUri);
      } catch {
        /* swallow */
      }
    }

    // Tear down the real hosted mailboxes in the MTA (best-effort). The
    // record cascade below removes the rows regardless; this releases the
    // actual Mailcow mailboxes so deleting a project leaves no live inbox.
    const mailboxes =
      await this.deps.store.listHostedMailboxesByProject(projectId);
    for (const mb of mailboxes) {
      try {
        await mailboxProvisioner.deleteMailbox(mb.address);
      } catch {
        /* swallow — a stale/already-gone mailbox must not block removal */
      }
    }

    // Release the project's carrier number + stop its billing (best-effort).
    // deactivateSms releases the lease, stops Stripe billing, and strips the
    // SMS env; it is a no-op when the project has no number. Swallow failures
    // so a stuck number never blocks project removal.
    try {
      await this.deactivateSms(project.accountId, projectId);
    } catch {
      /* swallow */
    }

    const removed = await this.deps.store.deleteProject(projectId);
    if (!removed) return { error: "project not found" };

    await this.recordEvent(
      project.accountId,
      "system",
      `Project ${project.name} deleted`,
      `${project.slug} · ${project.region}`,
      projectId,
    );
    return { ok: true, slug: project.slug };
  }

  /** Delete a project's managed database: tear down the Coolify Postgres
   *  (best-effort), remove the database row, and strip the injected
   *  DATABASE_URL so a later re-provision starts clean. */
  async deleteProjectDatabase(
    projectId: string,
  ): Promise<{ ok: true } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const db = await this.deps.store.getDatabaseByProject(projectId);
    if (!db) return { error: "no database on this project" };

    if (this.deps.provisioner.destroyDatabase) {
      try {
        await this.deps.provisioner.destroyDatabase(db.connectionUri);
      } catch {
        /* swallow */
      }
    }
    await this.deps.store.deleteDatabase(projectId);
    await this.deps.store.deleteEnvVar(projectId, "DATABASE_URL");

    await this.recordEvent(
      project.accountId,
      "database",
      `Database deleted on ${project.name}`,
      `${db.engine} · ${db.region}`,
      projectId,
    );
    return { ok: true };
  }
}
