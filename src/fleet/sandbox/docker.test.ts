import { test } from "node:test";
import assert from "node:assert/strict";
import { DockerSandboxRunner } from "./docker";

type ExecCall = { cmd: string; args: string[] };

/** Build a runner with fake primitives. `probeStatuses` is consumed in order;
 *  the last value repeats. A virtual clock advances on sleep so timeout paths
 *  are deterministic and instant. */
function makeRunner(opts: {
  probeStatuses?: number[];
  fileExists?: boolean;
  throwOnArgIncludes?: string; // make exec throw when an arg contains this
} = {}) {
  const calls: ExecCall[] = [];
  const probes = [...(opts.probeStatuses ?? [200])];
  let clock = 0;
  const runner = new DockerSandboxRunner({
    exec: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (opts.throwOnArgIncludes && args.some((a) => a.includes(opts.throwOnArgIncludes!))) {
        throw new Error("boom");
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    fileExists: async () => opts.fileExists ?? false,
    probe: async () => (probes.length > 1 ? probes.shift()! : probes[0]),
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
    pollIntervalMs: 1000,
  });
  return { runner, calls };
}

const flat = (calls: ExecCall[]) => calls.map((c) => [c.cmd, ...c.args].join(" "));

test("passes when the product boots and health probe returns 200", async () => {
  const { runner, calls } = makeRunner({ probeStatuses: [200] });
  const res = await runner.run({ workspaceDir: "/ws", stack: "next", projectId: "p1" });
  assert.equal(res.passed, true);
  assert.notEqual(res.skipped, true);
  const joined = flat(calls).join("\n");
  assert.match(joined, /npm ci/, "should install deps");
  assert.match(joined, /npm start/, "should boot the product");
});

test("fails when health probe never returns 200 before timeout", async () => {
  const { runner } = makeRunner({ probeStatuses: [0], fileExists: false });
  const res = await runner.run({ workspaceDir: "/ws", stack: "node", projectId: "p1", timeoutMs: 5000 });
  assert.equal(res.passed, false);
  assert.match(res.detail, /health|boot|probe/i);
});

test("skips prisma migrate when there is no schema", async () => {
  const { runner, calls } = makeRunner({ fileExists: false });
  await runner.run({ workspaceDir: "/ws", stack: "node", projectId: "p1" });
  assert.doesNotMatch(flat(calls).join("\n"), /prisma.*migrate/i);
});

test("runs prisma migrate deploy when a schema is present", async () => {
  const { runner, calls } = makeRunner({ fileExists: true });
  await runner.run({ workspaceDir: "/ws", stack: "next", projectId: "p1" });
  assert.match(flat(calls).join("\n"), /prisma migrate deploy/i);
});

test("always tears down containers even when a step throws", async () => {
  const { runner, calls } = makeRunner({ throwOnArgIncludes: "npm start" });
  const res = await runner.run({ workspaceDir: "/ws", stack: "node", projectId: "p1" });
  assert.equal(res.passed, false);
  assert.match(flat(calls).join("\n"), /rm -f/i, "teardown must run in finally");
});

test("does not leak host secrets into the sandbox container env", async () => {
  const SECRET = "super-secret-prod-value-xyz";
  process.env.CANTILA_SECRET_KEY = SECRET;
  try {
    const { runner, calls } = makeRunner({ probeStatuses: [200], fileExists: true });
    await runner.run({ workspaceDir: "/ws", stack: "next", projectId: "p1" });
    const joined = flat(calls).join("\n");
    assert.ok(!joined.includes(SECRET), "host secret must never reach the container");
  } finally {
    delete process.env.CANTILA_SECRET_KEY;
  }
});
