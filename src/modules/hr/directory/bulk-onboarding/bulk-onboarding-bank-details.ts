import { type BankDetails } from "../../onboarding/core/crypto.helpers";
import type { OnboardEmployeeInput } from "../dto/hr-directory.schemas";

export type BankDetailsInput = NonNullable<OnboardEmployeeInput["bankDetails"]> & {
  pfUanNumber?: string;
  esiIpNumber?: string;
};

export function toBankDetails(input: BankDetailsInput): BankDetails {
  return {
    accountNumber: input.accountNumber ?? "",
    bankName: input.bankName ?? "",
    branch: input.branch ?? "",
    ifsc: input.ifsc ?? "",
    accountHolder: input.accountHolder ?? "",
    ...(input.pfUanNumber !== undefined ? { pfUanNumber: input.pfUanNumber } : {}),
    ...(input.esiIpNumber !== undefined ? { esiIpNumber: input.esiIpNumber } : {}),
  };
}
