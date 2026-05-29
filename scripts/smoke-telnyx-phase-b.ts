/* Telnyx telephony — Phase B smoke test (pure agent-event forward helper). */
import type { VoiceAgentEvent } from "../src/sms/provider";
import { agentToolForward } from "../src/core/control-plane";

let failed = 0;
function check(condition: unknown, label: string, detail?: unknown): void {
  if (condition) { console.log(`✓ ${label}`); }
  else { failed += 1; console.error(`✗ ${label}`); if (detail !== undefined) console.error("   ", detail); }
}

function main(): void {
  console.log("--- Phase B — agentToolForward helper ---");
  const toolEv: VoiceAgentEvent = { agentId: "a1", callId: "c1", kind: "tool_call", toolName: "lookup", payload: { q: "x" }, at: "2026-05-29T00:00:00Z" };
  const transcriptEv: VoiceAgentEvent = { agentId: "a1", callId: "c1", kind: "transcript", at: "2026-05-29T00:00:00Z" };

  const fwd = agentToolForward(toolEv, "https://tenant.example/agent-tools");
  check(fwd !== null && fwd.url === "https://tenant.example/agent-tools", "tool_call + url → forward to url", fwd);
  check(fwd !== null && (fwd.body as { toolName: string }).toolName === "lookup", "forward body carries toolName", fwd?.body);
  check(fwd !== null && (fwd.body as { callId: string }).callId === "c1", "forward body carries callId");

  check(agentToolForward(toolEv, undefined) === null, "tool_call + no url → null (no forward)");
  check(agentToolForward(transcriptEv, "https://tenant.example/agent-tools") === null, "transcript → null (no forward)");

  if (failed > 0) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main();
