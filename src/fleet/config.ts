/* Fleet engine configuration + safety caps. Env-overridable; sane defaults. */

export type FleetAuthSource = "subscription" | "api-key" | "none";

export interface FleetConfig {
  /** True when any real Anthropic credential is configured. */
  live: boolean;
  /** Which credential powers the fleet. "subscription" = CLAUDE_CODE_OAUTH_TOKEN /
   *  ANTHROPIC_AUTH_TOKEN (claude.ai subscription); "api-key" = ANTHROPIC_API_KEY;
   *  "none" = offline / no credential. Subscription is preferred over api-key when
   *  both are set. See §26 + docs/fleet-subscription-auth.md. */
  authSource: FleetAuthSource;
  /** Max build→review→fix rounds before the loop stops. */
  maxRounds: number;
  /** Max tool-use turns a single agent may take. */
  maxAgentSteps: number;
  /** Max agents running at once within a batch. */
  maxConcurrency: number;
  /** Soft cap on total output tokens spent in one build. */
  buildTokenBudget: number;
  /** Max USD spend allowed across a fleet run. */
  maxBudgetUsd: number;
  /** Max number of builds running concurrently at the fleet level. */
  maxConcurrentBuilds: number;
  /** When true, passing builds are automatically deployed to production. */
  autodeploy: boolean;
  /** Model the orchestrator (main session) runs on. Env-overridable so the
   *  flagship cost driver can be tuned without a code deploy. Default "opus"
   *  preserves prior behaviour. */
  orchestratorModel: string;
  /** When set, overrides EVERY roster subagent's model (e.g. force all to
   *  "sonnet" for cheaper chat builds). Empty string = keep per-role models. */
  subagentModel: string;
  /** Pre-deploy smoke-test backend: "noop" (default, disabled) or "docker". */
  sandbox: string;
  /** Max time a sandbox smoke test may run before it's judged failed. */
  sandboxTimeoutMs: number;
}

function num(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function str(envKey: string, fallback: string): string {
  const raw = process.env[envKey];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function resolveAuthSource(): FleetAuthSource {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN) return "subscription";
  if (process.env.ANTHROPIC_API_KEY) return "api-key";
  return "none";
}

/** Build the subprocess env for a fleet run, optionally injecting a
 *  per-tenant claude.ai subscription token. When a tenant token is
 *  provided it replaces platform-level Anthropic credentials so the
 *  SDK subprocess uses the TENANT's subscription quota, not Cantila's.
 *
 *  The SDK's `options.env` REPLACES the subprocess env entirely, so
 *  we spread process.env first to preserve PATH, HOME, etc. */
export function resolveFleetEnv(
  tenantToken?: string,
): NodeJS.ProcessEnv {
  if (!tenantToken) return process.env;
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Strip platform credentials so the SDK doesn't pick them up.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CODE_OAUTH_TOKEN = tenantToken;
  return env;
}

export function fleetConfig(): FleetConfig {
  const authSource = resolveAuthSource();
  return {
    live: authSource !== "none",
    authSource,
    maxRounds: num("FLEET_MAX_ROUNDS", 4),
    maxAgentSteps: num("FLEET_MAX_AGENT_STEPS", 8),
    maxConcurrency: num("FLEET_MAX_CONCURRENCY", 4),
    buildTokenBudget: num("FLEET_BUILD_TOKEN_BUDGET", 300_000),
    maxBudgetUsd: num("FLEET_MAX_BUDGET_USD", 2),
    maxConcurrentBuilds: num("FLEET_MAX_CONCURRENT_BUILDS", 2),
    autodeploy: /^(on|true|1)$/i.test(process.env.FLEET_AUTODEPLOY ?? ""),
    orchestratorModel: str("FLEET_ORCHESTRATOR_MODEL", "opus"),
    subagentModel: str("FLEET_SUBAGENT_MODEL", ""),
    sandbox: str("FLEET_SANDBOX", "noop"),
    sandboxTimeoutMs: num("FLEET_SANDBOX_TIMEOUT_MS", 120_000),
  };
}
