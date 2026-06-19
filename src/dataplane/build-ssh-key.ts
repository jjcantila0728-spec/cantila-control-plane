/* ============================================================
   Build-SSH-key materialization.

   The fast-build path (CANTILA_BUILDER=buildx + a remote build host) needs
   an SSH private key on disk — the factory reads CANTILA_BUILD_SSH_KEY_PATH,
   a *file path*. But the control-plane container's filesystem is rebuilt on
   every Coolify deploy, so a key copied in by hand would not survive.

   This shim lets the key persist via a Coolify *environment variable*
   (which does survive): when CANTILA_BUILD_SSH_KEY_B64 holds the base64 of
   the private key, we decode it to a 0600 file at boot and point
   CANTILA_BUILD_SSH_KEY_PATH at it — before the factory reads the env.

   Pure logic + injected writer so the boot wiring stays unit-testable.
   ============================================================ */

import { writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MaterializeBuildSshKeyDeps {
  /** Writes the key file with 0600 perms. Injected for tests. */
  writeKey: (path: string, contents: string) => void;
  /** Directory for the key file. Defaults to the OS temp dir. */
  tmpDir?: string;
}

/** Decode CANTILA_BUILD_SSH_KEY_B64 to a private-key file and set
 *  CANTILA_BUILD_SSH_KEY_PATH on `env`. Mutates `env`. Returns the written
 *  path, or null when not configured / an explicit path already wins.
 *  Throws when the value does not decode to a PEM private key (a mis-set
 *  secret should fail loud at boot, not produce a silently broken key). */
export function materializeBuildSshKey(
  env: NodeJS.ProcessEnv,
  deps: MaterializeBuildSshKeyDeps,
): string | null {
  const b64 = env.CANTILA_BUILD_SSH_KEY_B64?.trim();
  if (!b64) return null;
  // An explicit on-disk path (e.g. a Coolify file mount) takes precedence.
  if (env.CANTILA_BUILD_SSH_KEY_PATH?.trim()) return null;

  const key = Buffer.from(b64, "base64").toString("utf8");
  if (!key.includes("PRIVATE KEY")) {
    throw new Error(
      "CANTILA_BUILD_SSH_KEY_B64 did not decode to a PEM private key",
    );
  }
  // OpenSSH refuses a key file without a trailing newline.
  const contents = key.endsWith("\n") ? key : key + "\n";
  const path = join(deps.tmpDir ?? tmpdir(), "cantila_build_ssh_key");
  deps.writeKey(path, contents);
  env.CANTILA_BUILD_SSH_KEY_PATH = path;
  return path;
}

/** Production writer — 0600 file. */
export function writeKeyFile(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600); // umask can loosen the create mode; force it.
}
