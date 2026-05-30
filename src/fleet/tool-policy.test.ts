import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_TOOLS, DISALLOWED_BASH } from "./tool-policy";

test("allow-list includes core tools + Agent delegation", () => {
  for (const t of ["Read", "Write", "Edit", "Bash", "Agent"]) assert.ok(ALLOWED_TOOLS.includes(t));
});
test("deny-list blocks prod-mutating + exfil commands", () => {
  for (const frag of ["rm", "sudo", "mv", "git push", "docker", "kubectl", "npm publish", "curl", "wget"]) {
    assert.ok(DISALLOWED_BASH.some((d) => d.includes(frag)), `missing deny for ${frag}`);
  }
});
