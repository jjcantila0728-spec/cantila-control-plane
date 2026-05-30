import { randomBytes } from "node:crypto";
import type { DoDItem, Handoff, HandoffStatus } from "./types";

export interface FleetProject {
  name: string;
  goal: string;
  stack: string;
  status: string;
}

export interface FleetMemorySnapshot {
  projectId: string;
  project: FleetProject;
  dod: DoDItem[];
  decisions: string[];
  summary: string;
  handoffs: Record<string, Handoff>;
}

const SLICE_MAX = 4000;

export class FleetMemory {
  private project: FleetProject = { name: "", goal: "", stack: "", status: "new" };
  private dod: DoDItem[] = [];
  private decisions: string[] = [];
  private summary = "";
  private handoffs: Map<string, Handoff> = new Map();

  constructor(public readonly projectId: string) {}

  setProject(p: Partial<FleetProject>): void {
    this.project = { ...this.project, ...p };
  }

  setDoD(items: string[]): void {
    this.dod = items.map((text) => ({
      id: `dod_${randomBytes(4).toString("hex")}`,
      text,
      done: false,
    }));
  }

  checkDoD(id: string, done: boolean): void {
    const item = this.dod.find((d) => d.id === id);
    if (item) item.done = done;
  }

  allDoDPassed(): boolean {
    return this.dod.length > 0 && this.dod.every((d) => d.done);
  }

  appendDecision(text: string): void {
    this.decisions.push(text.trim());
  }

  setSummary(text: string): void {
    this.summary = text;
  }

  putHandoff(h: Omit<Handoff, "updatedAt">): void {
    this.handoffs.set(h.agent, { ...h, updatedAt: new Date().toISOString() });
  }

  review(agent: string, verdict: Exclude<HandoffStatus, "pending-review">, feedback?: string): void {
    const h = this.handoffs.get(agent);
    if (!h) return;
    h.status = verdict;
    h.reviewer = "00-orchestrator";
    h.feedback = verdict === "changes-requested" ? feedback : undefined;
    h.updatedAt = new Date().toISOString();
  }

  read(): FleetMemorySnapshot {
    return {
      projectId: this.projectId,
      project: { ...this.project },
      dod: this.dod.map((d) => ({ ...d })),
      decisions: this.decisions.slice(),
      summary: this.summary,
      handoffs: Object.fromEntries(this.handoffs),
    };
  }

  /** Compact, size-bounded context an agent should read before working. */
  relevantSlice(agentId: string): string {
    const lines: string[] = [];
    lines.push(`Project: ${this.project.name || "(unnamed)"} — ${this.project.goal || ""}`);
    lines.push(`Stack: ${this.project.stack || "TypeScript/Next.js"}`);
    lines.push("MVP Definition-of-Done:");
    for (const d of this.dod) lines.push(`  [${d.done ? "x" : " "}] ${d.text}`);
    const own = this.handoffs.get(agentId);
    if (own?.feedback) lines.push(`Reviewer feedback for you: ${own.feedback}`);
    const recentDecisions = this.decisions.slice(-8);
    if (recentDecisions.length) {
      lines.push("Recent decisions:");
      for (const d of recentDecisions) lines.push(`  - ${d.slice(0, 200)}`);
    }
    const approved = [...this.handoffs.values()].filter((h) => h.status === "approved");
    if (approved.length) {
      lines.push("Approved work so far:");
      for (const h of approved.slice(-8)) lines.push(`  - ${h.agent}: ${h.body.slice(0, 160)}`);
    }
    return lines.join("\n").slice(0, SLICE_MAX);
  }
}
