/* ============================================================
   Cantila MCP server — stdio entry point.
   Add it once to any Claude surface and "deploy to Cantila"
   becomes a native capability. (Plan §4.3.2 / §7.6.)
   ============================================================ */

import { InMemoryStore } from "../domain/store";
import { ownerAccountId } from "../lib/owner-account";
import { stubProvisioner } from "../dataplane/stub";
import { selectDataPlane } from "../dataplane/factory";
import { ControlPlane } from "../core/control-plane";
import { McpServer } from "./server";
import { cantilaTools } from "./tools";
import { StubStripeAdapter, type StripeAdapter } from "../billing/stripe";
import { StripeRealAdapter } from "../billing/stripe-real";
import { RuleBasedAiAnalyser } from "../ai/analyser";
import { buildAiAnalyser } from "../ai/factory";
import { createMobileBuildProvider } from "../mobile/build-provider";
import { createStorePublishers } from "../mobile/store-publisher";
import { MobileService } from "../mobile/service";

async function main(): Promise<void> {
  const ruleBased = new RuleBasedAiAnalyser();
  const aiAnalyser = buildAiAnalyser(ruleBased);
  const stripe: StripeAdapter = process.env.STRIPE_SECRET_KEY
    ? new StripeRealAdapter({
        secretKey: process.env.STRIPE_SECRET_KEY,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
      })
    : new StubStripeAdapter();
  const store = new InMemoryStore();
  const { dataPlane } = selectDataPlane(process.env, { store });
  const cp = new ControlPlane({
    store,
    provisioner: stubProvisioner,
    dataPlane,
    stripe,
    aiAnalyser,
  });

  // Seed one demo project so the server is self-demoable on the in-memory
  // store. In production every transport shares the platform database.
  const demo = await cp.createProject({
    name: "demo-app",
    accountId: ownerAccountId(),
    runtime: "node",
    region: "fsn1",
  });
  process.stderr.write(`[cantila-mcp] seeded demo project: ${demo.id}\n`);

  const mobileService = new MobileService({
    store,
    builder: createMobileBuildProvider(process.env),
    publishers: createStorePublishers(process.env),
    listFiles: async (projectId) => {
      const result = await cp.listProjectFiles(projectId);
      if (!result || "error" in result) return null;
      return result.files.filter((f) => f.type === "blob").map((f) => f.path);
    },
    readFile: async (projectId, path) => {
      const result = await cp.readProjectFile(projectId, path);
      if (!result || "error" in result) return null;
      return result.content;
    },
    artifactDir: process.env.MOBILE_ARTIFACT_DIR,
  });

  const server = new McpServer({ name: "cantila", version: "0.1.0" });
  for (const tool of cantilaTools(cp, { mobile: mobileService }))
    server.addTool(tool);
  server.start();
  process.stderr.write("[cantila-mcp] ready — JSON-RPC over stdio\n");
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[cantila-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
