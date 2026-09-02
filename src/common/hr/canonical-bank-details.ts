import { readSensitive, sealSensitive } from "../security/sensitive-field";
import {
  bankDetailsDecodeSchema,
  type BankDetails,
} from "../security/legacy-crypto";

export type { BankDetails };

export function sealBankDetails(details: BankDetails): string {
  return sealSensitive(JSON.stringify(details));
}

export function readBankDetails(stored: string | null | undefined): BankDetails | null {
  if (!stored) return null;
  const parsed = bankDetailsDecodeSchema.safeParse(JSON.parse(readSensitive(stored)));
  if (!parsed.success)
    throw new Error("Stored bank details do not match the expected shape");
  return parsed.data;
}
