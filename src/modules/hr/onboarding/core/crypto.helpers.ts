import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { z } from "zod";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PREFIX = "enc:v1:";

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not configured — refusing to handle sensitive data unencrypted",
    );
  }
  return createHash("sha256").update(raw).digest();
}

export function encrypt(plaintext: string): string {
  const key = getKey();

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
  /** ESIC Insurance Person (IP) number when assigned */
  esiIpNumber?: string;
  bankCountry?: string;
  routingCode?: string;
  iban?: string;
  swift?: string;
  scheme?: string;
  statutory?: Record<string, string>;
}

export function encryptBankDetails(details: BankDetails): string {
  return encrypt(JSON.stringify(details));
}

export function decrypt(ciphertext: string): string {
  if (!ciphertext.startsWith(PREFIX)) return ciphertext;

  const key = getKey();
  const data = Buffer.from(ciphertext.slice(PREFIX.length), "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export const bankDetailsDecodeSchema = z.object({
  accountNumber: z.string(),
  bankName: z.string(),
  branch: z.string(),
  ifsc: z.string(),
  accountHolder: z.string(),
  pfUanNumber: z.string().optional(),
  esiIpNumber: z.string().optional(),
  bankCountry: z.string().max(10).optional(),
  routingCode: z.string().optional(),
  iban: z.string().optional(),
  swift: z.string().optional(),
  scheme: z.string().optional(),
  statutory: z.record(z.string(), z.string()).optional(),
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
