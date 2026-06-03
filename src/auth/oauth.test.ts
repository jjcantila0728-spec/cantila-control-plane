import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProtectedResourceMetadata,
  buildAuthServerMetadata,
} from "./oauth";

const BASE = "https://api.cantila.app";

test("protected-resource metadata points at the MCP resource + AS", () => {
  const m = buildProtectedResourceMetadata(BASE);
  assert.equal(m.resource, "https://api.cantila.app/v1/mcp");
  assert.deepEqual(m.authorization_servers, ["https://api.cantila.app"]);
});

test("authorization-server metadata advertises the OAuth endpoints + PKCE", () => {
  const m = buildAuthServerMetadata(BASE);
  assert.equal(m.issuer, BASE);
  assert.equal(m.authorization_endpoint, `${BASE}/authorize`);
  assert.equal(m.token_endpoint, `${BASE}/token`);
  assert.equal(m.registration_endpoint, `${BASE}/register`);
  assert.deepEqual(m.code_challenge_methods_supported, ["S256"]);
  assert.ok(m.grant_types_supported.includes("authorization_code"));
  assert.deepEqual(m.token_endpoint_auth_methods_supported, ["none"]);
});
