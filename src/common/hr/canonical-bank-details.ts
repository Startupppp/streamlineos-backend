import { readSensitive, sealSensitive } from "../security/sensitive-field";
import {
  bankDetailsDecodeSchema,
  type BankDetails,
} from "../../modules/hr/onboarding/core/crypto.helpers";

export type { BankDetails };

export function sealBankDetails(details: BankDetails): string {
  return sealSensitive(JSON.stringify(details));
}

export function readBankDetails(stored: string | null | undefined): BankDetails | null {
  if (!stored) return null;
  const parsed = bankDetailsDecodeSchema.safeParse(JSON.parse(readSensitive(stored)));
  return parsed.success ? parsed.data : null;
}

export function bankDetailsEqual(
  left: BankDetails | null,
  right: BankDetails | null,
): boolean {
  if (left === null || right === null) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}
