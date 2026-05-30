/* Daily spend governor for autonomous Claude Code sessions. In-memory,
   keyed by UTC day; resets at UTC midnight. The aggregate brake on top of
   each session's own maxBudgetUsd. */

export interface BudgetSnapshot {
  date: string;
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
  blocked: boolean;
}

export interface BudgetGovernorOpts {
  capUsd?: number;
  now?: () => Date;
}

function defaultCap(): number {
  const raw = process.env.FLEET_DAILY_BUDGET_USD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 25;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class BudgetGovernor {
  private readonly capUsd: number;
  private readonly now: () => Date;
  private ledger: { date: string; spent: number };

  constructor(opts: BudgetGovernorOpts = {}) {
    this.capUsd = opts.capUsd ?? defaultCap();
    this.now = opts.now ?? (() => new Date());
    this.ledger = { date: this.utcDay(), spent: 0 };
  }

  private utcDay(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private roll(): void {
    const today = this.utcDay();
    if (this.ledger.date !== today) this.ledger = { date: today, spent: 0 };
  }

  canSpend(): boolean {
    this.roll();
    return this.ledger.spent < this.capUsd;
  }

  record(costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    this.roll();
    this.ledger.spent += costUsd;
  }

  snapshot(): BudgetSnapshot {
    this.roll();
    const spentUsd = round2(this.ledger.spent);
    return {
      date: this.ledger.date,
      spentUsd,
      capUsd: this.capUsd,
      remainingUsd: round2(Math.max(0, this.capUsd - spentUsd)),
      blocked: spentUsd >= this.capUsd,
    };
  }
}

let singleton: BudgetGovernor | null = null;
export function getBudgetGovernor(): BudgetGovernor {
  if (!singleton) singleton = new BudgetGovernor();
  return singleton;
}
