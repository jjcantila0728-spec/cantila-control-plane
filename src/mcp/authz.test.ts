/* Authorization tests for the MCP tool surface (HTTP transport).
 *
 * The HTTP mount of the MCP server (`POST /v1/mcp`) must NOT let an
 * authenticated tenant act on another tenant's projects, nor default
 * account-scoped reads to the owner account. These tests exercise the
 * real path: cantilaTools(cp) -> McpServer.handleRpc(message, ctx). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "./server";
import { cantilaTools } from "./tools";
import { ownerAccountId } from "../lib/owner-account";
import type { ControlPlane } from "../core/control-plane";

function buildServer(cp: ControlPlane): McpServer {
  const server = new McpServer({ name: "test", version: "0" });
  for (const tool of cantilaTools(cp)) server.addTool(tool);
  return server;
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
  ctx?: { accountId: string | null },
): Promise<{ isError?: boolean; content: Array<{ text: string }> }> {
  const response = await server.handleRpc(
    { id: 1, method: "tools/call", params: { name, arguments: args } },
    ctx,
  );
  assert.ok(response && "result" in response, "expected a JSON-RPC result");
  return response.result as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
}

test("remote caller cannot set env on another account's project", async () => {
  let setEnvCalled = false;
  const cp = {
    getProject: async (id: string) =>
      id === "proj_B" ? { id, accountId: "acc_B" } : null,
    canActOnAccount: async () => false,
    setEnv: async () => {
      setEnvCalled = true;
      return null;
    },
  } as unknown as ControlPlane;

  const result = await callTool(
    buildServer(cp),
    "cantila_set_env",
    { projectId: "proj_B", key: "K", value: "V" },
    { accountId: "acc_A" },
  );

  assert.equal(setEnvCalled, false, "must not reach the mutation");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /different account/i);
});

test("remote caller's list_projects is scoped to their account, not the owner", async () => {
  let scopedTo = "";
  const cp = {
    listProjects: async (accountId: string) => {
      scopedTo = accountId;
      return [];
    },
  } as unknown as ControlPlane;

  await callTool(buildServer(cp), "cantila_list_projects", {}, {
    accountId: "acc_A",
  });

  assert.equal(scopedTo, "acc_A");
});

test("remote caller cannot list another account's projects via the accountId arg", async () => {
  let listed = false;
  const cp = {
    listProjects: async () => {
      listed = true;
      return [];
    },
    canActOnAccount: async () => false,
  } as unknown as ControlPlane;

  const result = await callTool(
    buildServer(cp),
    "cantila_list_projects",
    { accountId: "acc_B" },
    { accountId: "acc_A" },
  );

  assert.equal(listed, false);
  assert.equal(result.isError, true);
});

test("local stdio caller (no context) keeps the legacy owner default", async () => {
  let scopedTo = "";
  const cp = {
    listProjects: async (accountId: string) => {
      scopedTo = accountId;
      return [];
    },
  } as unknown as ControlPlane;

  await callTool(buildServer(cp), "cantila_list_projects", {});

  assert.equal(scopedTo, ownerAccountId());
});

test("remote non-owner cannot read the global agents brain", async () => {
  let ticked = false;
  const cp = {
    tickAgents: async () => {
      ticked = true;
    },
    agentsStatus: () => ({
      paused: false,
      pendingProposals: [],
      recentActions: [],
    }),
  } as unknown as ControlPlane;

  const result = await callTool(
    buildServer(cp),
    "cantila_agents_status",
    { fresh: true },
    { accountId: "acc_not_the_owner" },
  );

  assert.equal(ticked, false, "must not run a global tick for a tenant");
  assert.equal(result.isError, true);
});
