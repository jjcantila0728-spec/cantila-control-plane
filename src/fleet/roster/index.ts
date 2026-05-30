import type { AgentRoleRaw } from "./types";
import { ROSTER } from "./roster.generated";

const byId = new Map<string, AgentRoleRaw>(ROSTER.map((r) => [r.id, r]));
export function listRoles(): AgentRoleRaw[] { return ROSTER.slice(); }
export function getRole(id: string): AgentRoleRaw | undefined { return byId.get(id); }
export function rolesByDivision(): Record<string, AgentRoleRaw[]> {
  const out: Record<string, AgentRoleRaw[]> = {};
  for (const r of ROSTER) (out[r.division] ??= []).push(r);
  return out;
}
