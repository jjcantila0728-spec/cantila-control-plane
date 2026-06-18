/* ============================================================
   BuildxImageBuilder — control flow over an injected BuildHost.
   Asserts the buildx command, cache refs, tag scheme, and the
   decline cases (no repo / compose / long-tail stack). No Docker.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BuildxImageBuilder,
  noopImageBuilder,
  imageTag,
  type BuildHost,
  type BuildProject,
} from "./image-builder";

interface Recorder {
  host: BuildHost;
  execs: { cmd: string; args: string[]; cwd: string }[];
  writes: { rel: string; content: string }[];
  cleaned: string[];
}

/** A recording fake. `files` is the repo file listing detectStack sees;
 *  `read` supplies file contents (e.g. package.json). */
function fakeHost(files: string[], read: Record<string, string> = {}): Recorder {
  const execs: Recorder["execs"] = [];
  const writes: Recorder["writes"] = [];
  const cleaned: string[] = [];
  const host: BuildHost = {
    async mkWorkdir(label) {
      return `/tmp/${label}`;
    },
    async clone() {},
    async listFiles() {
      return files;
    },
    async readFile(_dir, rel) {
      return read[rel] ?? null;
    },
    async writeFile(_dir, rel, content) {
      writes.push({ rel, content });
    },
    async exec(cmd, args, cwd) {
      execs.push({ cmd, args, cwd });
    },
    async cleanup(dir) {
      cleaned.push(dir);
    },
  };
  return { host, execs, writes, cleaned };
}

const project = (over: Partial<BuildProject> = {}): BuildProject => ({
  id: "prj_abc",
  repoUrl: "https://github.com/acme/site",
  branch: "main",
  buildPack: undefined,
  appPort: undefined,
  ...over,
});

test("noop builder always declines", async () => {
  assert.equal(await noopImageBuilder.build({ project: project() }), null);
});

test("no repo → decline (data plane handles placeholder/pushed image)", async () => {
  const r = fakeHost([]);
  const b = new BuildxImageBuilder(r.host, { registry: "git.cantila.app" });
  assert.equal(await b.build({ project: project({ repoUrl: undefined }) }), null);
  assert.equal(r.execs.length, 0);
});

test("Next.js repo → writes generated Dockerfile and buildx --push with cache", async () => {
  const r = fakeHost(["package.json", "next.config.js"], {
    "package.json": JSON.stringify({ dependencies: { next: "14" } }),
  });
  const b = new BuildxImageBuilder(r.host, {
    registry: "git.cantila.app",
    namespace: "cantila",
  });
  const out = await b.build({ project: project(), ref: "abcdef1234567890" });

  assert.ok(out, "expected an image ref");
  assert.equal(out!.imageRef, "git.cantila.app/cantila/cantila-prj_abc:abcdef123456");

  // Generated Dockerfile written (not the repo's own).
  assert.ok(r.writes.some((w) => w.rel === "Dockerfile.cantila"));

  const buildx = r.execs.find((e) => e.cmd === "docker");
  assert.ok(buildx, "expected a docker buildx exec");
  const args = buildx!.args.join(" ");
  assert.match(args, /buildx build/);
  assert.match(args, /-f Dockerfile\.cantila/);
  assert.match(args, /--push/);
  assert.match(args, /--cache-from type=registry,ref=git\.cantila\.app\/cantila\/cantila-prj_abc:buildcache/);
  assert.match(args, /--cache-to type=registry,ref=.*:buildcache,mode=max/);
  // Workdir cleaned up.
  assert.deepEqual(r.cleaned, ["/tmp/build-prj_abc"]);
});

test("repo with its own Dockerfile → buildx WITHOUT -f (use repo Dockerfile)", async () => {
  const r = fakeHost(["Dockerfile", "src/main.go"], {
    Dockerfile: "FROM golang:1.22\nEXPOSE 9090",
  });
  const b = new BuildxImageBuilder(r.host, { registry: "reg.local" });
  const out = await b.build({ project: project() });
  assert.ok(out);
  assert.equal(r.writes.length, 0, "must not write a Dockerfile when the repo has one");
  const args = r.execs[0]!.args.join(" ");
  assert.doesNotMatch(args, /-f /);
});

test("docker-compose repo → decline (let the data plane handle compose)", async () => {
  const r = fakeHost(["docker-compose.yml", "package.json"]);
  const b = new BuildxImageBuilder(r.host, { registry: "reg.local" });
  assert.equal(await b.build({ project: project() }), null);
  assert.equal(r.execs.length, 0);
});

test("long-tail Nixpacks stack (Ruby) → decline, fall back to Nixpacks", async () => {
  const r = fakeHost(["Gemfile", "config.ru"]);
  const b = new BuildxImageBuilder(r.host, { registry: "reg.local" });
  assert.equal(await b.build({ project: project() }), null);
  assert.equal(r.execs.length, 0);
});

test("imageTag: SHA shortened to 12, missing → latest, junk stripped", () => {
  assert.equal(imageTag(undefined), "latest");
  assert.equal(imageTag("abcdef1234567890abcdef"), "abcdef123456");
  assert.equal(imageTag("feat/new ui"), "featnewui");
  assert.equal(imageTag("..--"), "latest");
});
