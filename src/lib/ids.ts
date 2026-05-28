/* ID and timestamp helpers. */

import { randomUUID } from "node:crypto";

/** Short prefixed id, e.g. id("dpl") -> "dpl_3f9a2c1b7e4d8a06". */
export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Current time as an ISO-8601 string. */
export function now(): string {
  return new Date().toISOString();
}

/** Opaque secret token for credentials (64 hex chars). */
export function secret(): string {
  return (randomUUID() + randomUUID()).replace(/-/g, "");
}
