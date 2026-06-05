import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProtectedResourceMetadata,
  buildAuthServerMetadata,
  MCP_RESOURCE_PATH,
  WELL_KNOWN_PROTECTED_RESOURCE,
  WELL_KNOWN_PROTECTED_RESOURCE_MCP,
} from "./oauth";

const BASE = "https://api.cantila.app";

test("protected-resource metadata points at the MCP resource + AS", () => {
  const m = buildProtectedResourceMetadata(BASE);
  assert.equal(m.resource, "https://api.cantila.app/v1/mcp");
  assert.deepEqual(m.authorization_servers, ["https://api.cantila.app"]);
});

test("path-insertion protected-resource metadata path matches RFC 9728 §3.1", () => {
  // For a resource at `<base>/v1/mcp`, the host inserts the well-known
  // segment BEFORE the resource path. This is the URL claude.ai requests
  // first; if it 401s, OAuth discovery never starts and the connector is
  // stuck on `authenticate`. It must equal bare-well-known + resource-path.
  assert.equal(
    WELL_KNOWN_PROTECTED_RESOURCE_MCP,
    `${WELL_KNOWN_PROTECTED_RESOURCE}${MCP_RESOURCE_PATH}`,
  );
  assert.equal(
    WELL_KNOWN_PROTECTED_RESOURCE_MCP,
    "/.well-known/oauth-protected-resource/v1/mcp",
  );
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
