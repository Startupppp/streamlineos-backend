import {
  ACCOUNT_HOLDER,
  BANK_NAME,
  accountNumberField,
} from "./onboarding-requirements.shared";
import type { CountryOnboardingRequirements } from "./onboarding-requirements.types";

export const AMERICAS_ONBOARDING_REQUIREMENTS: Record<
  string,
  CountryOnboardingRequirements
> = {
  US: {
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
  },
};
