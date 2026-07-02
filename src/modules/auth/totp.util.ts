import { createHash, createDecipheriv } from "node:crypto";
import { verifySync } from "otplib";

const TOTP_ALGORITHM = "aes-256-gcm";
const TOTP_IV_LENGTH = 12;
const TOTP_TAG_LENGTH = 16;
const TOTP_PREFIX = "enc:v1:";

export function decryptTotpSecret(ciphertext: string): string {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || !ciphertext.startsWith(TOTP_PREFIX)) return ciphertext;
  const key = createHash("sha256").update(raw).digest();
  const data = Buffer.from(ciphertext.slice(TOTP_PREFIX.length), "base64");
  const iv = data.subarray(0, TOTP_IV_LENGTH);
  const tag = data.subarray(TOTP_IV_LENGTH, TOTP_IV_LENGTH + TOTP_TAG_LENGTH);
  const encrypted = data.subarray(TOTP_IV_LENGTH + TOTP_TAG_LENGTH);
  const decipher = createDecipheriv(TOTP_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function verifyTotpCode(token: string, encryptedSecret: string): boolean {
  try {
    const result = verifySync({ secret: decryptTotpSecret(encryptedSecret), token, strategy: "totp" });
    return result.valid;
  } catch {
    return false;
  }
}
