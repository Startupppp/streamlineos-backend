import type { BankDetails } from "../../common/hr/canonical-bank-details";

export type { BankDetails };

export const EMPLOYMENT_FACT_NAMES = [
  "designation",
  "joiningDate",
  "employeeNumber",
  "departmentId",
  "locationId",
  "managerUserId",
  "salaryAmountCents",
  "bankDetails",
  "taxId",
] as const;

export type EmploymentFactName = (typeof EMPLOYMENT_FACT_NAMES)[number];

export type EmploymentFacts = {
  userId: string;
  employmentId: number | null;
  employeeNumber: string | null;
  designation: string | null;
  joiningDate: string | null;
  departmentId: string | null;
  locationId: string | null;
  managerUserId: string | null;
};

export type SensitiveEmploymentFacts = {
  userId: string;
  employmentId: number | null;
  salaryAmountCents: number | null;
  bankDetails: BankDetails | null;
  taxId: string | null;
  panNumber: string | null;
};

export function emptySensitiveEmploymentFacts(
  userId: string,
): SensitiveEmploymentFacts {
  return {
    userId,
    employmentId: null,
    salaryAmountCents: null,
    bankDetails: null,
    taxId: null,
    panNumber: null,
  };
}

export function emptyEmploymentFacts(userId: string): EmploymentFacts {
  return {
    userId,
    employmentId: null,
    employeeNumber: null,
    designation: null,
    joiningDate: null,
    departmentId: null,
    locationId: null,
    managerUserId: null,
  };
}
