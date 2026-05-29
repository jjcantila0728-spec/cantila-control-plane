/* Telnyx telephony — Phase A smoke test (stub + adapter request-building). */
import { StubTelephonyProvider, createTelephonyProvider } from "../src/sms/provider";
import { TelnyxClient, TelnyxTelephonyProvider } from "../src/sms/telnyx";
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

function recordingFetch(responses: Record<string, unknown>) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const f: typeof fetch = (async (url: string, init: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${new URL(String(url)).pathname.replace("/v2", "")}`;
    const payload = responses[key] ?? responses[method] ?? {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, f };
}

async function telnyxAdapter(): Promise<void> {
  console.log("--- Phase A — TelnyxTelephonyProvider ---");
  const { calls, f } = recordingFetch({
    "POST /messages": { data: { id: "msg_telnyx_1", to: [{ status: "queued" }] } },
    "GET /available_phone_numbers": { data: [{ phone_number: "+639170000010", cost_information: { monthly_cost: "1.00", upfront_cost: "0.50" }, features: [{ name: "sms" }, { name: "voice" }] }] },
    "POST /number_orders": { data: { id: "order_1", phone_numbers: [{ id: "num_telnyx_1", phone_number: "+639170000010" }] } },
    "POST /calls": { data: { call_control_id: "cc_1" } },
  });
  const tp = new TelnyxTelephonyProvider({ apiKey: "KEY", publicKey: "", fetchImpl: f });

  check(tp.live === true, "Telnyx adapter is live");
  check(tp.label === "Telnyx", "Telnyx adapter label");

  const avail = await tp.searchAvailableNumbers({ country: "PH", capability: "sms" });
  check(avail.length === 1 && avail[0].e164 === "+639170000010", "searchAvailableNumbers normalizes", avail);
  check(calls.some((c) => c.url.includes("/available_phone_numbers")), "search hit /available_phone_numbers");

  const sms = await tp.sendSms({ from: "+639170000010", to: "+639998887777", body: "hello" });
  check(sms.accepted === true && sms.providerMessageId === "msg_telnyx_1", "sendSms normalizes", sms);
  const sendCall = calls.find((c) => c.url.includes("/messages"));
  check(
    (sendCall?.body as { text: string }).text === "hello" && (sendCall?.body as { to: string }).to === "+639998887777",
    "sendSms posts {to,text}",
    sendCall?.body,
  );

  const prov = await tp.provisionNumber({ e164: "+639170000010", country: "PH", type: "local", capabilities: ["sms", "voice"] });
  check(prov.providerId === "num_telnyx_1", "provisionNumber returns the Telnyx phone-number id", prov);

  const placed = await tp.placeCall({ from: "+639170000010", to: "+639998887777", routing: { action: "forward", destination: "+639111111111" } });
  check(placed.accepted === true && placed.providerCallId === "cc_1", "placeCall normalizes", placed);
}

async function telnyxVoiceAgentAndFactory(): Promise<void> {
  console.log("--- Phase A — Telnyx VoiceAgent + factory ---");
  const { calls, f } = recordingFetch({
    "POST /ai/assistants": { data: { id: "assist_1", name: "Bot" } },
  });
  const tp = new TelnyxTelephonyProvider({ apiKey: "KEY", publicKey: "", fetchImpl: f });
  const agent = await tp.createVoiceAgent({ name: "Bot", instructions: "Help." });
  check(agent.agentId === "assist_1", "Telnyx createVoiceAgent returns assistant id", agent);
  check(calls.some((c) => c.url.includes("/ai/assistants")), "createVoiceAgent hit /ai/assistants");

  // Factory: no TELNYX_API_KEY → stub
  delete process.env.TELNYX_API_KEY;
  const stub = createTelephonyProvider();
  check(stub.live === false && stub.label === "Stub telephony", "factory returns stub without key", stub.label);

  // Factory: with key → Telnyx
  process.env.TELNYX_API_KEY = "KEY";
  const live = createTelephonyProvider();
  check(live.live === true && live.label === "Telnyx", "factory returns Telnyx with key", live.label);
  delete process.env.TELNYX_API_KEY;
}

async function main(): Promise<void> {
  await stubVoiceAgent();
  await telnyxClientRequest();
  await signatureVerification();
  await telnyxAdapter();
  await telnyxVoiceAgentAndFactory();
  if (failed > 0) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

void main();
