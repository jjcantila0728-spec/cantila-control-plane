/* Telnyx telephony — Phase A smoke test (stub + adapter request-building). */
import { StubTelephonyProvider } from "../src/sms/provider";
import { TelnyxClient } from "../src/sms/telnyx";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { verifyTelnyxSignature } from "../src/sms/telnyx";

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

async function telnyxClientRequest(): Promise<void> {
  console.log("--- Phase A — TelnyxClient request building ---");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: { id: "msg_1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const client = new TelnyxClient({ apiKey: "KEY123", fetchImpl: fakeFetch });
  const body = await client.post("/messages", { from: "+1", to: "+2", text: "hi" });
  check(calls.length === 1, "client issued one request");
  check(calls[0].url === "https://api.telnyx.com/v2/messages", "client hits v2 base + path", calls[0].url);
  check(
    (calls[0].init.headers as Record<string, string>)["Authorization"] === "Bearer KEY123",
    "client sends Bearer auth",
  );
  check((body as { data: { id: string } }).data.id === "msg_1", "client returns parsed JSON body");
}

async function signatureVerification(): Promise<void> {
  console.log("--- Phase A — Ed25519 signature verification ---");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32); // last 32 bytes = raw key
  const publicKeyB64 = rawPub.toString("base64");

  const timestamp = "1700000000";
  const rawBody = JSON.stringify({ data: { event_type: "message.received" } });
  const sig = edSign(null, Buffer.from(`${timestamp}|${rawBody}`), privateKey).toString("base64");

  check(
    verifyTelnyxSignature(publicKeyB64, sig, timestamp, rawBody) === true,
    "valid signature verifies",
  );
  check(
    verifyTelnyxSignature(publicKeyB64, sig, timestamp, rawBody + "X") === false,
    "tampered body fails verification",
  );
}

async function main(): Promise<void> {
  await stubVoiceAgent();
  await telnyxClientRequest();
  await signatureVerification();
  if (failed > 0) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

void main();
