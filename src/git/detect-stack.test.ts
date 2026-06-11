/* ============================================================
   detectStack — pure mapping from a repo file listing to the
   Coolify build configuration. Fully offline.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStack } from "./detect-stack";

test("docker-compose at root wins over everything", async () => {
  const s = await detectStack(["docker-compose.yml", "Dockerfile", "package.json"]);
  assert.equal(s.buildPack, "dockercompose");
});

test("Dockerfile at root → dockerfile build pack, port from EXPOSE", async () => {
  const s = await detectStack(["Dockerfile", "src/main.go"], async (p) =>
    p === "Dockerfile" ? "FROM golang:1.22\nEXPOSE 9090\nCMD [\"./app\"]" : null,
  );
  assert.equal(s.buildPack, "dockerfile");
  assert.equal(s.port, 9090);
});

test("Dockerfile without EXPOSE defaults to 3000", async () => {
  const s = await detectStack(["Dockerfile"], async () => "FROM node:20");
  assert.equal(s.buildPack, "dockerfile");
  assert.equal(s.port, 3000);
});

test("nested Dockerfile does NOT trigger dockerfile build", async () => {
  const s = await detectStack(["deploy/Dockerfile", "package.json"]);
  assert.equal(s.buildPack, "nixpacks");
  assert.equal(s.port, 3000);
});

test("package.json → nixpacks on 3000, framework label from deps", async () => {
  const s = await detectStack(["package.json", "next.config.js"], async (p) =>
    p === "package.json" ? JSON.stringify({ dependencies: { next: "14.0.0" } }) : null,
  );
  assert.equal(s.buildPack, "nixpacks");
  assert.equal(s.port, 3000);
  assert.equal(s.stack, "Next.js");
});

test("backend manifests pick the framework's conventional port", async () => {
  assert.equal((await detectStack(["requirements.txt", "app.py"])).port, 8000);
  assert.equal((await detectStack(["go.mod", "main.go"])).port, 8080);
  assert.equal((await detectStack(["Gemfile"])).port, 3000);
  assert.equal((await detectStack(["composer.json"])).port, 80);
  assert.equal((await detectStack(["Cargo.toml"])).port, 8080);
  assert.equal((await detectStack(["pom.xml"])).port, 8080);
  assert.equal((await detectStack(["mix.exs"])).port, 4000);
  assert.equal((await detectStack(["api.csproj"])).port, 8080);
  assert.equal((await detectStack(["deno.json"])).port, 8000);
});

test("bare index.html with no manifest → static on 80", async () => {
  const s = await detectStack(["index.html", "css/style.css", "js/app.js"]);
  assert.equal(s.buildPack, "static");
  assert.equal(s.port, 80);
});

test("index.html alongside package.json is NOT static (it has a build)", async () => {
  const s = await detectStack(["index.html", "package.json"]);
  assert.equal(s.buildPack, "nixpacks");
});

test("unknown tree falls back to nixpacks:3000 (legacy behavior)", async () => {
  const s = await detectStack(["README.md", "notes.txt"]);
  assert.equal(s.buildPack, "nixpacks");
  assert.equal(s.port, 3000);
});

test("malformed package.json keeps generic Node label without throwing", async () => {
  const s = await detectStack(["package.json"], async () => "{not json");
  assert.equal(s.stack, "Node.js");
});
