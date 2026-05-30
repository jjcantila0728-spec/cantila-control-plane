import type { AgentSessionStatus } from "./types";

interface AgentLive { status: AgentSessionStatus; lastAt: string; }

export class FleetSessionRegistry {
  private active = new Set<string>();
  private agents = new Map<string, AgentLive>();

  startBuild(projectId: string): void { this.active.add(projectId); }
  endBuild(projectId: string): void { this.active.delete(projectId); }
  activeBuilds(): number { return this.active.size; }

  setAgentStatus(_projectId: string, agentId: string, status: AgentSessionStatus): void {
    this.agents.set(agentId, { status, lastAt: new Date().toISOString() });
  }
  statusOf(agentId: string): AgentSessionStatus { return this.agents.get(agentId)?.status ?? "idle"; }
  lastAtOf(agentId: string): string | undefined { return this.agents.get(agentId)?.lastAt; }
}
