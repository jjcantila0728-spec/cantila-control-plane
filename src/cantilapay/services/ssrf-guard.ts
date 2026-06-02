/* ============================================================
   SSRF guard for tenant-supplied outbound URLs (Cantilapay
   webhook endpoints). A tenant registers a delivery URL we then
   fetch from inside the trusted network — so the URL must be a
   public https endpoint, never loopback / private / link-local /
   cloud-metadata. We validate twice: synchronously at create time
   (scheme + literal-IP), and again at send time by resolving DNS
   (to defeat rebinding, where a name resolves public at create and
   private at delivery).
   ============================================================ */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = ((n << 8) | octet) >>> 0;
  }
  return n >>> 0;
}

function inV4Range(n: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (n & mask) === (b & mask);
}

function v4Blocked(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → fail closed
  return (
    inV4Range(n, "0.0.0.0", 8) || // "this" network
    inV4Range(n, "10.0.0.0", 8) || // private
    inV4Range(n, "100.64.0.0", 10) || // CGNAT
    inV4Range(n, "127.0.0.0", 8) || // loopback
    inV4Range(n, "169.254.0.0", 16) || // link-local incl. 169.254.169.254 metadata
    inV4Range(n, "172.16.0.0", 12) || // private
    inV4Range(n, "192.0.0.0", 24) || // IETF protocol assignments
    inV4Range(n, "192.168.0.0", 16) || // private
    inV4Range(n, "198.18.0.0", 15) || // benchmarking
    inV4Range(n, "224.0.0.0", 4) || // multicast
    inV4Range(n, "240.0.0.0", 4) // reserved (incl. 255.255.255.255)
  );
}

function v6Blocked(ip: string): boolean {
  const addr = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) — classify by the embedded v4 address.
  const mapped = addr.match(/(?:::ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return v4Blocked(mapped[1]);
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  const head = addr.split(":")[0];
  if (/^f[cd]/.test(head)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local
  if (/^fe[cdef]/.test(head)) return true; // fec0::/10 deprecated site-local
  return false;
}

/** True if `ip` is a private / loopback / link-local / reserved address that
 *  an outbound webhook must never reach. Non-IP input fails closed (true). */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) return v6Blocked(ip);
  return true;
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

/** Synchronous create-time validation: require https and reject obviously
 *  internal hosts / private IP literals. Throws SsrfBlockedError on failure;
 *  returns the parsed URL on success. */
export function assertPublicHttpsUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("invalid webhook URL");
  }
  if (url.protocol !== "https:") {
    throw new SsrfBlockedError("webhook URL must use https");
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw new SsrfBlockedError("webhook URL host is not allowed");
  }
  const literal =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(literal) && isBlockedAddress(literal)) {
    throw new SsrfBlockedError(
      "webhook URL points to a private or reserved address",
    );
  }
  return url;
}

/** Send-time validation: resolve the host and reject if ANY resolved address
 *  is private/reserved. Catches DNS rebinding between registration and
 *  delivery. Throws SsrfBlockedError on failure. */
export async function assertUrlResolvesToPublic(url: URL): Promise<void> {
  const host =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new SsrfBlockedError(
        "webhook URL points to a private or reserved address",
      );
    }
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError("could not resolve webhook host");
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError("could not resolve webhook host");
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError(
        "webhook host resolves to a private or reserved address",
      );
    }
  }
}
