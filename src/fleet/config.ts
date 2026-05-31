/* Fleet engine configuration + safety caps. Env-overridable; sane defaults. */

export interface FleetConfig {
  /** True when a real Anthropic key is configured. */
  live: boolean;
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
}

function num(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function fleetConfig(): FleetConfig {
  return {
    live: !!process.env.ANTHROPIC_API_KEY,
    maxRounds: num("FLEET_MAX_ROUNDS", 4),
    maxAgentSteps: num("FLEET_MAX_AGENT_STEPS", 8),
    maxConcurrency: num("FLEET_MAX_CONCURRENCY", 4),
    buildTokenBudget: num("FLEET_BUILD_TOKEN_BUDGET", 300_000),
    maxBudgetUsd: num("FLEET_MAX_BUDGET_USD", 2),
    maxConcurrentBuilds: num("FLEET_MAX_CONCURRENT_BUILDS", 2),
    autodeploy: /^(on|true|1)$/i.test(process.env.FLEET_AUTODEPLOY ?? ""),
  };
}
