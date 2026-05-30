/* Fleet-internal types. Runtime events (OrchestratorEvent, ProjectAsset) are
   imported from ../agents/project-orchestrator and intentionally NOT redefined. */

export type AgentModel = "opus" | "sonnet";
export type SkillId =
  | "write_file"
  | "read_file"
  | "list_files"
  | "generate_image"
  | "generate_animation"
  | "read_memory"
  | "write_handoff";

export interface AgentRole {
  id: string;
  name: string;
  division: string;
  description: string;
  model: AgentModel;
  allowedSkills: SkillId[];
  systemPrompt: string;
}

export const HANDOFF_STATUSES = [
  "pending-review",
  "approved",
  "changes-requested",
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export interface Handoff {
  agent: string;
  round: number;
  status: HandoffStatus;
  reviewer?: string;
  feedback?: string;
  /** Free-text body: what was done / decisions / next / artifacts. */
  body: string;
  updatedAt: string;
}

export interface DoDItem {
  id: string;
  text: string;
  done: boolean;
}

export interface BuildBatch {
  /** Agent ids that run concurrently in this batch. */
  agents: string[];
}

export interface BuildPlan {
  dod: string[];
  batches: BuildBatch[];
}

const VALID_MODELS = new Set<AgentModel>(["opus", "sonnet"]);

export function isAgentRole(v: unknown): v is AgentRole {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.division === "string" &&
    typeof r.description === "string" &&
    typeof r.model === "string" &&
    VALID_MODELS.has(r.model as AgentModel) &&
    Array.isArray(r.allowedSkills) &&
    typeof r.systemPrompt === "string"
  );
}

export const SDK_TOOL_NAMES = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent"] as const;
export type SdkToolName = (typeof SDK_TOOL_NAMES)[number];

export const AGENT_SESSION_STATUSES = ["idle", "working", "done", "failed"] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];
