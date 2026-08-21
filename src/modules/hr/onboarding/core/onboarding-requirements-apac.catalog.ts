import { ACCOUNT_HOLDER, BANK_NAME, accountNumberField } from "./onboarding-requirements.shared";
import type { CountryOnboardingRequirements } from "./onboarding-requirements.types";

export const APAC_ONBOARDING_REQUIREMENTS: Record<string, CountryOnboardingRequirements> = {
  IN: {
    countryCode: "IN",
    bankScheme: "IFSC",
    bankFields: [
      ACCOUNT_HOLDER,
      BANK_NAME,
      accountNumberField("00000000000"),
      {
        key: "routingCode",
        label: "IFSC code",
        placeholder: "HDFC0001234",
        required: true,
        uppercase: true,
      },
    ],
    statutoryFields: [
      {
        key: "pan",
        label: "PAN",
        placeholder: "ABCDE1234F",
        required: true,
        uppercase: true,
        pattern: "^[A-Z]{5}[0-9]{4}[A-Z]$",
        patternMessage: "Enter a valid PAN (ABCDE1234F)",
        help: "Permanent Account Number â€” required for payroll and tax.",
      },
      {
        key: "uan",
        label: "PF UAN",
        placeholder: "100000000000",
        required: false,
        pattern: "^[0-9]{12}$",
        patternMessage: "UAN must be 12 digits",
        help: "Provident Fund Universal Account Number, if you have one.",
      },
    ],
    documents: [
      {
        slug: "in-pan-card",
        name: "PAN Card",
        description: "Copy of your Permanent Account Number (PAN) card.",
        isMandatory: true,
      },
      {
        slug: "in-aadhaar-card",
        name: "Aadhaar Card",
        description: "Copy of your Aadhaar card (front and back).",
        isMandatory: true,
      },
    ],
  },
  SG: {
    countryCode: "SG",
    bankScheme: "SWIFT_ACCOUNT",
    bankFields: [
      ACCOUNT_HOLDER,
      BANK_NAME,
      accountNumberField("0123456789"),
      {
        key: "swift",
        label: "SWIFT / BIC",
        placeholder: "DBSSSGSG",
        required: true,
        uppercase: true,
      },
    ],
    statutoryFields: [
      {
        key: "nric_fin",
        label: "NRIC / FIN",
        placeholder: "S1234567D",
        required: true,
        uppercase: true,
        pattern: "^[STFG][0-9]{7}[A-Z]$",
        patternMessage: "Enter a valid NRIC/FIN (S1234567D)",
        help: "Required for CPF and IRAS reporting.",
      },
    ],
    documents: [
      {
        slug: "sg-nric-fin",
        name: "NRIC / FIN Card",
        description: "Copy of your NRIC or FIN card (front and back).",
        isMandatory: true,
      },
      {
        slug: "sg-work-pass",
        name: "Work Pass",
        description: "Employment Pass, S Pass, or Work Permit, if applicable.",
        isMandatory: false,
      },
    ],
  },
  AU: {
    countryCode: "AU",
    bankScheme: "BSB",
    bankFields: [
      ACCOUNT_HOLDER,
      BANK_NAME,
      accountNumberField("123456789"),
      {
        key: "routingCode",
        label: "BSB",
        placeholder: "123-456",
        required: true,
        help: "6-digit BSB (dash optional).",
      },
    ],
    statutoryFields: [
      {
        key: "tfn",
        label: "Tax File Number",
        placeholder: "123456789",
        required: true,
        pattern: "^\\d{9}$",
        patternMessage: "TFN must be 9 digits",
        help: "Required for PAYG withholding.",
      },
      {
        key: "super_fund",
        label: "Superannuation fund",
        placeholder: "Fund name (optional)",
        required: false,
        help: "Your nominated super fund, if you have one.",
      },
    ],
    documents: [
      {
        slug: "au-photo-id",
        name: "Photo ID / Passport",
        description: "Passport or driver's licence for identity verification.",
        isMandatory: true,
      },
      {
        slug: "au-tfn-declaration",
        name: "Tax File Number Declaration",
        description: "Completed Tax File Number declaration form.",
        isMandatory: true,
      },
      {
        slug: "au-super-details",
        name: "Superannuation Details",
        description: "Superannuation standard choice form or fund details.",
        isMandatory: true,
      },
    ],
  },
};
