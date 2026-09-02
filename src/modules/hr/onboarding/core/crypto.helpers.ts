import {
  encrypt,
  decrypt,
  bankDetailsDecodeSchema,
  type BankDetails,
} from "../../../../common/security/legacy-crypto";

export { encrypt, decrypt, bankDetailsDecodeSchema };
export type { BankDetails };

export function encryptBankDetails(details: BankDetails): string {
  return encrypt(JSON.stringify(details));
}

export function decryptBankDetails(encrypted: string | null | undefined): BankDetails | null {
  if (!encrypted) return null;
  try {
    const parsed = bankDetailsDecodeSchema.safeParse(JSON.parse(decrypt(encrypted)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
