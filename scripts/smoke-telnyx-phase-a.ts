/* Telnyx telephony — Phase A smoke test (stub + adapter request-building). */
import { StubTelephonyProvider } from "../src/sms/provider";

let failed = 0;
function check(condition: unknown, label: string, detail?: unknown): void {
  if (condition) { console.log(`✓ ${label}`); }
  else { failed += 1; console.error(`✗ ${label}`); if (detail !== undefined) console.error("   ", detail); }
}

async function stubVoiceAgent(): Promise<void> {
  console.log("--- Phase A — stub VoiceAgent ---");
  const stub = new StubTelephonyProvider();
  const agent = await stub.createVoiceAgent({
    name: "Support bot",
    instructions: "Answer billing questions.",
    greeting: "Hi, this is Cantila support.",
  });
  check(agent.agentId.startsWith("agent_stub_"), "stub createVoiceAgent returns agent_stub_ id", agent);
  check(agent.name === "Support bot", "stub agent keeps name");

  const updated = await stub.updateVoiceAgent({ agentId: agent.agentId, name: "Support bot v2" });
  check(updated.name === "Support bot v2", "stub updateVoiceAgent applies name");

  await stub.attachAgentToNumber({ agentId: agent.agentId, e164: "+639170000001" });
  check(true, "stub attachAgentToNumber resolves");

  const ev = stub.parseAgentEvent(
    JSON.stringify({ agentId: agent.agentId, callId: "call_1", kind: "tool_call", toolName: "lookup", payload: { q: "x" } }),
    {},
  );
  check(ev.kind === "tool_call" && ev.toolName === "lookup", "stub parseAgentEvent normalizes a tool_call", ev);

  await stub.deleteVoiceAgent({ agentId: agent.agentId });
  check(true, "stub deleteVoiceAgent resolves");
}

async function main(): Promise<void> {
  await stubVoiceAgent();
  if (failed > 0) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

void main();
