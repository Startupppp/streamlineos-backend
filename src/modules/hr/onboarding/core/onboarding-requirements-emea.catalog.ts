import { ACCOUNT_HOLDER, BANK_NAME, accountNumberField } from "./onboarding-requirements.shared";
import type { CountryOnboardingRequirements } from "./onboarding-requirements.types";

const GREAT_BRITAIN_REQUIREMENTS: CountryOnboardingRequirements = {
  countryCode: "GB",
  bankScheme: "SORT_CODE",
  bankFields: [
    ACCOUNT_HOLDER,
    BANK_NAME,
    accountNumberField("e.g. 12345678", "8-digit account number."),
    {
      key: "routingCode",
      label: "Sort code",
      placeholder: "e.g. 12-34-56",
      required: true,
      help: "6-digit sort code (dashes optional).",
    },
  ],
  statutoryFields: [
    {
      key: "ni_number",
      label: "National Insurance number",
      placeholder: "e.g. QQ123456C",
      required: true,
      uppercase: true,
      pattern: "^[A-Z]{2}[0-9]{6}[A-Z]$",
      patternMessage: "Enter a valid National Insurance number (QQ123456C)",
      help: "Required for PAYE payroll and NIC.",
    },
  ],
  documents: [
    {
      slug: "gb-right-to-work",
      name: "Right to Work / Passport",
      description: "Passport or share code proving your right to work in the UK.",
      isMandatory: true,
    },
    {
      slug: "gb-ni-proof",
      name: "National Insurance Proof",
      description: "Document showing your National Insurance number.",
      isMandatory: true,
    },
    {
      slug: "gb-p45",
      name: "P45 / New Starter Checklist",
      description: "P45 from your previous employer, or a completed new starter checklist.",
      isMandatory: false,
    },
  ],
};

export const EMEA_ONBOARDING_REQUIREMENTS: Record<string, CountryOnboardingRequirements> = {
  GB: GREAT_BRITAIN_REQUIREMENTS,
  UK: GREAT_BRITAIN_REQUIREMENTS,
  AE: {
    countryCode: "AE",
    bankScheme: "IBAN",
    bankFields: [
      ACCOUNT_HOLDER,
      BANK_NAME,
      {
        key: "iban",
        label: "IBAN",
        placeholder: "e.g. AE070331234567890123456",
        required: true,
        uppercase: true,
        help: "23-character UAE IBAN.",
      },
      {
        key: "swift",
        label: "SWIFT / BIC",
        placeholder: "e.g. ADCBAEAA",
        required: false,
        uppercase: true,
      },
    ],
    statutoryFields: [
      {
        key: "emirates_id",
        label: "Emirates ID",
        placeholder: "e.g. 784-1234-1234567-1",
        required: true,
        pattern: "^784-?\\d{4}-?\\d{7}-?\\d$",
        patternMessage: "Enter a valid Emirates ID (784-XXXX-XXXXXXX-X)",
        help: "15-digit Emirates ID number.",
      },
    ],
    documents: [
      {
        slug: "ae-passport-copy",
        name: "Passport Copy",
        description: "Copy of your passport photo page.",
        isMandatory: true,
      },
      {
        slug: "ae-emirates-id",
        name: "Emirates ID",
        description: "Copy of your Emirates ID (front and back).",
        isMandatory: true,
      },
      {
        slug: "ae-residence-visa",
        name: "Residence Visa",
        description: "Copy of your UAE residence visa page.",
        isMandatory: true,
      },
    ],
  },
};
