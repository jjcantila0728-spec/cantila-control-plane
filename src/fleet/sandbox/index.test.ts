import { test } from "node:test";
import assert from "node:assert/strict";
import { getSandboxRunner } from "./index";
import { NoopSandboxRunner } from "./noop";
import { DockerSandboxRunner } from "./docker";

test("getSandboxRunner returns the Noop runner by default", () => {
  const prev = process.env.FLEET_SANDBOX;
  delete process.env.FLEET_SANDBOX;
  assert.ok(getSandboxRunner() instanceof NoopSandboxRunner);
  if (prev === undefined) delete process.env.FLEET_SANDBOX; else process.env.FLEET_SANDBOX = prev;
});

test("getSandboxRunner returns the Docker runner when FLEET_SANDBOX=docker", () => {
  const prev = process.env.FLEET_SANDBOX;
  process.env.FLEET_SANDBOX = "docker";
  assert.ok(getSandboxRunner() instanceof DockerSandboxRunner);
  if (prev === undefined) delete process.env.FLEET_SANDBOX; else process.env.FLEET_SANDBOX = prev;
});
