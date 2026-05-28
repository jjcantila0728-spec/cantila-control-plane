/* ============================================================
   Secret encryption-at-rest (plan §5.4 / §15.1).

   Per-account secrets — today the BYOC Anthropic API key — are
   encrypted before they touch the store. This is envelope-style
   encryption: a master key supplied via the CANTILA_SECRET_KEY
   environment variable derives an AES-256-GCM data key; the IV,
   ciphertext and auth tag are stored together as one string.

   Safe-by-default + backward-compatible:
   - When CANTILA_SECRET_KEY is unset, `encryptSecret` is a no-op
     pass-through — the value is stored in plaintext, exactly as
     before this module existed. Encryption is therefore opt-in.
   - `decryptSecret` recognises the `enc.v1.` envelope prefix. A
     value without it is treated as plaintext and returned as-is,
     so accounts whose keys were stored before encryption was
     enabled keep working with no migration.

   A production deployment sets CANTILA_SECRET_KEY to a long
   random string (held in a secrets manager / KMS). Full KMS-side
   key rotation is out of scope here — this is the at-rest
   envelope, not a rotation story.
   ============================================================ */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/** Envelope prefix — version-tagged so the format can evolve. */
const ENVELOPE_PREFIX = "enc.v1.";

/** Derive a 32-byte AES-256 key from CANTILA_SECRET_KEY, or null when
 *  the env var is unset/empty (encryption disabled — pass-through mode). */
function masterKey(): Buffer | null {
  const raw = process.env.CANTILA_SECRET_KEY;
  if (!raw || raw.length === 0) return null;
  // SHA-256 of the configured secret → a fixed 32-byte AES-256 key.
  return createHash("sha256").update(raw, "utf8").digest();
}

/** True when `value` is an `enc.v1.` envelope produced by `encryptSecret`. */
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}

/** Encrypt a secret for storage. Returns an `enc.v1.<iv>.<ct>.<tag>`
 *  envelope when CANTILA_SECRET_KEY is set; otherwise returns `plain`
 *  unchanged (encryption is opt-in — see the file header). */
export function encryptSecret(plain: string): string {
  const key = masterKey();
  if (!key) return plain;
  // Already an envelope — don't double-encrypt.
  if (isEncryptedSecret(plain)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString("hex")}.${ciphertext.toString("hex")}.${tag.toString("hex")}`;
}

/** Decrypt a stored secret. A plaintext value (no `enc.v1.` prefix) is
 *  returned unchanged, so values written before encryption was enabled
 *  keep working. Throws when an envelope is found but CANTILA_SECRET_KEY
 *  is missing, or when the ciphertext fails authentication. */
export function decryptSecret(stored: string): string {
  if (!isEncryptedSecret(stored)) return stored;
  const key = masterKey();
  if (!key) {
    throw new Error(
      "CANTILA_SECRET_KEY is required to decrypt a stored secret",
    );
  }
  const parts = stored.slice(ENVELOPE_PREFIX.length).split(".");
  if (parts.length !== 3) {
    throw new Error("malformed secret envelope");
  }
  const [ivHex, ctHex, tagHex] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}
