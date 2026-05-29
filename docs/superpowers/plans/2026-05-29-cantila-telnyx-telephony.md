# Cantila Telnyx Telephony Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cantila telephony deliver for real by adding a live, env-gated Telnyx adapter behind the existing `TelephonyProvider` port — covering SMS, number provisioning, voice (Call Control), and AI voice agents — with the in-process stub as the offline default.

**Architecture:** A new `TelnyxTelephonyProvider` (in `src/sms/telnyx.ts`) implements the existing `TelephonyProvider` port using the Telnyx v2 REST API over native `fetch`. `src/sms/provider.ts` gains a `VoiceAgent` port extension (stub + Telnyx impls) and a `createTelephonyProvider()` factory that returns the Telnyx adapter when `TELNYX_API_KEY` is set and the stub otherwise. The control plane and routes are already wired through the port; we add thin voice-agent wrappers and one agent-event webhook route. Webhook signatures are verified with Ed25519 (`node:crypto`).

**Tech Stack:** TypeScript (Node 20, ESM via tsx), Fastify, native `fetch`, `node:crypto` for Ed25519, smoke scripts in `scripts/` for verification (`npx tsx`), `npm run typecheck` for types. No new dependencies.

---

## Conventions (read before starting)

- **No test runner.** Verification = smoke scripts run with `npx tsx scripts/<name>.ts`, using this helper (copied into each smoke script):

  ```ts
  let failed = 0;
  function check(condition: unknown, label: string, detail?: unknown): void {
    if (condition) { console.log(`✓ ${label}`); }
    else { failed += 1; console.error(`✗ ${label}`); if (detail !== undefined) console.error("   ", detail); }
  }
  ```
  Each smoke script ends with:
  ```ts
  if (failed > 0) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
  ```
- **A "failing test" step** = add the smoke assertions, run the script, and confirm it fails (because the code under test doesn't exist yet or is wrong). Then implement, then re-run to green.
- **Type-only imports** from `provider.ts` into `telnyx.ts` (the interfaces are erased at runtime), so there is no runtime circular import even though `provider.ts` imports the `TelnyxTelephonyProvider` class.
- **Always run `npm run typecheck` before each commit.**
- Existing port shapes live in `src/sms/provider.ts`; domain types `NumberType` (`"local" | "toll_free" | "mobile" | "short_code"`) and `NumberCapability` (`"sms" | "mms" | "voice"`) live in `src/domain/types.ts`.

## File structure

- **Create** `src/sms/telnyx.ts` — `TelnyxTelephonyProvider` + a small `TelnyxClient` (injectable `fetchImpl`) + `verifyTelnyxSignature`.
- **Modify** `src/sms/provider.ts` — add `VoiceAgent` port shapes + `TelephonyProvider` methods; implement them on `StubTelephonyProvider`; add `createTelephonyProvider()` factory; replace the hardcoded singleton.
- **Modify** `src/core/control-plane.ts` — add `createVoiceAgent` / `updateVoiceAgent` / `deleteVoiceAgent` / `attachVoiceAgent` / `receiveAgentEvent` wrappers.
- **Modify** `src/index.ts` — add voice-agent CRUD routes + the agent-event webhook route.
- **Create** `scripts/smoke-telnyx-phase-a.ts` — stub + Telnyx request-building + signature verification (no live calls).
- **Create** `scripts/smoke-telnyx-phase-b.ts` — voice-agent lifecycle (stub) + control-plane wrappers + agent-event forwarding.

---

# Phase A — Live adapter: SMS, numbers, voice, factory

## Task A1: VoiceAgent port shapes + stub implementations

**Files:**
- Modify: `src/sms/provider.ts`
- Test: `scripts/smoke-telnyx-phase-a.ts` (create)

- [ ] **Step 1: Add the failing smoke script**

Create `scripts/smoke-telnyx-phase-a.ts`:

```ts
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
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx tsx scripts/smoke-telnyx-phase-a.ts`
Expected: FAIL — `createVoiceAgent` is not a function / type error (method not on `StubTelephonyProvider`).

- [ ] **Step 3: Add VoiceAgent shapes to the port**

In `src/sms/provider.ts`, in the `/* ---------- A2P / 10DLC registration ---------- */` region (just before `/* ---------- the port ---------- */`), add:

```ts
/* ---------- AI voice agents ---------- */

/** A webhook tool the voice agent may invoke during a call. The agent
 *  calls out to the tenant app; the control plane signs the request with
 *  the project's HMAC secret. */
export interface VoiceAgentTool {
  name: string;
  description: string;
  webhookUrl: string;
}

/** Config for a deployable AI voice agent. */
export interface VoiceAgentConfig {
  name: string;
  /** System prompt that steers the agent. */
  instructions: string;
  /** TTS voice id; the provider default is used when unset. */
  voice?: string;
  /** Spoken when the agent answers. */
  greeting?: string;
  tools?: VoiceAgentTool[];
}

/** A provisioned voice agent the carrier now hosts. */
export interface ProvisionedVoiceAgent {
  agentId: string;
  name: string;
}

/** A normalized agent/tool webhook event. */
export interface VoiceAgentEvent {
  agentId: string;
  callId: string;
  kind: "tool_call" | "transcript" | "ended";
  toolName?: string;
  payload?: Record<string, unknown>;
  at: string;
}
```

- [ ] **Step 4: Add the methods to the `TelephonyProvider` interface**

In `src/sms/provider.ts`, inside `export interface TelephonyProvider { ... }`, after `registerA2pCampaign(...)`, add:

```ts
  /* --- AI voice agents --- */

  /** Create a hosted AI voice agent. */
  createVoiceAgent(input: VoiceAgentConfig): Promise<ProvisionedVoiceAgent>;

  /** Update an existing agent's config. */
  updateVoiceAgent(
    input: { agentId: string } & Partial<VoiceAgentConfig>,
  ): Promise<ProvisionedVoiceAgent>;

  /** Delete an agent. */
  deleteVoiceAgent(input: { agentId: string }): Promise<void>;

  /** Bind an agent to a provisioned number so inbound calls reach it. */
  attachAgentToNumber(input: { agentId: string; e164: string }): Promise<void>;

  /** Verify + normalize an agent/tool webhook into `VoiceAgentEvent`;
   *  throws on an invalid signature or unparseable body. */
  parseAgentEvent(
    rawBody: string,
    headers: Record<string, string>,
  ): VoiceAgentEvent;
```

- [ ] **Step 5: Implement the methods on `StubTelephonyProvider`**

In `src/sms/provider.ts`, inside `class StubTelephonyProvider`, after `registerA2pCampaign(...)` (before the closing brace), add. Note: reuse the existing private `nextId(prefix)` helper and the file-level `parseJson`.

```ts
  private agents = new Map<string, ProvisionedVoiceAgent>();

  async createVoiceAgent(input: VoiceAgentConfig): Promise<ProvisionedVoiceAgent> {
    const agent: ProvisionedVoiceAgent = {
      agentId: this.nextId("agent"),
      name: input.name,
    };
    this.agents.set(agent.agentId, agent);
    return agent;
  }

  async updateVoiceAgent(
    input: { agentId: string } & Partial<VoiceAgentConfig>,
  ): Promise<ProvisionedVoiceAgent> {
    const existing = this.agents.get(input.agentId) ?? {
      agentId: input.agentId,
      name: input.name ?? "agent",
    };
    const updated: ProvisionedVoiceAgent = {
      agentId: input.agentId,
      name: input.name ?? existing.name,
    };
    this.agents.set(input.agentId, updated);
    return updated;
  }

  async deleteVoiceAgent(input: { agentId: string }): Promise<void> {
    this.agents.delete(input.agentId);
  }

  async attachAgentToNumber(_input: { agentId: string; e164: string }): Promise<void> {
    // No-op — the stub binds nothing real.
  }

  parseAgentEvent(
    rawBody: string,
    _headers: Record<string, string>,
  ): VoiceAgentEvent {
    const p = parseJson(rawBody);
    const kind = p.kind;
    const k: VoiceAgentEvent["kind"] =
      kind === "tool_call" || kind === "transcript" || kind === "ended"
        ? kind
        : "transcript";
    return {
      agentId: String(p.agentId ?? ""),
      callId: String(p.callId ?? ""),
      kind: k,
      toolName: typeof p.toolName === "string" ? p.toolName : undefined,
      payload:
        p.payload && typeof p.payload === "object"
          ? (p.payload as Record<string, unknown>)
          : undefined,
      at: String(p.at ?? new Date().toISOString()),
    };
  }
```

- [ ] **Step 6: Run the smoke script; verify it passes**

Run: `npx tsx scripts/smoke-telnyx-phase-a.ts`
Expected: PASS — all stub VoiceAgent checks print `✓`, ends with "all checks passed".

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/sms/provider.ts scripts/smoke-telnyx-phase-a.ts
git commit -m "feat(sms): add VoiceAgent port shapes + stub impls"
```

---

## Task A2: `TelnyxClient` — injectable fetch REST wrapper

**Files:**
- Create: `src/sms/telnyx.ts`
- Test: `scripts/smoke-telnyx-phase-a.ts` (extend)

- [ ] **Step 1: Add failing smoke assertions**

In `scripts/smoke-telnyx-phase-a.ts`, add this function and call it from `main()` before the exit block:

```ts
import { TelnyxClient } from "../src/sms/telnyx";

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
```
And add `await telnyxClientRequest();` in `main()`.

- [ ] **Step 2: Run; verify it fails**

Run: `npx tsx scripts/smoke-telnyx-phase-a.ts`
Expected: FAIL — cannot import `TelnyxClient` from `../src/sms/telnyx` (file does not exist).

- [ ] **Step 3: Create `src/sms/telnyx.ts` with `TelnyxClient`**

```ts
/* ============================================================
   Telnyx live telephony adapter (plan §21). Implements the
   `TelephonyProvider` port against the Telnyx v2 REST API.
   Type-only imports from ./provider keep this free of a runtime
   circular dependency.
   ============================================================ */

import { createPublicKey, verify as edVerify } from "node:crypto";

import type {
  TelephonyProvider,
  AvailableNumber,
  ProvisionedNumber,
  OutboundSmsResult,
  OutboundCallResult,
  CallRouting,
  InboundSmsMessage,
  InboundCall,
  SmsStatusUpdate,
  CallStatusUpdate,
  A2pRegistration,
  VoiceAgentConfig,
  ProvisionedVoiceAgent,
  VoiceAgentEvent,
} from "./provider";
import type { NumberType, NumberCapability } from "../domain/types";

const TELNYX_BASE = "https://api.telnyx.com/v2";

export interface TelnyxClientConfig {
  apiKey: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Thin Telnyx v2 REST client. Throws `TelnyxError` on non-2xx. */
export class TelnyxClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: TelnyxClientConfig) {
    this.apiKey = cfg.apiKey;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${TELNYX_BASE}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return this.handle(res, path);
  }

  async get(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${TELNYX_BASE}${path}`, {
      method: "GET",
      headers: this.headers(),
    });
    return this.handle(res, path);
  }

  async del(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${TELNYX_BASE}${path}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    return this.handle(res, path);
  }

  private async handle(res: Response, path: string): Promise<unknown> {
    const text = await res.text();
    if (!res.ok) {
      throw new TelnyxError(res.status, path, text);
    }
    return text ? (JSON.parse(text) as unknown) : {};
  }
}

export class TelnyxError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly bodyText: string,
  ) {
    super(`Telnyx ${status} on ${path}: ${bodyText.slice(0, 300)}`);
    this.name = "TelnyxError";
  }
}
```

- [ ] **Step 4: Run; verify it passes**

Run: `npx tsx scripts/smoke-telnyx-phase-a.ts`
Expected: PASS — TelnyxClient checks print `✓`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/sms/telnyx.ts scripts/smoke-telnyx-phase-a.ts
git commit -m "feat(sms): add TelnyxClient REST wrapper"
```

---

## Task A3: Ed25519 webhook signature verification

**Files:**
- Modify: `src/sms/telnyx.ts`
- Test: `scripts/smoke-telnyx-phase-a.ts` (extend)

- [ ] **Step 1: Add failing smoke assertions**

In `scripts/smoke-telnyx-phase-a.ts`, add (and call from `main()`):

```ts
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { verifyTelnyxSignature } from "../src/sms/telnyx";

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
```
Add `await signatureVerification();` in `main()`.

- [ ] **Step 2: Run; verify it fails**

Run: `npx tsx scripts/smoke-telnyx-phase-a.ts`
Expected: FAIL — `verifyTelnyxSignature` is not exported from `../src/sms/telnyx`.

- [ ] **Step 3: Implement `verifyTelnyxSignature` in `src/sms/telnyx.ts`**

Add to `src/sms/telnyx.ts` (after the `TelnyxError` class):

```ts
/** DER SPKI prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Verify a Telnyx Ed25519 webhook signature. Telnyx signs
 *  `${timestamp}|${rawBody}` with its messaging-profile key; the public
 *  key (env `TELNYX_PUBLIC_KEY`) is the base64 of the raw 32-byte key. */
export function verifyTelnyxSignature(
  publicKeyB64: string,
  signatureB64: string,
  timestamp: string,
  rawBody: string,
): boolean {
  try {
    const rawKey = Buffer.from(publicKeyB64, "base64");
    const der = Buffer.concat([ED25519_SPKI_PREFIX, rawKey]);
    const keyObj = createPublicKey({ key: der, format: "der", type: "spki" });
    return edVerify(
      null,
      Buffer.from(`${timestamp}|${rawBody}`),
      keyObj,
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run; verify it passes**

Run: `npx tsx scripts/smoke-telnyx-phase-a.ts`
Expected: PASS — both signature checks print `✓`.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/sms/telnyx.ts scripts/smoke-telnyx-phase-a.ts
git commit -m "feat(sms): add Telnyx Ed25519 webhook signature verification"
```

---

## Task A4: `TelnyxTelephonyProvider` — numbers + SMS + voice

**Files:**
- Modify: `src/sms/telnyx.ts`
- Test: `scripts/smoke-telnyx-phase-a.ts` (extend)

- [ ] **Step 1: Add failing smoke assertions**

In `scripts/smoke-telnyx-phase-a.ts`, add (and call from `main()`):

```ts
import { TelnyxTelephonyProvider } from "../src/sms/telnyx";

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
```
Add `await telnyxAdapter();` in `main()`.

- [ ] **Step 2: Run; verify it fails**

Run: `npx tsx scripts/smoke-telnyx-phase-a.ts`
Expected: FAIL — `TelnyxTelephonyProvider` is not exported.

- [ ] **Step 3: Implement `TelnyxTelephonyProvider` (numbers, SMS, voice, parsers, A2P)**

Append to `src/sms/telnyx.ts`:

```ts
export interface TelnyxProviderConfig {
  apiKey: string;
  publicKey?: string;
  messagingProfileId?: string;
  voiceConnectionId?: string;
  fetchImpl?: typeof fetch;
}

export class TelnyxTelephonyProvider implements TelephonyProvider {
  readonly label = "Telnyx";
  readonly live = true;

  private readonly client: TelnyxClient;
  private readonly publicKey: string;
  private readonly messagingProfileId?: string;
  private readonly voiceConnectionId?: string;

  constructor(cfg: TelnyxProviderConfig) {
    this.client = new TelnyxClient({ apiKey: cfg.apiKey, fetchImpl: cfg.fetchImpl });
    this.publicKey = cfg.publicKey ?? "";
    this.messagingProfileId = cfg.messagingProfileId;
    this.voiceConnectionId = cfg.voiceConnectionId;
  }

  /* --- numbers --- */

  async searchAvailableNumbers(input: {
    country: string;
    type?: NumberType;
    capability?: NumberCapability;
    areaCode?: string;
  }): Promise<AvailableNumber[]> {
    const params = new URLSearchParams();
    params.set("filter[country_code]", input.country);
    if (input.capability) params.append("filter[features][]", input.capability);
    if (input.areaCode) params.set("filter[national_destination_code]", input.areaCode);
    const res = (await this.client.get(`/available_phone_numbers?${params.toString()}`)) as {
      data?: Array<{
        phone_number: string;
        cost_information?: { monthly_cost?: string; upfront_cost?: string };
        features?: Array<{ name: string }>;
      }>;
    };
    const type: NumberType = input.type ?? "local";
    return (res.data ?? []).map((n) => ({
      e164: n.phone_number,
      country: input.country,
      type,
      capabilities: (n.features ?? [])
        .map((f) => f.name)
        .filter((x): x is NumberCapability => x === "sms" || x === "mms" || x === "voice"),
      setupPriceCents: Math.round(Number(n.cost_information?.upfront_cost ?? "0") * 100),
      monthlyPriceCents: Math.round(Number(n.cost_information?.monthly_cost ?? "0") * 100),
    }));
  }

  async provisionNumber(input: {
    e164: string;
    country: string;
    type: NumberType;
    capabilities: NumberCapability[];
  }): Promise<ProvisionedNumber> {
    const res = (await this.client.post("/number_orders", {
      phone_numbers: [{ phone_number: input.e164 }],
      ...(this.messagingProfileId ? { messaging_profile_id: this.messagingProfileId } : {}),
    })) as { data?: { phone_numbers?: Array<{ id: string; phone_number: string }> } };
    const pn = res.data?.phone_numbers?.[0];
    return {
      e164: input.e164,
      country: input.country,
      type: input.type,
      capabilities: input.capabilities,
      providerId: pn?.id ?? "",
    };
  }

  async releaseNumber(input: { providerId: string }): Promise<void> {
    await this.client.del(`/phone_numbers/${input.providerId}`);
  }

  async portInNumber(input: {
    e164: string;
    country: string;
    type: NumberType;
    capabilities: NumberCapability[];
  }): Promise<{ providerId: string }> {
    const res = (await this.client.post("/porting_orders", {
      phone_numbers: [{ phone_number: input.e164 }],
    })) as { data?: { id?: string } };
    return { providerId: res.data?.id ?? "" };
  }

  /* --- outbound SMS --- */

  async sendSms(input: { from: string; to: string; body: string }): Promise<OutboundSmsResult> {
    const res = (await this.client.post("/messages", {
      from: input.from,
      to: input.to,
      text: input.body,
      ...(this.messagingProfileId ? { messaging_profile_id: this.messagingProfileId } : {}),
    })) as { data?: { id?: string } };
    return { providerMessageId: res.data?.id ?? "", accepted: Boolean(res.data?.id) };
  }

  /* --- outbound voice --- */

  async placeCall(input: { from: string; to: string; routing: CallRouting }): Promise<OutboundCallResult> {
    void input.routing;
    const res = (await this.client.post("/calls", {
      to: input.to,
      from: input.from,
      ...(this.voiceConnectionId ? { connection_id: this.voiceConnectionId } : {}),
    })) as { data?: { call_control_id?: string } };
    return { providerCallId: res.data?.call_control_id ?? "", accepted: Boolean(res.data?.call_control_id) };
  }

  /* --- inbound webhook parsing --- */

  private requireVerified(rawBody: string, headers: Record<string, string>): Record<string, unknown> {
    const sig = headers["telnyx-signature-ed25519"] ?? headers["Telnyx-Signature-Ed25519"] ?? "";
    const ts = headers["telnyx-timestamp"] ?? headers["Telnyx-Timestamp"] ?? "";
    if (!verifyTelnyxSignature(this.publicKey, sig, ts, rawBody)) {
      throw new Error("invalid Telnyx webhook signature");
    }
    const parsed = JSON.parse(rawBody) as { data?: { payload?: Record<string, unknown> } };
    return parsed.data?.payload ?? {};
  }

  parseInboundSms(rawBody: string, headers: Record<string, string>): InboundSmsMessage {
    const p = this.requireVerified(rawBody, headers);
    const from = String((p.from as { phone_number?: string })?.phone_number ?? p.from ?? "");
    const toArr = p.to as Array<{ phone_number?: string }> | undefined;
    const to = String(toArr?.[0]?.phone_number ?? p.to ?? "");
    const body = String(p.text ?? "");
    const upper = body.trim().toUpperCase();
    const keyword =
      upper === "STOP" ? "stop" : upper === "START" ? "start" : upper === "HELP" ? "help" : undefined;
    return {
      providerMessageId: String(p.id ?? ""),
      from,
      to,
      body,
      receivedAt: String(p.received_at ?? new Date().toISOString()),
      keyword,
    };
  }

  parseInboundCall(rawBody: string, headers: Record<string, string>): InboundCall {
    const p = this.requireVerified(rawBody, headers);
    return {
      providerCallId: String(p.call_control_id ?? ""),
      from: String(p.from ?? ""),
      to: String(p.to ?? ""),
      receivedAt: String(p.start_time ?? new Date().toISOString()),
    };
  }

  parseSmsStatus(rawBody: string, headers: Record<string, string>): SmsStatusUpdate {
    const p = this.requireVerified(rawBody, headers);
    const toArr = p.to as Array<{ status?: string }> | undefined;
    const raw = String(toArr?.[0]?.status ?? "sent");
    const status: SmsStatusUpdate["status"] =
      raw === "delivered" ? "delivered"
      : raw === "sending_failed" || raw === "delivery_failed" ? "failed"
      : raw === "queued" ? "queued"
      : raw === "sent" ? "sent"
      : "undelivered";
    return { providerMessageId: String(p.id ?? ""), status, at: String(p.completed_at ?? new Date().toISOString()) };
  }

  parseCallStatus(rawBody: string, headers: Record<string, string>): CallStatusUpdate {
    const p = this.requireVerified(rawBody, headers);
    const raw = String(p.state ?? "completed");
    const status: CallStatusUpdate["status"] =
      raw === "ringing" ? "ringing"
      : raw === "answered" || raw === "bridged" ? "in_progress"
      : raw === "hangup" || raw === "completed" ? "completed"
      : raw === "busy" ? "busy"
      : raw === "no-answer" ? "no_answer"
      : "failed";
    return {
      providerCallId: String(p.call_control_id ?? ""),
      status,
      durationSec: typeof p.duration_secs === "number" ? p.duration_secs : undefined,
      at: String(p.occurred_at ?? new Date().toISOString()),
    };
  }

  /* --- A2P / 10DLC --- */

  async registerA2pCampaign(input: {
    brandName: string;
    useCase: string;
    sampleMessages: string[];
  }): Promise<A2pRegistration> {
    const res = (await this.client.post("/10dlc/campaigns", {
      brand_name: input.brandName,
      use_case: input.useCase,
      sample_messages: input.sampleMessages,
    })) as { data?: { campaignId?: string; id?: string; status?: string } };
    const status = res.data?.status;
    return {
      campaignId: String(res.data?.campaignId ?? res.data?.id ?? ""),
      status: status === "approved" ? "approved" : status === "rejected" ? "rejected" : "pending",
    };
  }
}
```

> Note: `createVoiceAgent` / `updateVoiceAgent` / `deleteVoiceAgent` / `attachAgentToNumber` / `parseAgentEvent` are added in Task A5; this class is incomplete-by-interface until then, so Step 4 below runs the smoke script (not typecheck) first.

- [ ] **Step 4: Run the smoke script; verify it passes**

Run: `npx tsx scripts/smoke-telnyx-phase-a.ts`
Expected: PASS — numbers/SMS/voice checks print `✓`. (Typecheck will still fail until A5 adds the VoiceAgent methods — that's expected; do not commit yet.)

- [ ] **Step 5: Commit (code only; typecheck deferred to A5)**

```bash
git add src/sms/telnyx.ts scripts/smoke-telnyx-phase-a.ts
git commit -m "feat(sms): TelnyxTelephonyProvider numbers/SMS/voice + parsers"
```

---

## Task A5: Telnyx VoiceAgent methods + factory + singleton swap

**Files:**
- Modify: `src/sms/telnyx.ts`, `src/sms/provider.ts`
- Test: `scripts/smoke-telnyx-phase-a.ts` (extend)

- [ ] **Step 1: Add failing smoke assertions**

In `scripts/smoke-telnyx-phase-a.ts`, add (and call from `main()`):

```ts
import { createTelephonyProvider } from "../src/sms/provider";

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
```
Add `await telnyxVoiceAgentAndFactory();` in `main()`.

- [ ] **Step 2: Run; verify it fails**

Run: `npx tsx scripts/smoke-telnyx-phase-a.ts`
Expected: FAIL — `createVoiceAgent` missing on Telnyx adapter and/or `createTelephonyProvider` not exported.

- [ ] **Step 3: Add VoiceAgent methods to `TelnyxTelephonyProvider`**

Append inside the `TelnyxTelephonyProvider` class in `src/sms/telnyx.ts` (before the closing brace):

```ts
  /* --- AI voice agents --- */

  async createVoiceAgent(input: VoiceAgentConfig): Promise<ProvisionedVoiceAgent> {
    const res = (await this.client.post("/ai/assistants", {
      name: input.name,
      instructions: input.instructions,
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.greeting ? { greeting: input.greeting } : {}),
      ...(input.tools ? { tools: input.tools.map((t) => ({ type: "webhook", name: t.name, description: t.description, url: t.webhookUrl })) } : {}),
    })) as { data?: { id?: string; name?: string } };
    return { agentId: String(res.data?.id ?? ""), name: String(res.data?.name ?? input.name) };
  }

  async updateVoiceAgent(
    input: { agentId: string } & Partial<VoiceAgentConfig>,
  ): Promise<ProvisionedVoiceAgent> {
    const res = (await this.client.post(`/ai/assistants/${input.agentId}`, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.greeting ? { greeting: input.greeting } : {}),
    })) as { data?: { id?: string; name?: string } };
    return { agentId: input.agentId, name: String(res.data?.name ?? input.name ?? "") };
  }

  async deleteVoiceAgent(input: { agentId: string }): Promise<void> {
    await this.client.del(`/ai/assistants/${input.agentId}`);
  }

  async attachAgentToNumber(input: { agentId: string; e164: string }): Promise<void> {
    // Bind the assistant as the inbound handler for the number's voice settings.
    await this.client.post(`/ai/assistants/${input.agentId}/phone_numbers`, {
      phone_number: input.e164,
    });
  }

  parseAgentEvent(rawBody: string, headers: Record<string, string>): VoiceAgentEvent {
    const p = this.requireVerified(rawBody, headers);
    const rawKind = String(p.event_type ?? p.kind ?? "");
    const kind: VoiceAgentEvent["kind"] =
      rawKind.includes("tool") ? "tool_call"
      : rawKind.includes("end") || rawKind.includes("hangup") ? "ended"
      : "transcript";
    return {
      agentId: String(p.assistant_id ?? p.agentId ?? ""),
      callId: String(p.call_control_id ?? p.callId ?? ""),
      kind,
      toolName: typeof p.tool_name === "string" ? p.tool_name : undefined,
      payload: p.payload && typeof p.payload === "object" ? (p.payload as Record<string, unknown>) : undefined,
      at: String(p.occurred_at ?? new Date().toISOString()),
    };
  }
```

- [ ] **Step 4: Add the factory + swap the singleton in `src/sms/provider.ts`**

In `src/sms/provider.ts`, replace the final block:

```ts
export const telephonyProvider: TelephonyProvider =
  new StubTelephonyProvider();
```

with:

```ts
/** The telephony provider the control plane uses. Auto-selects on env:
 *  `TELNYX_API_KEY` present → `TelnyxTelephonyProvider`; absent → the
 *  stub. Same one-file-swap pattern as `createMailProvider`. */
export function createTelephonyProvider(): TelephonyProvider {
  if (process.env.TELNYX_API_KEY) {
    return new TelnyxTelephonyProvider({
      apiKey: process.env.TELNYX_API_KEY,
      publicKey: process.env.TELNYX_PUBLIC_KEY,
      messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID,
      voiceConnectionId: process.env.TELNYX_VOICE_CONNECTION_ID,
    });
  }
  return new StubTelephonyProvider();
}

export const telephonyProvider: TelephonyProvider = createTelephonyProvider();
```

And add this import at the top of `src/sms/provider.ts` (with the other imports):

```ts
import { TelnyxTelephonyProvider } from "./telnyx";
```

- [ ] **Step 5: Run the smoke script; verify it passes**

Run: `npx tsx scripts/smoke-telnyx-phase-a.ts`
Expected: PASS — VoiceAgent + factory checks print `✓`, "all checks passed".

- [ ] **Step 6: Typecheck (now complete)**

Run: `npm run typecheck`
Expected: no errors — `TelnyxTelephonyProvider` now fully implements `TelephonyProvider`.

- [ ] **Step 7: Commit**

```bash
git add src/sms/telnyx.ts src/sms/provider.ts scripts/smoke-telnyx-phase-a.ts
git commit -m "feat(sms): Telnyx voice agents + env-gated createTelephonyProvider factory"
```

---

## Task A6: Graceful send errors + soft compliance gate

`cp.sendSms` currently calls `telephonyProvider.sendSms` with no try/catch. The stub never throws, but the live Telnyx adapter throws `TelnyxError` on any non-2xx — so an unregistered-A2P rejection or any 4xx would crash the route. This task wraps the call and maps a registration rejection to a clean `sms_compliance_required` error.

> **Intentional spec divergence (YAGNI):** the spec mentioned an `SMS_COMPLIANCE_MODE` env toggle. We do **not** pre-block sends, so there is nothing to "relax" — we attempt the send and map the carrier's response gracefully. Adding a no-op env var would be a placeholder, so it is omitted. The graceful-mapping behavior the spec actually requires is fully implemented here.

**Files:**
- Modify: `src/sms/telnyx.ts` (export a pure classifier)
- Modify: `src/core/control-plane.ts` (`sendSms` try/catch)
- Test: `scripts/smoke-telnyx-phase-a.ts` (extend)

- [ ] **Step 1: Add failing smoke assertions**

In `scripts/smoke-telnyx-phase-a.ts`, add (and call from `main()`):

```ts
import { TelnyxError, isComplianceRejection } from "../src/sms/telnyx";

function complianceClassifier(): void {
  console.log("--- Phase A — compliance rejection classifier ---");
  const reg = new TelnyxError(422, "/messages", JSON.stringify({ errors: [{ detail: "number is not registered for 10DLC campaign" }] }));
  check(isComplianceRejection(reg) === true, "10DLC rejection classified as compliance");
  const other = new TelnyxError(500, "/messages", "internal error");
  check(isComplianceRejection(other) === false, "500 is not a compliance rejection");
  check(isComplianceRejection(new Error("boom")) === false, "non-Telnyx error is not compliance");
}
```
Add `complianceClassifier();` in `main()`.

- [ ] **Step 2: Run; verify it fails**

Run: `npx tsx scripts/smoke-telnyx-phase-a.ts`
Expected: FAIL — `isComplianceRejection` is not exported from `../src/sms/telnyx`.

- [ ] **Step 3: Implement `isComplianceRejection` in `src/sms/telnyx.ts`**

Add after the `TelnyxError` class in `src/sms/telnyx.ts`:

```ts
/** True when a Telnyx error is a registration/compliance rejection
 *  (A2P/10DLC, brand/campaign, unregistered sender) rather than a
 *  transient failure — the control plane maps these to
 *  `sms_compliance_required`. */
export function isComplianceRejection(err: unknown): boolean {
  if (!(err instanceof TelnyxError)) return false;
  if (err.status < 400 || err.status >= 500) return false;
  return /10dlc|campaign|brand|registr|unregistered|not\s+registered/i.test(err.bodyText);
}
```

- [ ] **Step 4: Run; verify it passes**

Run: `npx tsx scripts/smoke-telnyx-phase-a.ts`
Expected: PASS — classifier checks print `✓`.

- [ ] **Step 5: Wrap the port call in `cp.sendSms`**

In `src/core/control-plane.ts`, in `sendSms` (≈line 1743), replace:

```ts
    const handoff = await telephonyProvider.sendSms({
      from: number.e164,
      to: input.to,
      body: input.body ?? "",
    });
```

with:

```ts
    let handoff;
    try {
      handoff = await telephonyProvider.sendSms({
        from: number.e164,
        to: input.to,
        body: input.body ?? "",
      });
    } catch (err) {
      if (isComplianceRejection(err)) return { error: "sms_compliance_required" };
      return { error: "carrier send failed" };
    }
```

Add the import to the existing imports at the top of `src/core/control-plane.ts`:

```ts
import { isComplianceRejection } from "../sms/telnyx";
```

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/sms/telnyx.ts src/core/control-plane.ts scripts/smoke-telnyx-phase-a.ts
git commit -m "feat(sms): graceful carrier send errors + compliance-rejection mapping"
```

---

# Phase B — Control plane: voice-agent wrappers + routes

## Task B1: Control-plane voice-agent wrappers + agent-event forwarding

`ControlPlane` takes a heavy `ControlPlaneDeps` (store, dataPlane, brain, and starts timers in its constructor), so it is NOT constructed in a smoke script. Strategy: the only non-trivial logic in the wrappers is the **tool-forward decision**, which we extract into a pure exported helper and smoke-test directly. The thin wrappers themselves are verified by `npm run typecheck` (they must compile against the real port + store) and exercised end-to-end through the running server in Task B2.

First, read `src/core/control-plane.ts` around the existing `receiveInboundSms` method (≈line 1811) to match its shape: how it resolves the project via `this.deps.store.getProject`, and how it returns `{ ok }` / `{ error }`. Mirror that style.

**Files:**
- Modify: `src/core/control-plane.ts`
- Test: `scripts/smoke-telnyx-phase-b.ts` (create)

- [ ] **Step 1: Create the failing smoke script (pure helper)**

Create `scripts/smoke-telnyx-phase-b.ts`:

```ts
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
```

- [ ] **Step 2: Run; verify it fails**

Run: `npx tsx scripts/smoke-telnyx-phase-b.ts`
Expected: FAIL — `agentToolForward` is not exported from `../src/core/control-plane`.

- [ ] **Step 3: Add the pure helper + the wrappers in `src/core/control-plane.ts`**

First add the type imports `VoiceAgentConfig`, `VoiceAgentEvent` to the existing `import type { ... } from "../sms/provider"` line. `telephonyProvider` is already imported at the top of this file.

Add this exported helper near the top-level helpers of the file (module scope, NOT inside the class):

```ts
/** Decide whether an agent event should be forwarded to the tenant's tool
 *  webhook, and build the request. Returns null when there is nothing to
 *  forward (not a tool call, or no tenant URL configured). Pure — unit-tested
 *  directly. */
export function agentToolForward(
  ev: VoiceAgentEvent,
  toolWebhookUrl: string | undefined,
): { url: string; body: Record<string, unknown> } | null {
  if (ev.kind !== "tool_call" || !toolWebhookUrl) return null;
  return {
    url: toolWebhookUrl,
    body: { toolName: ev.toolName, payload: ev.payload, callId: ev.callId },
  };
}
```

Then add these methods to the `ControlPlane` class, immediately after `receiveInboundSms` (≈line 1880), mirroring its project-resolution + `{ error }` return style:

```ts
  /** Create a hosted AI voice agent for a project. */
  async createVoiceAgent(
    projectId: string,
    input: VoiceAgentConfig,
  ): Promise<{ agentId: string; name: string } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    return telephonyProvider.createVoiceAgent(input);
  }

  /** Update a project's voice agent. */
  async updateVoiceAgent(
    projectId: string,
    agentId: string,
    input: Partial<VoiceAgentConfig>,
  ): Promise<{ agentId: string; name: string } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    return telephonyProvider.updateVoiceAgent({ agentId, ...input });
  }

  /** Delete a project's voice agent. */
  async deleteVoiceAgent(
    projectId: string,
    agentId: string,
  ): Promise<{ ok: true } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    await telephonyProvider.deleteVoiceAgent({ agentId });
    return { ok: true };
  }

  /** Bind a voice agent to the project's phone number. */
  async attachVoiceAgent(
    projectId: string,
    agentId: string,
  ): Promise<{ ok: true } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    const number = await this.deps.store.getPhoneNumberByProject(projectId);
    if (!number) return { error: "project has no phone number" };
    await telephonyProvider.attachAgentToNumber({ agentId, e164: number.e164 });
    return { ok: true };
  }

  /** Handle an agent/tool webhook: parse + (for tool calls) forward to the
   *  tenant's tool webhook. `opts` is test-injectable; production reads the
   *  per-project tool URL + uses global fetch. */
  async receiveAgentEvent(
    projectId: string,
    rawBody: string,
    headers: Record<string, string>,
    opts?: { fetchImpl?: typeof fetch; toolWebhookUrl?: string },
  ): Promise<{ ok: true; kind: VoiceAgentEvent["kind"] } | { error: string }> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) return { error: "project not found" };
    let ev: VoiceAgentEvent;
    try {
      ev = telephonyProvider.parseAgentEvent(rawBody, headers);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "invalid agent event" };
    }
    const fwd = agentToolForward(ev, opts?.toolWebhookUrl);
    if (fwd) {
      const f = opts?.fetchImpl ?? fetch;
      await f(fwd.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fwd.body),
      });
    }
    return { ok: true, kind: ev.kind };
  }
```

- [ ] **Step 4: Run the smoke script; verify it passes**

Run: `npx tsx scripts/smoke-telnyx-phase-b.ts`
Expected: PASS — "all checks passed".

- [ ] **Step 5: Typecheck + commit**

`npm run typecheck` proves the wrappers compile against the real `TelephonyProvider` port and `Store` — this is the wrappers' verification (they have no logic beyond resolve-and-delegate).

```bash
npm run typecheck
git add src/core/control-plane.ts scripts/smoke-telnyx-phase-b.ts
git commit -m "feat(cp): voice-agent wrappers + pure agent-event forward helper"
```

---

## Task B2: HTTP routes — voice-agent CRUD + agent-event webhook

**Files:**
- Modify: `src/index.ts`
- Test: manual route check via the running server (steps below)

First read `src/index.ts` around the existing SMS routes (≈lines 1288–1334) to match: the `assertProjectAccess` gate, `z` schema style, `rawBodyOf(request)`, and the auth-exempt inbound-webhook pattern.

- [ ] **Step 1: Add the route schemas + CRUD routes**

In `src/index.ts`, after the SMS inbox routes (≈line 1357), add:

```ts
const voiceAgentSchema = z.object({
  name: z.string().min(1),
  instructions: z.string().min(1),
  voice: z.string().optional(),
  greeting: z.string().optional(),
  tools: z
    .array(z.object({ name: z.string(), description: z.string(), webhookUrl: z.string().url() }))
    .optional(),
});

/** Create a voice agent for a project. */
app.post("/v1/projects/:id/voice/agents", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const parsed = voiceAgentSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
  const result = await cp.createVoiceAgent(id, parsed.data);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(201).send(result);
});

/** Update a voice agent. */
app.patch("/v1/projects/:id/voice/agents/:agentId", async (request, reply) => {
  const { id, agentId } = request.params as { id: string; agentId: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const parsed = voiceAgentSchema.partial().safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
  const result = await cp.updateVoiceAgent(id, agentId, parsed.data);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/** Delete a voice agent. */
app.delete("/v1/projects/:id/voice/agents/:agentId", async (request, reply) => {
  const { id, agentId } = request.params as { id: string; agentId: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const result = await cp.deleteVoiceAgent(id, agentId);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/** Bind a voice agent to the project's number. */
app.post("/v1/projects/:id/voice/agents/:agentId/attach", async (request, reply) => {
  const { id, agentId } = request.params as { id: string; agentId: string };
  const project = await assertProjectAccess(request, reply, id);
  if (!project) return;
  const result = await cp.attachVoiceAgent(id, agentId);
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});

/** Agent/tool webhook — carrier-called, so auth-exempt; the signature is
 *  verified inside the port when the payload is parsed. */
app.post("/v1/projects/:id/voice/webhook/telnyx/agent", async (request, reply) => {
  const { id } = request.params as { id: string };
  const result = await cp.receiveAgentEvent(
    id,
    rawBodyOf(request),
    request.headers as Record<string, string>,
  );
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});
```

> The webhook route must be exempt from the write-auth hook the same way `/v1/projects/:id/sms/inbound` is. Find how that exemption is registered (search `index.ts` for `sms/inbound` and the auth hook's allowlist) and add `voice/webhook/telnyx/agent` to the same allowlist.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual route smoke (server up, stub provider)**

Start the server (memory store, no Telnyx key → stub):

```bash
npx tsx src/index.ts &
```

Then (replace `<PROJECT_ID>` with a seeded project; reuse the demo seed flow the server logs on boot, or create one via the existing `/v1/projects` route):

```bash
curl -s -X POST localhost:8080/v1/projects/<PROJECT_ID>/voice/agents \
  -H 'content-type: application/json' \
  -d '{"name":"Bot","instructions":"Help."}'
```
Expected: `201` with `{"agentId":"agent_stub_...","name":"Bot"}`.

```bash
curl -s -X POST localhost:8080/v1/projects/<PROJECT_ID>/voice/webhook/telnyx/agent \
  -H 'content-type: application/json' \
  -d '{"agentId":"agent_stub_x","callId":"c1","kind":"transcript"}'
```
Expected: `200` with `{"ok":true,"kind":"transcript"}` (no signature needed against the stub).

Stop the server: `kill %1`.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(api): voice-agent CRUD + agent-event webhook routes"
```

---

## Task B3: Wire the per-project tool webhook URL into `receiveAgentEvent`

**Files:**
- Modify: `src/index.ts`, `src/core/control-plane.ts`
- Test: `scripts/smoke-telnyx-phase-b.ts` (already covers forwarding via injected opts)

In Task B1 the tool-webhook URL is injected via `opts` (test path). Production must read it from the project's stored config so the route passes a real URL.

First read how a project stores per-project config / secrets in `src/domain/types.ts` (the `Project` shape) and `src/domain/store.ts`. If the project already has a field for a tool/callback URL, use it; if not, this task adds one.

- [ ] **Step 1: Confirm/extend the project config**

If `Project` has no agent-tool URL field, add `voiceAgentToolUrl?: string` to the `Project` type in `src/domain/types.ts`, thread it through the memory store's `createProject`/`updateProject`, and (if `STORE=prisma` is used) add the column via a Prisma migration mirroring an existing nullable string field. If a suitable field already exists, skip this step and use it.

- [ ] **Step 2: Resolve the URL in the route**

In `src/index.ts`, change the agent webhook route to look up the project and pass the URL:

```ts
app.post("/v1/projects/:id/voice/webhook/telnyx/agent", async (request, reply) => {
  const { id } = request.params as { id: string };
  const project = await cp.getProject(id); // confirmed public — already used at index.ts:612
  const result = await cp.receiveAgentEvent(
    id,
    rawBodyOf(request),
    request.headers as Record<string, string>,
    { toolWebhookUrl: project?.voiceAgentToolUrl },
  );
  if ("error" in result) return reply.code(400).send(result);
  return reply.code(200).send(result);
});
```

> `cp.getProject(id)` is already public and used elsewhere in `index.ts`. `voiceAgentToolUrl` is the field added in Step 1; if you reused an existing project field instead, use that name here.

- [ ] **Step 3: Run Phase B smoke; typecheck**

Run: `npx tsx scripts/smoke-telnyx-phase-b.ts` → PASS (unchanged; still uses injected opts).
Run: `npm run typecheck` → no errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/core/control-plane.ts src/domain/types.ts src/domain/store.ts
git commit -m "feat(api): resolve per-project tool webhook URL for agent events"
```

---

## Task B4: Update the provider.ts status header + product copy

**Files:**
- Modify: `src/sms/provider.ts`, `cantila-console/src/data/product-copy.tsx`

- [ ] **Step 1: Refresh the `provider.ts` STATUS comment**

In `src/sms/provider.ts`, update the top-of-file `STATUS` block (lines ≈20–27) to reflect reality: the live Telnyx adapter now exists and is env-gated; the stub remains the offline default. Replace the "INFRASTRUCTURE-BLOCKED … follow-up once a carrier account exists" wording with a short note that `TelnyxTelephonyProvider` (in `./telnyx`) goes live on `TELNYX_API_KEY`, voice agents run on Telnyx AI Assistants, and the stub is the default for dev/test.

- [ ] **Step 2: Refresh the product copy line**

In `cantila-console/src/data/product-copy.tsx` (≈line 503), update the SMS status string from "Live carrier delivery arrives once Telnyx onboarding finishes." to reflect that the Telnyx adapter ships and activates on credentials. Keep the sentence factual and short.

- [ ] **Step 3: Typecheck both repos**

Run (control plane): `npm run typecheck` → no errors.
Run (console): `cd ../cantila-console && npm run typecheck` (or the console's check script) → no errors. `cd` back.

- [ ] **Step 4: Commit (two repos)**

```bash
git add src/sms/provider.ts
git commit -m "docs(sms): refresh telephony status — Telnyx adapter shipped"
# console is a separate git repo:
cd ../cantila-console && git add src/data/product-copy.tsx && git commit -m "copy: SMS Telnyx adapter shipped" && cd ../cantila-control-plane
```

---

## Final verification

- [ ] Run both smoke scripts end to end:
  - `npx tsx scripts/smoke-telnyx-phase-a.ts` → "all checks passed"
  - `npx tsx scripts/smoke-telnyx-phase-b.ts` → "all checks passed"
- [ ] `npm run typecheck` → no errors.
- [ ] Confirm with no env vars set, the server boots with the stub (`telephonyProvider.label === "Stub telephony"`), and with `TELNYX_API_KEY` set it selects Telnyx (`label === "Telnyx"`).

## Manual live cutover (requires a Telnyx account — out of this plan's automated scope)

Once you (the user) have a Telnyx account, set: `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_VOICE_CONNECTION_ID`. Point Telnyx messaging-profile + voice webhooks at the existing `/v1/projects/:id/sms/inbound`, the SMS status webhook, the voice inbound route, and `/v1/projects/:id/voice/webhook/telnyx/agent`. Verify a live send to a +63 and a +1 number, and an inbound message round-trip. US A2P at scale requires brand+campaign registration (driven by `registerA2pCampaign`). No code change is needed — the factory flips on env-var presence.
```
