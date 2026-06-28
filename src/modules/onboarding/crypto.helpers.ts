import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { z } from "zod";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PREFIX = "enc:v1:";

function getKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  return createHash("sha256").update(raw).digest();
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export interface BankDetails {
  accountNumber: string;
  bankName: string;
  branch: string;
  ifsc: string;
  accountHolder: string;
  pfUanNumber?: string;
}

export function encryptBankDetails(details: BankDetails): string {
  return encrypt(JSON.stringify(details));
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

const bankDetailsDecodeSchema = z.object({
  accountNumber: z.string(),
  bankName: z.string(),
  branch: z.string(),
  ifsc: z.string(),
  accountHolder: z.string(),
  pfUanNumber: z.string().optional(),
});

export function decryptBankDetails(encrypted: string | null | undefined): BankDetails | null {
  if (!encrypted) return null;
  try {
    const parsed = bankDetailsDecodeSchema.safeParse(JSON.parse(decrypt(encrypted)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
