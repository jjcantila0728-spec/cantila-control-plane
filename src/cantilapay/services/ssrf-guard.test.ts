import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBlockedAddress,
  assertPublicHttpsUrl,
  SsrfBlockedError,
} from "./ssrf-guard";

test("isBlockedAddress flags private/loopback/link-local/metadata IPv4", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
});

test("isBlockedAddress allows real public IPv4", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34"]) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

test("isBlockedAddress handles IPv6 loopback/ULA/link-local and mapped v4", () => {
  assert.equal(isBlockedAddress("::1"), true);
  assert.equal(isBlockedAddress("fe80::1"), true);
  assert.equal(isBlockedAddress("fc00::1"), true);
  assert.equal(isBlockedAddress("::ffff:10.0.0.1"), true);
  assert.equal(isBlockedAddress("2001:4860:4860::8888"), false);
});

test("assertPublicHttpsUrl rejects non-https schemes", () => {
  assert.throws(() => assertPublicHttpsUrl("http://hooks.example.com"), SsrfBlockedError);
  assert.throws(() => assertPublicHttpsUrl("ftp://hooks.example.com"), SsrfBlockedError);
});

test("assertPublicHttpsUrl rejects internal hosts and private IP literals", () => {
  for (const url of [
    "https://localhost/hook",
    "https://127.0.0.1/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/hook",
    "https://192.168.1.10/hook",
    "https://[::1]/hook",
    "https://coolify.internal/hook",
  ]) {
    assert.throws(() => assertPublicHttpsUrl(url), SsrfBlockedError, url);
  }
});

test("assertPublicHttpsUrl accepts a normal public https endpoint", () => {
  const url = assertPublicHttpsUrl("https://hooks.example.com/cantilapay");
  assert.equal(url.hostname, "hooks.example.com");
});
