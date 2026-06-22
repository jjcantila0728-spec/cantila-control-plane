import { test } from "node:test";
import assert from "node:assert/strict";
import { listLiveWorkflows, liveEnvFromProcess } from "./live-workflows";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response) as unknown as typeof fetch;
}

test("returns configured:false when env is missing", async () => {
  const r = await listLiveWorkflows("n8n", {}, fakeFetch(200, []));
  assert.equal(r.configured, false);
  assert.deepEqual(r.workflows, []);
});

test("maps n8n /api/v1/workflows rows", async () => {
  const r = await listLiveWorkflows(
    "n8n",
    { n8nBase: "https://n8n.cantila.app", n8nKey: "k" },
    fakeFetch(200, { data: [{ id: 7, name: "Lead sync", active: true, updatedAt: "2026-06-21T00:00:00Z" }] }),
  );
  assert.equal(r.configured, true);
  assert.deepEqual(r.workflows, [
    { id: "7", name: "Lead sync", active: true, updatedAt: "2026-06-21T00:00:00Z" },
  ]);
});

test("maps openclaw /api/runs rows (run = workflow)", async () => {
  const r = await listLiveWorkflows(
    "openclaw",
    { openclawBase: "https://openclaw.cantila.app", openclawKey: "ocat_x" },
    fakeFetch(200, [{ id: "run_1", goal: "Summarise inbox", status: "running", created_at: "2026-06-21T01:00:00Z" }]),
  );
  assert.deepEqual(r.workflows, [
    { id: "run_1", name: "Summarise inbox", active: true, updatedAt: "2026-06-21T01:00:00Z" },
  ]);
});

test("surfaces upstream errors as configured-but-errored, not empty", async () => {
  const r = await listLiveWorkflows(
    "n8n",
    { n8nBase: "https://n8n.cantila.app", n8nKey: "k" },
    fakeFetch(401, {}),
  );
  assert.equal(r.configured, true);
  assert.equal(r.error, "n8n 401");
  assert.deepEqual(r.workflows, []);
});

test("liveEnvFromProcess reads the four env vars", () => {
  const e = liveEnvFromProcess({
    N8N_BASE_URL: "https://n8n.cantila.app",
    N8N_API_KEY: "k",
    OPENCLAW_BASE_URL: "https://openclaw.cantila.app",
    OPENCLAW_API_KEY: "ocat_x",
  } as NodeJS.ProcessEnv);
  assert.equal(e.n8nBase, "https://n8n.cantila.app");
  assert.equal(e.openclawKey, "ocat_x");
});
