/* ============================================================
   Cantila Agents — barrel.
   ============================================================ */

import type { ControlPlane } from "../core/control-plane";
import { AgentBrain } from "./brain";
import { UptimeAgent } from "./uptime-agent";
import { DeployAgent } from "./deploy-agent";
import { CostAgent } from "./cost-agent";
import { ScaleAgent } from "./scale-agent";
import { SecurityAgent } from "./security-agent";
import { CapacityAgent } from "./capacity-agent";
import { MailAgent } from "./mail-agent";
import { SmsAgent } from "./sms-agent";
import { AutomationAgent } from "./automation-agent";
import { SeoAgent } from "./seo-agent";

export { AgentBrain } from "./brain";
export { UptimeAgent } from "./uptime-agent";
export { DeployAgent } from "./deploy-agent";
export { CostAgent } from "./cost-agent";
export { ScaleAgent } from "./scale-agent";
export { SecurityAgent } from "./security-agent";
export { CapacityAgent } from "./capacity-agent";
export { MailAgent } from "./mail-agent";
export { SmsAgent } from "./sms-agent";
export { AutomationAgent } from "./automation-agent";
export { SeoAgent } from "./seo-agent";
export type {
  Agent,
  AgentName,
  ActionClass,
  Confidence,
  ActionRecord,
  BrainSnapshot,
  Observation,
  Proposal,
} from "./types";

/** Wire the ten launch agents into a fresh brain.
 *  (Uptime / Deploy / Cost / Scale / Security / Capacity / Mail / Sms /
 *  AutomationAgent watching Automations health, and the SeoAgent that
 *  continuously audits the public face and queues / auto-applies SEO
 *  fixes via the env-gated SeoFixer port.) */
export function createDefaultBrain(cp: ControlPlane): AgentBrain {
  return new AgentBrain(cp, [
    new UptimeAgent(),
    new DeployAgent(),
    new CostAgent(),
    new ScaleAgent(),
    new SecurityAgent(),
    new CapacityAgent(),
    new MailAgent(),
    new SmsAgent(),
    new AutomationAgent(),
    new SeoAgent(),
  ]);
}
