/* ============================================================
   generateDockerfile — pure mapping from a detected stack to a
   canonical Dockerfile (or null when the repo owns its build).
   Fully offline.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDockerfile } from "./dockerfiles";
import type { StackInfo } from "../git/detect-stack";

const stack = (over: Partial<StackInfo>): StackInfo => ({
  buildPack: "nixpacks",
  port: 3000,
  stack: "Node.js",
  ...over,
});

test("repo that owns its build (Dockerfile) → null (build it verbatim)", () => {
  assert.equal(generateDockerfile(stack({ buildPack: "dockerfile" })), null);
});

test("docker-compose repo → null (build it verbatim)", () => {
  assert.equal(generateDockerfile(stack({ buildPack: "dockercompose" })), null);
});

test("Next.js → multi-stage node Dockerfile with cached npm ci layer", () => {
  const df = generateDockerfile(stack({ stack: "Next.js", port: 3000 }));
  assert.ok(df, "expected a Dockerfile");
  // Lockfiles copied + npm ci BEFORE the full source copy → cacheable layer.
  const ciIdx = df!.indexOf("RUN npm ci");
  const copyAllIdx = df!.indexOf("COPY . .");
  assert.ok(ciIdx > 0 && copyAllIdx > ciIdx, "npm ci must precede COPY . .");
  assert.match(df!, /COPY package\*\.json \.npmrc\* \.\//);
  assert.match(df!, /EXPOSE 3000/);
  assert.match(df!, /ENV PORT=3000/);
});

test("node deps stage copies .npmrc so npm ci honors legacy-peer-deps", () => {
  // The control-plane sets legacy-peer-deps=true in .npmrc (the Agent SDK
  // peer-wants zod 4 while the repo stays on zod 3). Without copying .npmrc
  // into the deps stage, `npm ci` hits the peer conflict and the build dies.
  const df = generateDockerfile(stack({ stack: "Next.js", port: 3000 }))!;
  const npmrcIdx = df.indexOf(".npmrc");
  const ciIdx = df.indexOf("RUN npm ci");
  assert.ok(npmrcIdx > 0, ".npmrc must be copied into the deps stage");
  assert.ok(npmrcIdx < ciIdx, ".npmrc must be copied before npm ci");
});

test("node port flows into EXPOSE/PORT", () => {
  const df = generateDockerfile(stack({ stack: "Node.js API", port: 8080 }));
  assert.match(df!, /EXPOSE 8080/);
  assert.match(df!, /ENV PORT=8080/);
});

test("Python → pip install layer on requirements", () => {
  const df = generateDockerfile(stack({ stack: "Python", port: 8000 }));
  assert.ok(df);
  assert.match(df!, /pip install/);
  assert.match(df!, /EXPOSE 8000/);
});

test("Go → builder stage downloads modules then builds a slim runtime", () => {
  const df = generateDockerfile(stack({ stack: "Go", port: 8080 }));
  assert.ok(df);
  assert.match(df!, /go mod download/);
  assert.match(df!, /FROM alpine/);
  assert.match(df!, /EXPOSE 8080/);
});

test("static site → nginx on 80", () => {
  const df = generateDockerfile(stack({ buildPack: "static", port: 80, stack: "Static site" }));
  assert.ok(df);
  assert.match(df!, /FROM nginx:alpine/);
  assert.match(df!, /EXPOSE 80/);
});

test("long-tail Nixpacks stacks (Ruby/PHP/Rust/…) → null, leave to Nixpacks", () => {
  assert.equal(generateDockerfile(stack({ stack: "Ruby", port: 3000 })), null);
  assert.equal(generateDockerfile(stack({ stack: "PHP", port: 80 })), null);
  assert.equal(generateDockerfile(stack({ stack: "Rust", port: 8080 })), null);
  assert.equal(generateDockerfile(stack({ stack: "Java", port: 8080 })), null);
});
