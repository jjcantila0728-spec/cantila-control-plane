/* ============================================================
   Cantila MCP server — stdio entry point.
   Add it once to any Claude surface and "deploy to Cantila"
   becomes a native capability. (Plan §4.3.2 / §7.6.)
   ============================================================ */

import { InMemoryStore } from "../domain/store";
import { stubProvisioner } from "../dataplane/stub";
import { selectDataPlane } from "../dataplane/factory";
import { ControlPlane } from "../core/control-plane";
import { McpServer } from "./server";
import { cantilaTools } from "./tools";
import { StubStripeAdapter, type StripeAdapter } from "../billing/stripe";
import { StripeRealAdapter } from "../billing/stripe-real";
import { RuleBasedAiAnalyser } from "../ai/analyser";
import { ClaudeAiAnalyser } from "../ai/claude";

async function main(): Promise<void> {
  const ruleBased = new RuleBasedAiAnalyser();
  const aiAnalyser = process.env.ANTHROPIC_API_KEY
    ? new ClaudeAiAnalyser({ fallback: ruleBased })
    : ruleBased;
  const stripe: StripeAdapter = process.env.STRIPE_SECRET_KEY
    ? new StripeRealAdapter({
        secretKey: process.env.STRIPE_SECRET_KEY,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
      })
    : new StubStripeAdapter();
  const { dataPlane } = selectDataPlane();
  const cp = new ControlPlane({
    store: new InMemoryStore(),
    provisioner: stubProvisioner,
    dataPlane,
    stripe,
    aiAnalyser,
  });

  // Seed one demo project so the server is self-demoable on the in-memory
  // store. In production every transport shares the platform database.
  const demo = await cp.createProject({
    name: "demo-app",
    accountId: "acc_demo",
    runtime: "node",
    region: "fsn1",
  });
  process.stderr.write(`[cantila-mcp] seeded demo project: ${demo.id}\n`);

  const server = new McpServer({ name: "cantila", version: "0.1.0" });
  for (const tool of cantilaTools(cp)) server.addTool(tool);
  server.start();
  process.stderr.write("[cantila-mcp] ready — JSON-RPC over stdio\n");
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[cantila-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
