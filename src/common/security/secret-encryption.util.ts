import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// AES-256-GCM secret-at-rest encryption, keyed from ENCRYPTION_KEY. Same algorithm/format
// ("enc:v1:" + base64(iv|tag|ciphertext)) as the pre-existing duplicates in
// hr-payroll/lib/encryption.ts and onboarding/crypto.helpers.ts — new code should use this
// shared copy; those two are not touched here to avoid an unrelated refactor of working code.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PREFIX = "enc:v1:";

function getKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  if (!key) {
    throw new Error("ENCRYPTION_KEY is not configured — cannot store payment provider secrets");
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSecret(ciphertext: string): string {
  const key = getKey();
  if (!key || !ciphertext.startsWith(PREFIX)) {
    throw new Error("Cannot decrypt secret — ENCRYPTION_KEY missing or ciphertext malformed");
  }

  const data = Buffer.from(ciphertext.slice(PREFIX.length), "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/** Never returns enough to reconstruct the secret — e.g. "****3f9a" from a raw key. */
export function maskSecretHint(rawValue: string): string {
  const tail = rawValue.slice(-4);
  return `****${tail}`;
}
