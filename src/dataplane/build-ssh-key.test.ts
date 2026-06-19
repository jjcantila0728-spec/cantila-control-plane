/* ============================================================
   materializeBuildSshKey — decode-to-file + env wiring, injected writer.
   No real filesystem.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { materializeBuildSshKey } from "./build-ssh-key";

const PEM =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----\n";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function capture() {
  const writes: Record<string, string> = {};
  return {
    writes,
    writeKey: (path: string, contents: string) => {
      writes[path] = contents;
    },
  };
}

test("decodes the key to a file and points KEY_PATH at it", () => {
  const env: NodeJS.ProcessEnv = { CANTILA_BUILD_SSH_KEY_B64: b64(PEM) };
  const cap = capture();
  const path = materializeBuildSshKey(env, { writeKey: cap.writeKey, tmpDir: "/tmp" });

  assert.equal(path, join("/tmp", "cantila_build_ssh_key"));
  assert.equal(env.CANTILA_BUILD_SSH_KEY_PATH, path);
  assert.ok(cap.writes[path!].includes("PRIVATE KEY"));
  assert.ok(cap.writes[path!].endsWith("\n"));
});

test("appends a trailing newline when the decoded key lacks one", () => {
  const env: NodeJS.ProcessEnv = {
    CANTILA_BUILD_SSH_KEY_B64: b64(PEM.trimEnd()),
  };
  const cap = capture();
  const path = materializeBuildSshKey(env, { writeKey: cap.writeKey, tmpDir: "/tmp" });
  assert.ok(cap.writes[path!].endsWith("\n"));
});

test("returns null when not configured", () => {
  const env: NodeJS.ProcessEnv = {};
  const cap = capture();
  assert.equal(materializeBuildSshKey(env, { writeKey: cap.writeKey }), null);
  assert.deepEqual(cap.writes, {});
});

test("an explicit KEY_PATH wins — no decode, no write", () => {
  const env: NodeJS.ProcessEnv = {
    CANTILA_BUILD_SSH_KEY_B64: b64(PEM),
    CANTILA_BUILD_SSH_KEY_PATH: "/mounted/key",
  };
  const cap = capture();
  assert.equal(materializeBuildSshKey(env, { writeKey: cap.writeKey }), null);
  assert.equal(env.CANTILA_BUILD_SSH_KEY_PATH, "/mounted/key");
  assert.deepEqual(cap.writes, {});
});

test("throws when the value does not decode to a private key", () => {
  const env: NodeJS.ProcessEnv = { CANTILA_BUILD_SSH_KEY_B64: b64("not a key") };
  const cap = capture();
  assert.throws(
    () => materializeBuildSshKey(env, { writeKey: cap.writeKey }),
    /PEM private key/,
  );
  assert.deepEqual(cap.writes, {});
});
