/* ============================================================
   sshBuildHost — the BuildHost that runs git + docker buildx on a
   remote build node over SSH (plan §19.12 Phase 1, Path B). Tests
   assert command + stdin assembly against a fake SshRunner; no real
   SSH, no Docker.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { sshBuildHost } from "./image-builder-ssh-host";
import type { SshRunner, SshRunOptions } from "../dataplane/ssh-exec";
import type { SshTarget } from "../dataplane/ssh-docker-stats";

interface Call {
  command: string;
  stdin?: string;
}

/** A recording fake SshRunner. `responses` maps a substring of the command
 *  to the stdout it should return; unmatched commands resolve to "". A
 *  `rejects` substring makes the matching command reject (e.g. cat-on-miss). */
function fakeSsh(opts: {
  responses?: { match: string; stdout: string }[];
  rejects?: string[];
} = {}): { runner: SshRunner; calls: Call[]; target: SshTarget } {
  const calls: Call[] = [];
  const runner: SshRunner = {
    async run(_target: SshTarget, command: string, runOpts?: SshRunOptions) {
      calls.push({ command, stdin: runOpts?.stdin });
      if (opts.rejects?.some((r) => command.includes(r))) {
        throw new Error("remote command failed");
      }
      const hit = opts.responses?.find((r) => command.includes(r.match));
      return hit ? hit.stdout : "";
    },
  };
  return { runner, calls, target: { host: "build.local", user: "root" } };
}

test("mkWorkdir → mktemp -d, returns trimmed remote path", async () => {
  const { runner, calls, target } = fakeSsh({
    responses: [{ match: "mktemp", stdout: "/tmp/tmp.AbC123\n" }],
  });
  const host = sshBuildHost({ ssh: runner, target });
  const dir = await host.mkWorkdir("build-prj_1");
  assert.equal(dir, "/tmp/tmp.AbC123");
  assert.match(calls[0]!.command, /mktemp -d/);
});

test("clone → shallow git clone of branch into dir, paths escaped", async () => {
  const { runner, calls, target } = fakeSsh();
  const host = sshBuildHost({ ssh: runner, target });
  await host.clone("https://github.com/acme/site", "main", "/tmp/wd");
  const cmd = calls[0]!.command;
  assert.match(cmd, /git clone --depth 1 --branch 'main'/);
  assert.match(cmd, /'https:\/\/github\.com\/acme\/site'/);
  assert.match(cmd, /'\/tmp\/wd'/);
});

test("listFiles → find, strips ./, prunes .git and node_modules", async () => {
  const { runner, calls, target } = fakeSsh({
    responses: [
      { match: "find", stdout: "./package.json\n./src/index.ts\n\n" },
    ],
  });
  const host = sshBuildHost({ ssh: runner, target });
  const files = await host.listFiles("/tmp/wd");
  assert.deepEqual(files, ["package.json", "src/index.ts"]);
  const cmd = calls[0]!.command;
  assert.match(cmd, /find \. -type f/);
  assert.match(cmd, /\.git/);
  assert.match(cmd, /node_modules/);
});

test("readFile → cat, returns content; missing file → null", async () => {
  const present = fakeSsh({
    responses: [{ match: "cat ", stdout: "FROM node:20\n" }],
  });
  const h1 = sshBuildHost({ ssh: present.runner, target: present.target });
  assert.equal(await h1.readFile("/tmp/wd", "Dockerfile"), "FROM node:20\n");

  const missing = fakeSsh({ rejects: ["cat "] });
  const h2 = sshBuildHost({ ssh: missing.runner, target: missing.target });
  assert.equal(await h2.readFile("/tmp/wd", "nope"), null);
});

test("writeFile → pipes content over stdin into cat > path", async () => {
  const { runner, calls, target } = fakeSsh();
  const host = sshBuildHost({ ssh: runner, target });
  await host.writeFile("/tmp/wd", "Dockerfile.cantila", "FROM nginx\n");
  assert.match(calls[0]!.command, /cat > '\/tmp\/wd\/Dockerfile\.cantila'/);
  assert.equal(calls[0]!.stdin, "FROM nginx\n");
});

test("exec buildx build → one-time login + builder create, then build with --builder", async () => {
  const { runner, calls, target } = fakeSsh();
  const host = sshBuildHost({
    ssh: runner,
    target,
    registry: "git.cantila.app",
    registryUser: "u",
    registryPassword: "p",
    builderName: "cantila",
  });
  await host.exec(
    "docker",
    ["buildx", "build", "-t", "img:tag", "--push", "."],
    "/tmp/wd",
  );

  const all = calls.map((c) => c.command).join("\n");
  // Prep ran: docker login + buildx create (idempotent inspect-or-create).
  assert.match(all, /docker login 'git\.cantila\.app' -u 'u' -p 'p'/);
  assert.match(all, /docker buildx (inspect|create)[^\n]*cantila/);
  // Build ran in the workdir with the named builder.
  const build = calls.find((c) => c.command.includes("--builder"));
  assert.ok(build, "expected a buildx build command");
  assert.match(build!.command, /cd '\/tmp\/wd' &&/);
  assert.match(build!.command, /'--builder' 'cantila'/);
  assert.match(build!.command, /'--push'/);

  // Second exec must NOT re-run prep (memoised).
  const before = calls.length;
  await host.exec("docker", ["buildx", "build", "."], "/tmp/wd");
  const loginsAfter = calls
    .slice(before)
    .filter((c) => c.command.includes("docker login")).length;
  assert.equal(loginsAfter, 0, "login must not run on the second build");
});

test("exec non-buildx command → cd into cwd and run verbatim, no prep", async () => {
  const { runner, calls, target } = fakeSsh();
  const host = sshBuildHost({ ssh: runner, target });
  await host.exec("echo", ["hello world"], "/tmp/wd");
  assert.equal(calls.length, 1, "no prep for non-buildx commands");
  assert.match(calls[0]!.command, /cd '\/tmp\/wd' && 'echo' 'hello world'/);
});

test("cleanup → rm -rf, ignores remote failure", async () => {
  const { runner, calls, target } = fakeSsh({ rejects: ["rm -rf"] });
  const host = sshBuildHost({ ssh: runner, target });
  await host.cleanup("/tmp/wd"); // must not throw
  assert.match(calls[0]!.command, /rm -rf '\/tmp\/wd'/);
});
