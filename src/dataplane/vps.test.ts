/* ============================================================
   VpsDataPlane — direct-to-VPS deploys over SSH + Docker
   (plan 2026-06-18 §Stage 2). Asserts command assembly and the
   deploy lifecycle through a fake SshRunner. No real host.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VpsDataPlane,
  buildRunCommand,
  buildMigrateCommand,
  traefikLabels,
  parseHostRule,
  mergeHosts,
  parseInspect,
  containerName,
} from "./vps";
import type { ImageBuilder } from "../deploy/image-builder";
import type { SshRunner } from "./ssh-exec";
import type { SshTarget } from "./ssh-docker-stats";
import type { Project } from "../domain/types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "prj_abc",
    accountId: "acc_1",
    slug: "demo",
    name: "demo",
    runtime: "node",
    region: "fsn1",
    status: "live",
    vcpu: 1,
    memoryMb: 1024,
    diskGb: 5,
    alwaysOn: false,
    autoSleep: true,
    desiredInstances: 1,
    minInstances: 1,
    maxInstances: 1,
    autoDeploy: false,
    platform: false,
    repoUrl: "https://github.com/acme/demo",
    appPort: 3000,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Project;
}

interface FakeSsh {
  runner: SshRunner;
  calls: { target: SshTarget; command: string }[];
}

function fakeSsh(responder?: (cmd: string) => string): FakeSsh {
  const calls: FakeSsh["calls"] = [];
  const runner: SshRunner = {
    async run(target, command) {
      calls.push({ target, command });
      return responder ? responder(command) : "";
    },
  };
  return { runner, calls };
}

const builder = (imageRef: string | null): ImageBuilder => ({
  async build() {
    return imageRef ? { imageRef } : null;
  },
});

const NODE: SshTarget = { host: "10.0.0.1", user: "root" };

const plane = (over: Partial<ConstructorParameters<typeof VpsDataPlane>[0]> = {}) => {
  const ssh = fakeSsh();
  const dp = new VpsDataPlane({
    nodes: [NODE],
    ssh: ssh.runner,
    imageBuilder: builder("git.cantila.app/cantila/cantila-prj_abc:abc"),
    ...over,
  });
  return { dp, ssh };
};

// --- pure helpers ----------------------------------------------------

test("buildRunCommand pulls, removes the old container, and runs with Traefik labels", () => {
  const cmd = buildRunCommand({
    container: "cantila-prj_abc",
    imageRef: "reg/cantila-prj_abc:abc",
    env: { FOO: "bar" },
    hosts: ["demo.cantila.app"],
    network: "cantila",
    entrypoint: "websecure",
    certResolver: "le",
    port: 3000,
  });
  assert.match(cmd, /docker network create cantila/);
  assert.match(cmd, /docker pull 'reg\/cantila-prj_abc:abc'/);
  assert.match(cmd, /docker rm -f cantila-prj_abc/);
  assert.match(cmd, /docker run -d --name cantila-prj_abc/);
  assert.match(cmd, /--restart unless-stopped/);
  assert.match(cmd, /--network cantila/);
  assert.match(cmd, /traefik\.enable=true/);
  assert.match(cmd, /Host\(`demo\.cantila\.app`\)/);
  assert.match(cmd, /loadbalancer\.server\.port=3000/);
  assert.match(cmd, /-e FOO='bar'/);
});

test("buildRunCommand includes docker login only when registry creds are set", () => {
  const withAuth = buildRunCommand({
    container: "c",
    imageRef: "r:1",
    env: {},
    hosts: ["h"],
    network: "n",
    entrypoint: "websecure",
    certResolver: "le",
    port: 80,
    registry: { url: "git.cantila.app", user: "u", password: "p" },
  });
  assert.match(withAuth, /docker login git\.cantila\.app -u 'u' -p 'p'/);

  const noAuth = buildRunCommand({
    container: "c",
    imageRef: "r:1",
    env: {},
    hosts: ["h"],
    network: "n",
    entrypoint: "websecure",
    certResolver: "le",
    port: 80,
  });
  assert.doesNotMatch(noAuth, /docker login/);
});

test("buildMigrateCommand runs the prisma apply in a one-off container", () => {
  const cmd = buildMigrateCommand({
    imageRef: "reg/app:1",
    env: { DATABASE_URL: "postgres://x" },
  });
  assert.match(cmd, /docker run --rm/);
  assert.match(cmd, /-e DATABASE_URL='postgres:\/\/x'/);
  assert.match(cmd, /prisma migrate deploy/);
  assert.match(cmd, /prisma db push/);
});

test("traefikLabels joins multiple hosts into one router rule", () => {
  const labels = traefikLabels({
    container: "c",
    hosts: ["a.com", "b.com"],
    entrypoint: "websecure",
    certResolver: "le",
    port: 3000,
  }).join(" ");
  assert.match(labels, /Host\(`a\.com`\) \|\| Host\(`b\.com`\)/);
});

test("parseHostRule / mergeHosts round-trip", () => {
  assert.deepEqual(parseHostRule("Host(`a.com`) || Host(`b.com`)"), ["a.com", "b.com"]);
  assert.deepEqual(mergeHosts(["a.com"], "B.com"), ["a.com", "b.com"]);
  assert.deepEqual(mergeHosts(["a.com"], "a.com"), ["a.com"]);
});

test("parseInspect extracts image, app env (filtering defaults), and hosts", () => {
  const raw = JSON.stringify({
    Config: {
      Image: "reg/app:1",
      Env: ["PATH=/usr/bin", "DATABASE_URL=postgres://x", "FOO=bar"],
      Labels: { "traefik.http.routers.cantila-prj_abc.rule": "Host(`demo.cantila.app`)" },
    },
  });
  const info = parseInspect(raw)!;
  assert.equal(info.image, "reg/app:1");
  assert.deepEqual(info.env, { DATABASE_URL: "postgres://x", FOO: "bar" });
  assert.ok(!("PATH" in info.env));
  assert.deepEqual(info.hosts, ["demo.cantila.app"]);
});

// --- lifecycle through the adapter -----------------------------------

test("buildImage uses the off-box builder for a git source", async () => {
  const { dp } = plane();
  const out = await dp.buildImage(makeProject(), { kind: "git", ref: "abc" });
  assert.equal(out.imageRef, "git.cantila.app/cantila/cantila-prj_abc:abc");
});

test("buildImage throws a clear error when the builder declines (no fallback on VPS)", async () => {
  const { dp } = plane({ imageBuilder: builder(null) });
  await assert.rejects(
    () => dp.buildImage(makeProject(), { kind: "git", ref: "abc" }),
    /declined to build/,
  );
});

test("buildImage passes a prebuilt uploaded image through", async () => {
  const { dp } = plane();
  const out = await dp.buildImage(makeProject(), { kind: "upload", ref: "ghcr.io/acme/app:1" });
  assert.equal(out.imageRef, "ghcr.io/acme/app:1");
});

test("startContainer SSHes the run command to the project's node", async () => {
  const { dp, ssh } = plane();
  await dp.startContainer(makeProject(), "reg/app:abc", "10.0.0.1", { K: "v" });
  assert.equal(ssh.calls.length, 1);
  assert.equal(ssh.calls[0]!.target.host, "10.0.0.1");
  assert.match(ssh.calls[0]!.command, /docker run -d --name cantila-prj_abc/);
});

test("route returns the slug host on the apex", async () => {
  const { dp } = plane({ apexDomain: "cantila.app" });
  assert.deepEqual(await dp.route(makeProject()), { url: "https://demo.cantila.app" });
});

test("runMigration returns ok on success and captures failure", async () => {
  const okSsh = fakeSsh(() => "applied 3 migrations");
  const okDp = new VpsDataPlane({ nodes: [NODE], ssh: okSsh.runner, imageBuilder: builder("x") });
  assert.deepEqual(await okDp.runMigration(makeProject(), "reg/app:1", {}), {
    ok: true,
    log: "applied 3 migrations",
  });

  const failSsh: SshRunner = {
    async run() {
      throw new Error("P1001 cannot reach database");
    },
  };
  const failDp = new VpsDataPlane({ nodes: [NODE], ssh: failSsh, imageBuilder: builder("x") });
  const res = await failDp.runMigration(makeProject(), "reg/app:1", {});
  assert.equal(res.ok, false);
  assert.match(res.log!, /P1001/);
});

test("destroyApp removes the container and never throws", async () => {
  const { dp, ssh } = plane();
  await dp.destroyApp(makeProject());
  assert.match(ssh.calls[0]!.command, /docker rm -f cantila-prj_abc/);
});

test("attachDomain re-runs the container with the merged host set", async () => {
  const inspect = JSON.stringify({
    Config: {
      Image: "reg/app:abc",
      Env: ["DATABASE_URL=postgres://x"],
      Labels: { "traefik.http.routers.cantila-prj_abc.rule": "Host(`demo.cantila.app`)" },
    },
  });
  const ssh = fakeSsh((cmd) => (cmd.includes("inspect") ? inspect : ""));
  const dp = new VpsDataPlane({ nodes: [NODE], ssh: ssh.runner, imageBuilder: builder("x") });
  await dp.attachDomain(makeProject(), "shop.acme.com");

  const runCall = ssh.calls.find((c) => c.command.includes("docker run -d"));
  assert.ok(runCall, "expected a re-run");
  assert.match(runCall!.command, /Host\(`demo\.cantila\.app`\) \|\| Host\(`shop\.acme\.com`\)/);
  assert.match(runCall!.command, /-e DATABASE_URL='postgres:\/\/x'/);
});

test("schedule pins a project to a deterministic node", async () => {
  const nodes: SshTarget[] = [{ host: "a" }, { host: "b" }, { host: "c" }];
  const dp = new VpsDataPlane({ nodes, ssh: fakeSsh().runner, imageBuilder: builder("x") });
  const first = await dp.schedule(makeProject());
  const again = await dp.schedule(makeProject());
  assert.equal(first.nodeId, again.nodeId);
  assert.ok(["a", "b", "c"].includes(first.nodeId));
});

test("containerName is reversible from the project id", () => {
  assert.equal(containerName({ id: "prj_xyz" }), "cantila-prj_xyz");
});
