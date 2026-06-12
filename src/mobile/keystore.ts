/* ============================================================
   Android signing keystore management (spec 2026-06-11 §3).

   Every mobile project gets a Cantila-managed keystore, generated
   on first build and reused forever after — Play Store identity is
   the certificate, so losing or rotating it would orphan the app.

   - Generated with `keytool` when a JDK is on the build host;
     otherwise a deterministic placeholder is stored so the rest of
     the pipeline (stub builds, store rows, console UI) still works
     end-to-end. `generated:false` marks placeholders; a real build
     host regenerates only if the stored material is a placeholder.
   - Stored on the Project row, encrypted at rest with
     CANTILA_SECRET_KEY (same enc.v1 envelope as mailbox SMTP creds).
   ============================================================ */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "../domain/types";
import type { Store } from "../domain/store";
import { decryptSecret, encryptSecret } from "../lib/secrets";

const execFileAsync = promisify(execFile);

export interface KeystoreMaterial {
  /** PKCS12 keystore, base64. */
  keystoreB64: string;
  storePassword: string;
  keyPassword: string;
  alias: string;
  /** True when minted by keytool; false for the placeholder fallback. */
  generated: boolean;
}

/** Android package name for a project slug: `app.cantila.<slug>` with the
 *  slug sanitized to a valid Java package segment (lowercase, [a-z0-9_],
 *  digit-leading segments prefixed with "a"). */
export function defaultApplicationId(slug: string): string {
  let segment = slug.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!segment) segment = "app";
  if (/^[0-9]/.test(segment)) segment = `a${segment}`;
  return `app.cantila.${segment}`;
}

interface EnsureKeystoreOptions {
  /** Test hook — set false to skip the keytool attempt. Default true. */
  allowKeytool?: boolean;
}

/** Return the project's keystore, generating + persisting it on first use. */
export async function ensureKeystore(
  project: Project,
  store: Store,
  options: EnsureKeystoreOptions = {},
): Promise<KeystoreMaterial> {
  if (project.androidKeystore && project.androidKeystoreSecret) {
    const secret = JSON.parse(decryptSecret(project.androidKeystoreSecret)) as {
      storePassword: string;
      keyPassword: string;
      alias: string;
      generated: boolean;
    };
    return {
      keystoreB64: decryptSecret(project.androidKeystore),
      ...secret,
    };
  }

  const storePassword = randomBytes(18).toString("base64url");
  const keyPassword = randomBytes(18).toString("base64url");
  const alias = "cantila";

  let keystoreB64: string | null = null;
  let generated = false;
  if (options.allowKeytool !== false) {
    keystoreB64 = await generateWithKeytool(project, alias, storePassword, keyPassword);
    generated = keystoreB64 !== null;
  }
  if (!keystoreB64) {
    // Placeholder — lets the stub pipeline run end-to-end on hosts without
    // a JDK. Never used to sign a real artifact: the Docker build provider
    // regenerates real material (generated:true) before its first build.
    keystoreB64 = Buffer.from(
      `CANTILA-PLACEHOLDER-KEYSTORE ${project.id}`,
    ).toString("base64");
  }

  await store.updateProject(project.id, {
    androidKeystore: encryptSecret(keystoreB64),
    androidKeystoreSecret: encryptSecret(
      JSON.stringify({ storePassword, keyPassword, alias, generated }),
    ),
  });

  return { keystoreB64, storePassword, keyPassword, alias, generated };
}

/** Mint a real PKCS12 keystore via keytool. Returns null when keytool is
 *  missing or fails — callers fall back to the placeholder. */
async function generateWithKeytool(
  project: Project,
  alias: string,
  storePassword: string,
  keyPassword: string,
): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "cantila-keystore-"));
  const path = join(dir, "release.p12");
  try {
    await execFileAsync("keytool", [
      "-genkeypair",
      "-v",
      "-keystore", path,
      "-storetype", "PKCS12",
      "-alias", alias,
      "-keyalg", "RSA",
      "-keysize", "2048",
      "-validity", "10950",
      "-storepass", storePassword,
      "-keypass", keyPassword,
      "-dname", `CN=${project.slug}, O=Cantila, C=US`,
    ]);
    return (await readFile(path)).toString("base64");
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
