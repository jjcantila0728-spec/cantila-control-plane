/* ============================================================
   PlatformDeployer — deploy Cantila's OWN platform apps
   (control-plane, console, gritcode) through the control-plane's
   pipeline, with no Coolify (plan §19.12 Phase 2 follow-up).

   Tests assert pure command/parse assembly + the deploy
   orchestration against a fake SshRunner + fake ImageBuilder; no
   real SSH, no Docker. The faithful behaviour mirrors the box-side
   scripts/deploy-platform.sh: build a canonical image off-box, then
   swap the live container preserving its env, labels (verbatim —
   Coolify's Traefik routing must survive), network and restart
   policy.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PlatformDeployer,
  PLATFORM_APPS,
  parsePlatformContainer,
  buildPlatformRunCommand,
  type PlatformApp,
} from "./platform-deployer";
import type { SshRunner, SshRunOptions } from "../dataplane/ssh-exec";
import type { SshTarget } from "../dataplane/ssh-docker-stats";
import type { ImageBuilder, ImageBuildInput } from "./image-builder";
import { selectPlatformDeployer } from "../dataplane/factory";

interface Call {
  command: string;
  stdin?: string;
}

/** Recording fake SshRunner. `responses` maps a command substring → stdout. */
function fakeSsh(
  responses: { match: string; stdout: string }[] = [],
): { runner: SshRunner; calls: Call[]; target: SshTarget } {
  const calls: Call[] = [];
  const runner: SshRunner = {
    async run(_t: SshTarget, command: string, opts?: SshRunOptions) {
      calls.push({ command, stdin: opts?.stdin });
      const hit = responses.find((r) => command.includes(r.match));
      return hit ? hit.stdout : "";
    },
  };
  return { runner, calls, target: { host: "box1", user: "root" } };
}

/** Recording fake ImageBuilder that returns a fixed ref (or null to decline). */
function fakeBuilder(
  ref: string | null,
): { builder: ImageBuilder; inputs: ImageBuildInput[] } {
  const inputs: ImageBuildInput[] = [];
  const builder: ImageBuilder = {
    async build(input) {
      inputs.push(input);
      return ref === null ? null : { imageRef: ref };
    },
  };
  return { builder, inputs };
}

const CP_APP: PlatformApp = {
  name: "control-plane",
  imageId: "control-plane",
  container: "cp-container-abc",
  repoUrl: "https://github.com/acme/cantila-control-plane.git",
  branch: "master",
  appPort: 8090,
};

/** A representative `docker inspect --format '{{json .}}'` for a live
 *  Coolify-deployed platform container. */
const INSPECT_JSON = JSON.stringify({
  Image: "cp-container-abc:old",
  Config: {
    Image: "cp-container-abc:old",
    Env: [
      "PATH=/usr/bin",
      "NODE_ENV=production",
      "DATABASE_URL=postgres://internal/db",
      "CANTILA_BUILDER=buildx",
    ],
    Labels: {
      "traefik.enable": "true",
      "traefik.http.routers.https-cp.rule": "Host(`api.cantila.app`)",
      "traefik.http.routers.https-cp.entrypoints": "https",
      "traefik.http.routers.https-cp.tls.certresolver": "letsencrypt",
      "coolify.applicationId": "42",
    },
  },
  HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
  NetworkSettings: { Networks: { coolify: {} } },
});

// ---- selectPlatformDeployer (factory wiring) ----------------------------

test("selectPlatformDeployer returns null when fast builds are off", () => {
  assert.equal(selectPlatformDeployer({}), null);
  // buildx on but no build SSH node → can't swap, still null
  assert.equal(
    selectPlatformDeployer({
      CANTILA_BUILDER: "buildx",
      CANTILA_REGISTRY_URL: "git.cantila.app",
      GITEA_TOKEN: "t",
    }),
    null,
  );
});

test("selectPlatformDeployer builds a deployer when buildx + build SSH node are set", () => {
  const dep = selectPlatformDeployer({
    CANTILA_BUILDER: "buildx",
    CANTILA_REGISTRY_URL: "git.cantila.app",
    CANTILA_REGISTRY_USER: "u",
    GITEA_TOKEN: "t",
    CANTILA_BUILD_SSH_HOST: "10.0.1.1",
    CANTILA_BUILD_SSH_USER: "root",
  });
  assert.ok(dep instanceof PlatformDeployer);
});

// ---- PLATFORM_APPS registry ---------------------------------------------

test("PLATFORM_APPS registers the git-backed platform apps with valid shape", () => {
  // control-plane + console have GitHub remotes -> git-clone build path.
  assert.ok(PLATFORM_APPS["control-plane"]);
  assert.ok(PLATFORM_APPS["console"]);
  // gritcode has no git remote yet -> intentionally excluded (source-push only).
  assert.equal(PLATFORM_APPS["gritcode"], undefined);
  for (const [key, app] of Object.entries(PLATFORM_APPS)) {
    assert.equal(app.name, key, `name must match its key (${key})`);
    assert.ok(app.container.length > 0, `${key} needs a container name`);
    assert.match(app.repoUrl, /^https:\/\/.+\.git$/, `${key} needs a git url`);
    assert.ok(app.appPort > 0, `${key} needs an app port`);
  }
});

// ---- parsePlatformContainer ---------------------------------------------

test("parsePlatformContainer extracts env (denylist filtered), verbatim labels, network, restart", () => {
  const info = parsePlatformContainer(INSPECT_JSON);
  assert.ok(info);
  assert.deepEqual(info!.env, {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://internal/db",
    CANTILA_BUILDER: "buildx",
  });
  // labels kept verbatim — Coolify's Traefik routing must survive untouched
  assert.equal(
    info!.labels["traefik.http.routers.https-cp.entrypoints"],
    "https",
  );
  assert.equal(info!.labels["coolify.applicationId"], "42");
  assert.equal(info!.network, "coolify");
  assert.equal(info!.restart, "unless-stopped");
});

test("parsePlatformContainer returns null on unparseable input", () => {
  assert.equal(parsePlatformContainer("not json"), null);
});

// ---- buildPlatformRunCommand --------------------------------------------

test("buildPlatformRunCommand swaps container preserving env + labels verbatim", () => {
  const cmd = buildPlatformRunCommand({
    container: "cp-container-abc",
    imageRef: "reg/cantila/cantila-control-plane:deadbeef",
    env: { NODE_ENV: "production", DATABASE_URL: "postgres://x" },
    labels: {
      "traefik.enable": "true",
      "traefik.http.routers.https-cp.rule": "Host(`api.cantila.app`)",
    },
    network: "coolify",
    restart: "unless-stopped",
  });
  // pull, then remove-then-run, idempotent
  assert.match(cmd, /docker pull 'reg\/cantila\/cantila-control-plane:deadbeef'/);
  assert.match(cmd, /docker rm -f cp-container-abc/);
  assert.match(
    cmd,
    /docker run -d --name cp-container-abc --restart unless-stopped --network coolify/,
  );
  assert.match(cmd, /-e NODE_ENV='production'/);
  assert.match(cmd, /-e DATABASE_URL='postgres:\/\/x'/);
  // labels preserved verbatim (the Host rule's backticks survive single-quoting)
  assert.match(cmd, /-l 'traefik\.enable=true'/);
  assert.match(cmd, /-l 'traefik\.http\.routers\.https-cp\.rule=Host\(`api\.cantila\.app`\)'/);
  // image ref is last
  assert.ok(cmd.trimEnd().endsWith("'reg/cantila/cantila-control-plane:deadbeef'"));
});

test("buildPlatformRunCommand adds a registry login when creds are given", () => {
  const cmd = buildPlatformRunCommand({
    container: "c",
    imageRef: "reg/x:1",
    env: {},
    labels: {},
    network: "coolify",
    restart: "unless-stopped",
    registry: { url: "git.cantila.app", user: "u", password: "p" },
  });
  assert.match(cmd, /docker login git\.cantila\.app -u 'u' -p 'p'/);
});

// ---- PlatformDeployer.deploy --------------------------------------------

test("deploy builds the app image from its repo, then swaps the live container", async () => {
  const { runner, calls, target } = fakeSsh([
    { match: "docker inspect", stdout: INSPECT_JSON },
  ]);
  const { builder, inputs } = fakeBuilder(
    "reg/cantila/cantila-control-plane:deadbeef",
  );
  const dep = new PlatformDeployer({
    ssh: runner,
    node: target,
    imageBuilder: builder,
    apps: { "control-plane": CP_APP },
  });

  const result = await dep.deploy("control-plane", "deadbeefcafe");

  // built from the app's repo with the app's id + ref
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.project.id, "control-plane");
  assert.equal(inputs[0]!.project.repoUrl, CP_APP.repoUrl);
  assert.equal(inputs[0]!.ref, "deadbeefcafe");

  // inspected the live container, then ran the swap
  assert.ok(calls.some((c) => c.command.includes("docker inspect cp-container-abc")));
  const swap = calls.find((c) => c.command.includes("docker run -d --name cp-container-abc"));
  assert.ok(swap, "expected a swap run command");
  // the freshly-built image is what gets run, env preserved
  assert.match(swap!.command, /reg\/cantila\/cantila-control-plane:deadbeef/);
  assert.match(swap!.command, /-e DATABASE_URL=/);

  assert.deepEqual(result, {
    app: "control-plane",
    imageRef: "reg/cantila/cantila-control-plane:deadbeef",
    container: "cp-container-abc",
  });
});

test("deploy throws for an unknown app", async () => {
  const { runner, target } = fakeSsh();
  const { builder } = fakeBuilder("x");
  const dep = new PlatformDeployer({
    ssh: runner,
    node: target,
    imageBuilder: builder,
    apps: { "control-plane": CP_APP },
  });
  await assert.rejects(() => dep.deploy("nope"), /unknown platform app/i);
});

test("deploy throws a clear error when the builder declines", async () => {
  const { runner, target } = fakeSsh([
    { match: "docker inspect", stdout: INSPECT_JSON },
  ]);
  const { builder } = fakeBuilder(null);
  const dep = new PlatformDeployer({
    ssh: runner,
    node: target,
    imageBuilder: builder,
    apps: { "control-plane": CP_APP },
  });
  await assert.rejects(() => dep.deploy("control-plane"), /could not build/i);
});

test("deploy throws when the live container cannot be inspected", async () => {
  const { runner, target } = fakeSsh([{ match: "docker inspect", stdout: "" }]);
  const { builder } = fakeBuilder("reg/x:1");
  const dep = new PlatformDeployer({
    ssh: runner,
    node: target,
    imageBuilder: builder,
    apps: { "control-plane": CP_APP },
  });
  await assert.rejects(() => dep.deploy("control-plane"), /cannot inspect/i);
});
