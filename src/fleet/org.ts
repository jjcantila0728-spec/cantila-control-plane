import { rolesByDivision } from "./roster/index";
import type { FleetSessionRegistry } from "./session-registry";
import type { AgentSessionStatus } from "./types";
import { getBudgetGovernor, type BudgetSnapshot } from "./budget";

export interface OrgAgent { id: string; name: string; model: string; description: string; status: AgentSessionStatus; lastAt?: string; }
export interface OrgDivision { key: string; label: string; agents: OrgAgent[]; }
export interface AgentOrg { divisions: OrgDivision[]; activeBuilds: number; budget: BudgetSnapshot; }

function label(key: string): string { return key.charAt(0).toUpperCase() + key.slice(1).replace(/-/g, " "); }

export function buildAgentOrg(registry: FleetSessionRegistry): AgentOrg {
  const byDiv = rolesByDivision();
  const divisions: OrgDivision[] = Object.entries(byDiv).map(([key, roles]) => ({
    key,
    label: label(key),
    agents: roles.map((r) => ({
      id: r.id, name: r.name, model: r.model, description: r.description,
      status: registry.statusOf(r.id), lastAt: registry.lastAtOf(r.id),
    })),
  }));
  return { divisions, activeBuilds: registry.activeBuilds(), budget: getBudgetGovernor().snapshot() };
}
