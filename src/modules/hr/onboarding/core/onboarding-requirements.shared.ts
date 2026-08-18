import type { BankField, DocumentSeed, StatutoryField } from "./onboarding-requirements.types";

export const ACCOUNT_HOLDER: BankField = {
  key: "accountHolder",
  label: "Account holder name",
  placeholder: "Name as on the bank account",
  required: true,
};

export const BANK_NAME: BankField = {
  key: "bankName",
  label: "Bank name",
  placeholder: "Your bank's name",
  required: true,
};

export function accountNumberField(placeholder: string, help?: string): BankField {
  return {
    key: "accountNumber",
    label: "Account number",
    placeholder,
    required: true,
    help,
  };
}

export const GLOBAL_DOCUMENTS: DocumentSeed[] = [
  {
    slug: "government-photo-id",
    name: "Government-issued Photo ID",
    description:
      "A valid government photo identity document (passport, driver's licence, or national ID).",
    isMandatory: true,
  },
  {
    slug: "proof-of-address",
    name: "Proof of Address",
    description:
      "A recent utility bill, bank statement, or tenancy agreement showing your current address.",
    isMandatory: true,
  },
  {
    slug: "passport-photograph",
    name: "Passport-size Photograph",
    description: "A recent passport-size photograph for your employee record.",
    isMandatory: true,
  },
  {
    slug: "educational-certificates",
    name: "Educational Certificates",
    description: "Highest qualification degree or diploma certificate.",
    isMandatory: true,
  },
  {
    slug: "bank-account-proof",
    name: "Bank Account Proof",
    description:
      "A cancelled cheque, bank passbook, or bank letter confirming your account details.",
    isMandatory: true,
  },
  {
    slug: "signed-offer-letter",
    name: "Signed Offer Letter",
    description: "Your countersigned offer or appointment letter.",
    isMandatory: false,
  },
  {
    slug: "relieving-letter",
    name: "Previous Employment Relieving Letter",
    description:
      "Relieving or experience letter from your most recent employer, if applicable.",
    isMandatory: false,
  },
];

export const GENERIC_STATUTORY: StatutoryField[] = [
  {
    key: "tax_id",
    label: "Tax identification number",
    placeholder: "Your local tax ID",
    required: false,
    help: "Your national tax identification number, if applicable.",
  },
];
