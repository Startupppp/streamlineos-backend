import {
  detectScheme,
  type BankScheme,
} from "../payroll/payout/lib/bank-validation";

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

const ACCOUNT_HOLDER: BankField = {
  key: "accountHolder",
  label: "Account holder name",
  placeholder: "Name as on the bank account",
  required: true,
};

const BANK_NAME: BankField = {
  key: "bankName",
  label: "Bank name",
  placeholder: "Your bank's name",
  required: true,
};

function accountNumberField(placeholder: string, help?: string): BankField {
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

const IN_REQ: CountryOnboardingRequirements = {
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
      help: "Permanent Account Number — required for payroll and tax.",
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
};

const US_REQ: CountryOnboardingRequirements = {
  countryCode: "US",
  bankScheme: "ABA_ROUTING",
  bankFields: [
    ACCOUNT_HOLDER,
    BANK_NAME,
    accountNumberField("000123456789"),
    {
      key: "routingCode",
      label: "Routing number (ABA)",
      placeholder: "021000021",
      required: true,
      help: "9-digit ABA routing number.",
    },
  ],
  statutoryFields: [
    {
      key: "ssn",
      label: "Social Security Number",
      placeholder: "123-45-6789",
      required: true,
      pattern: "^\\d{3}-?\\d{2}-?\\d{4}$",
      patternMessage: "Enter a valid SSN (123-45-6789)",
      help: "Required for federal payroll tax reporting.",
    },
  ],
  documents: [
    {
      slug: "us-form-i9",
      name: "Form I-9 (Employment Eligibility)",
      description: "Completed Employment Eligibility Verification (Form I-9).",
      isMandatory: true,
    },
    {
      slug: "us-form-w4",
      name: "Form W-4",
      description: "Signed Employee's Withholding Certificate (Form W-4).",
      isMandatory: true,
    },
    {
      slug: "us-ssn-card",
      name: "Social Security Card",
      description: "Copy of your Social Security card.",
      isMandatory: true,
    },
  ],
};

const GB_REQ: CountryOnboardingRequirements = {
  countryCode: "GB",
  bankScheme: "SORT_CODE",
  bankFields: [
    ACCOUNT_HOLDER,
    BANK_NAME,
    accountNumberField("12345678", "8-digit account number."),
    {
      key: "routingCode",
      label: "Sort code",
      placeholder: "12-34-56",
      required: true,
      help: "6-digit sort code (dashes optional).",
    },
  ],
  statutoryFields: [
    {
      key: "ni_number",
      label: "National Insurance number",
      placeholder: "QQ123456C",
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
      description:
        "Passport or share code proving your right to work in the UK.",
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
      description:
        "P45 from your previous employer, or a completed new starter checklist.",
      isMandatory: false,
    },
  ],
};

const AE_REQ: CountryOnboardingRequirements = {
  countryCode: "AE",
  bankScheme: "IBAN",
  bankFields: [
    ACCOUNT_HOLDER,
    BANK_NAME,
    {
      key: "iban",
      label: "IBAN",
      placeholder: "AE070331234567890123456",
      required: true,
      uppercase: true,
      help: "23-character UAE IBAN.",
    },
    {
      key: "swift",
      label: "SWIFT / BIC",
      placeholder: "ADCBAEAA",
      required: false,
      uppercase: true,
    },
  ],
  statutoryFields: [
    {
      key: "emirates_id",
      label: "Emirates ID",
      placeholder: "784-1234-1234567-1",
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
};

const SG_REQ: CountryOnboardingRequirements = {
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
};

const AU_REQ: CountryOnboardingRequirements = {
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
};

const GENERIC_STATUTORY: StatutoryField[] = [
  {
    key: "tax_id",
    label: "Tax identification number",
    placeholder: "Your local tax ID",
    required: false,
    help: "Your national tax identification number, if applicable.",
  },
];

function genericRequirements(
  countryCode: string,
): CountryOnboardingRequirements {
  const code = countryCode.toUpperCase() || "GENERIC";
  const scheme = code === "GENERIC" ? "GENERIC" : detectScheme(code);

  if (scheme === "IBAN") {
    return {
      countryCode: code,
      bankScheme: "IBAN",
      bankFields: [
        ACCOUNT_HOLDER,
        BANK_NAME,
        {
          key: "iban",
          label: "IBAN",
          placeholder: "Your IBAN",
          required: true,
          uppercase: true,
          help: "International Bank Account Number.",
        },
        {
          key: "swift",
          label: "SWIFT / BIC",
          placeholder: "AAAABBCC",
          required: false,
          uppercase: true,
        },
      ],
      statutoryFields: GENERIC_STATUTORY,
      documents: [],
    };
  }

  return {
    countryCode: code,
    bankScheme: "GENERIC",
    bankFields: [
      ACCOUNT_HOLDER,
      BANK_NAME,
      accountNumberField("Account number"),
      {
        key: "swift",
        label: "SWIFT / BIC",
        placeholder: "AAAABBCC",
        required: false,
        uppercase: true,
        help: "SWIFT/BIC for international transfers, if available.",
      },
    ],
    statutoryFields: GENERIC_STATUTORY,
    documents: [],
  };
}

const REQUIREMENTS_BY_COUNTRY: Record<string, CountryOnboardingRequirements> = {
  IN: IN_REQ,
  US: US_REQ,
  GB: GB_REQ,
  UK: GB_REQ,
  AE: AE_REQ,
  SG: SG_REQ,
  AU: AU_REQ,
};

export function resolveCountryRequirements(
  countryCode: string | null | undefined,
): CountryOnboardingRequirements {
  const code = (countryCode ?? "").toUpperCase().trim();
  return REQUIREMENTS_BY_COUNTRY[code] ?? genericRequirements(code);
}
