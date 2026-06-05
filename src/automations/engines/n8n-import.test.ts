/* Unit tests for parseN8nWorkflowExport — the n8n "Download" JSON ->
   Cantila canonical WorkflowGraph importer (plan §4.10, import path). */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseN8nWorkflowExport } from "./n8n";

/** A minimal but representative n8n export: a manual trigger wired into
 *  an HTTP Request node, carrying an `id` (which import must drop). */
const SAMPLE_EXPORT = {
  id: "abc123",
  name: "Daily digest",
  active: true,
  nodes: [
    {
      name: "On clicking 'execute'",
      type: "n8n-nodes-base.manualTrigger",
      typeVersion: 1,
      position: [240, 300],
      parameters: {},
    },
    {
      name: "HTTP Request",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4,
      position: [460, 300],
      parameters: { url: "https://example.com", method: "GET" },
    },
  ],
  connections: {
    "On clicking 'execute'": {
      main: [[{ node: "HTTP Request", type: "main", index: 0 }]],
    },
  },
  meta: { instanceId: "xyz" },
};

test("converts nodes into canonical graph nodes", () => {
  const graph = parseN8nWorkflowExport(SAMPLE_EXPORT);
  assert.equal(graph.nodes.length, 2);
  const http = graph.nodes.find((n) => n.id === "HTTP Request");
  assert.ok(http);
  assert.equal(http.type, "n8n:n8n-nodes-base.httpRequest");
  assert.deepEqual(http.position, { x: 460, y: 300 });
  assert.equal(http.parameters.url, "https://example.com");
});

test("converts connections into canonical edges", () => {
  const graph = parseN8nWorkflowExport(SAMPLE_EXPORT);
  assert.equal(graph.edges.length, 1);
  const edge = graph.edges[0];
  assert.equal(edge.fromNodeId, "On clicking 'execute'");
  assert.equal(edge.toNodeId, "HTTP Request");
});

test("derives a manual trigger from the trigger node", () => {
  const graph = parseN8nWorkflowExport(SAMPLE_EXPORT);
  assert.equal(graph.triggers.length, 1);
  assert.equal(graph.triggers[0].kind, "manual");
});

test("strips the incoming id so import creates a fresh workflow", () => {
  const graph = parseN8nWorkflowExport(SAMPLE_EXPORT);
  assert.equal(graph.id, "");
});

test("keeps the export name when present", () => {
  const graph = parseN8nWorkflowExport(SAMPLE_EXPORT);
  assert.equal(graph.name, "Daily digest");
});

test("defaults the name when the export omits it", () => {
  const graph = parseN8nWorkflowExport({ nodes: [], connections: {} });
  assert.equal(graph.name, "Imported workflow");
});

test("round-trips the opaque meta bag", () => {
  const graph = parseN8nWorkflowExport(SAMPLE_EXPORT);
  assert.deepEqual(graph.meta, { instanceId: "xyz" });
});

test("throws on a non-object input", () => {
  assert.throws(() => parseN8nWorkflowExport("not json"), /workflow/i);
  assert.throws(() => parseN8nWorkflowExport(null), /workflow/i);
});

test("throws when nodes is missing or not an array", () => {
  assert.throws(() => parseN8nWorkflowExport({ name: "x" }), /nodes/i);
  assert.throws(
    () => parseN8nWorkflowExport({ nodes: "nope" }),
    /nodes/i,
  );
});
