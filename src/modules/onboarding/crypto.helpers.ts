import { createCipheriv, createHash, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
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
