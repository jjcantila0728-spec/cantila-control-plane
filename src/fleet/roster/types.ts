import type { AgentModel } from "../types";

/** Raw role as ported from AgentFleet markdown (tools kept as raw strings). */
export interface AgentRoleRaw {
  id: string;
  name: string;
  division: string;
  description: string;
  model: AgentModel;
  tools: string[];
  systemPrompt: string;
}
