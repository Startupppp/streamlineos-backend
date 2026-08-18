import type { BankScheme } from "../../../payroll/payout/lib/bank-validation";

export type BankFieldKey =
  | "accountHolder"
  | "bankName"
  | "accountNumber"
  | "routingCode"
  | "iban"
  | "swift";

export interface BankField {
  key: BankFieldKey;
  label: string;
  placeholder: string;
  required: boolean;
  uppercase?: boolean;
  help?: string;
}

export interface StatutoryField {
  key: string;
  label: string;
  placeholder: string;
  required: boolean;
  uppercase?: boolean;
  help?: string;
  pattern?: string;
  patternMessage?: string;
}

export interface DocumentSeed {
  slug: string;
  name: string;
  description: string;
  isMandatory: boolean;
}

export interface CountryOnboardingRequirements {
  countryCode: string;
  bankScheme: BankScheme;
  bankFields: BankField[];
  statutoryFields: StatutoryField[];
  documents: DocumentSeed[];
}
