export type BankScheme =
  | "IFSC"
  | "ABA_ROUTING"
  | "SORT_CODE"
  | "BSB"
  | "IBAN"
  | "SWIFT_ACCOUNT"
  | "GENERIC";

export interface ValidationResult {
  valid: boolean;
  issue?: string;
  label: string;
}

const IBAN_COUNTRIES = new Set([
  "AD", "AL", "AT", "AZ", "BA", "BE", "BG", "BH", "BR", "BY",
  "CH", "CR", "CY", "CZ", "DE", "DK", "DO", "EE", "EG", "ES",
  "FI", "FR", "GE", "GI", "GR", "GT", "HR", "HU", "IE", "IL",
  "IQ", "IS", "IT", "JO", "KW", "KZ", "LB", "LC", "LI", "LT",
  "LU", "LV", "MC", "MD", "ME", "MK", "MR", "MT", "MU", "NL",
  "NO", "PK", "PL", "PS", "PT", "QA", "RO", "RS", "SA", "SC",
  "SE", "SI", "SK", "SM", "ST", "SV", "TL", "TN", "TR", "UA",
  "VA", "VG", "XK",
]);

const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22,
  BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22,
  DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FR: 27, GB: 22,
  GE: 22, GI: 23, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23,
  IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32,
  LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19,
  MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29,
  PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19,
  SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29,
  VA: 22, VG: 24, XK: 20,
};

export function detectScheme(country: string): BankScheme {
  const c = country.toUpperCase().trim();
  if (c === "IN") return "IFSC";
  if (c === "US") return "ABA_ROUTING";
  if (c === "GB" || c === "UK") return "SORT_CODE";
  if (c === "AU") return "BSB";
  if (c === "AE") return "IBAN";
  if (c === "SG") return "SWIFT_ACCOUNT";
  if (IBAN_COUNTRIES.has(c)) return "IBAN";
  return "GENERIC";
}

export function inferCountryFromCurrency(currency: string): string {
  const map: Record<string, string> = {
    INR: "IN",
    USD: "US",
    GBP: "GB",
    EUR: "DE",
    AED: "AE",
    SGD: "SG",
    AUD: "AU",
  };
  return map[currency.toUpperCase()] ?? "";
}

export function validateIFSC(code: string): ValidationResult {
  const label = "IFSC";
  if (!code) return { valid: false, issue: "IFSC code is required", label };
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code.toUpperCase())) {
    return { valid: false, issue: `Invalid IFSC format (expected XXXX0XXXXXX): ${code}`, label };
  }
  return { valid: true, label };
}

export function validateABA(routing: string): ValidationResult {
  const label = "Routing number (ABA)";
  if (!routing) return { valid: false, issue: "Routing number is required", label };
  if (!/^\d{9}$/.test(routing)) {
    return { valid: false, issue: "Routing number must be exactly 9 digits", label };
  }
  const d = routing.split("").map(Number);
  const sum =
    3 * ((d[0] ?? 0) + (d[3] ?? 0) + (d[6] ?? 0)) +
    7 * ((d[1] ?? 0) + (d[4] ?? 0) + (d[7] ?? 0)) +
    1 * ((d[2] ?? 0) + (d[5] ?? 0) + (d[8] ?? 0));
  if (sum % 10 !== 0) {
    return { valid: false, issue: "Routing number failed 3-7-1 checksum validation", label };
  }
  return { valid: true, label };
}

export function validateSortCode(code: string): ValidationResult {
  const label = "Sort code";
  if (!code) return { valid: false, issue: "Sort code is required", label };
  const cleaned = code.replace(/-/g, "");
  if (!/^\d{6}$/.test(cleaned)) {
    return { valid: false, issue: "Sort code must be 6 digits (dashes optional)", label };
  }
  return { valid: true, label };
}

export function validateIBAN(iban: string): ValidationResult {
  const label = "IBAN";
  if (!iban) return { valid: false, issue: "IBAN is required", label };
  const normalized = iban.replace(/[\s-]/g, "").toUpperCase();
  const country = normalized.slice(0, 2);
  const expectedLength = IBAN_LENGTHS[country];
  if (expectedLength === undefined) {
    return { valid: false, issue: `IBAN country code '${country}' is not recognised`, label };
  }
  if (normalized.length !== expectedLength) {
    return {
      valid: false,
      issue: `IBAN for ${country} must be ${expectedLength} characters (got ${normalized.length})`,
      label,
    };
  }
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const val = ch >= "A" && ch <= "Z" ? ch.charCodeAt(0) - 55 : parseInt(ch, 10);
    remainder = val >= 10
      ? (remainder * 100 + val) % 97
      : (remainder * 10 + val) % 97;
  }
  if (remainder !== 1) {
    return { valid: false, issue: "IBAN failed mod-97 checksum validation", label };
  }
  return { valid: true, label };
}

export function validateBSB(bsb: string): ValidationResult {
  const label = "BSB";
  if (!bsb) return { valid: false, issue: "BSB is required", label };
  const cleaned = bsb.replace(/-/g, "");
  if (!/^\d{6}$/.test(cleaned)) {
    return { valid: false, issue: "BSB must be 6 digits (dash optional)", label };
  }
  return { valid: true, label };
}

export function validateSWIFT(bic: string): ValidationResult {
  const label = "SWIFT/BIC";
  if (!bic) return { valid: false, issue: "SWIFT/BIC is required", label };
  if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/i.test(bic)) {
    return { valid: false, issue: `Invalid SWIFT/BIC format: ${bic}`, label };
  }
  return { valid: true, label };
}

export function validateGeneric(code: string): ValidationResult {
  const label = "Bank code";
  if (!code) return { valid: false, issue: "Bank code is required", label };
  if (!/^[A-Z0-9]{4,34}$/i.test(code)) {
    return { valid: false, issue: "Bank code must be 4–34 alphanumeric characters", label };
  }
  return { valid: true, label };
}

export function validateSchemeCode(scheme: BankScheme, code: string): ValidationResult {
  switch (scheme) {
    case "IFSC": return validateIFSC(code);
    case "ABA_ROUTING": return validateABA(code);
    case "SORT_CODE": return validateSortCode(code);
    case "IBAN": return validateIBAN(code);
    case "BSB": return validateBSB(code);
    case "SWIFT_ACCOUNT": return validateSWIFT(code);
    case "GENERIC": return validateGeneric(code);
  }
}

export const SCHEME_LABELS: Record<BankScheme, string> = {
  IFSC: "IFSC",
  ABA_ROUTING: "Routing number (ABA)",
  SORT_CODE: "Sort code",
  IBAN: "IBAN",
  BSB: "BSB",
  SWIFT_ACCOUNT: "SWIFT/BIC",
  GENERIC: "Bank code",
};
