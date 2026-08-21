import { detectScheme } from "../../../payroll/payout/lib/bank-validation";
import { AMERICAS_ONBOARDING_REQUIREMENTS } from "./onboarding-requirements-americas.catalog";
import { APAC_ONBOARDING_REQUIREMENTS } from "./onboarding-requirements-apac.catalog";
import { EMEA_ONBOARDING_REQUIREMENTS } from "./onboarding-requirements-emea.catalog";
import {
  ACCOUNT_HOLDER,
  BANK_NAME,
  GENERIC_STATUTORY,
  accountNumberField,
} from "./onboarding-requirements.shared";
import type { CountryOnboardingRequirements } from "./onboarding-requirements.types";

export type {
  BankField,
  BankFieldKey,
  CountryOnboardingRequirements,
  DocumentSeed,
  StatutoryField,
} from "./onboarding-requirements.types";
export { GLOBAL_DOCUMENTS } from "./onboarding-requirements.shared";

function genericRequirements(countryCode: string): CountryOnboardingRequirements {
  const normalizedCountryCode = countryCode.toUpperCase() || "GENERIC";
  const bankScheme =
    normalizedCountryCode === "GENERIC" ? "GENERIC" : detectScheme(normalizedCountryCode);

  if (bankScheme === "IBAN") {
    return {
      countryCode: normalizedCountryCode,
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
    countryCode: normalizedCountryCode,
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
  ...AMERICAS_ONBOARDING_REQUIREMENTS,
  ...EMEA_ONBOARDING_REQUIREMENTS,
  ...APAC_ONBOARDING_REQUIREMENTS,
};

export function resolveCountryRequirements(
  countryCode: string | null | undefined,
): CountryOnboardingRequirements {
  const normalizedCountryCode = (countryCode ?? "").toUpperCase().trim();
  return REQUIREMENTS_BY_COUNTRY[normalizedCountryCode] ?? genericRequirements(normalizedCountryCode);
}
