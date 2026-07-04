import { createDecipheriv, createHash } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PREFIX = "enc:v1:";

function getKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  return createHash("sha256").update(raw).digest();
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  if (!key || !ciphertext.startsWith(PREFIX)) return ciphertext;

  const data = Buffer.from(ciphertext.slice(PREFIX.length), "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export interface BankDetails {
  accountNumber: string;
  bankName: string;
  branch: string;
  ifsc: string;
  accountHolder: string;
  pfUanNumber?: string;
  bankCountry?: string;
}

export function decryptBankDetails(encrypted: string | null | undefined): BankDetails | null {
  if (!encrypted) return null;
  try {
    return JSON.parse(decrypt(encrypted)) as BankDetails;
  } catch {
    return null;
  }
}
