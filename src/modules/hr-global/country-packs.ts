export interface HolidaySeed {
  name: string;
  date: string;
  isPublic: boolean;
}

export interface ComplianceRequirementSeed {
  name: string;
  category: "statutory_filing" | "registration" | "posting" | "training" | "audit" | "other";
  frequency: "once" | "monthly" | "quarterly" | "yearly";
  dueRule: { month?: number; day?: number; offsetDays?: number };
  reminderDaysBefore: number;
}

export interface SensitiveFieldKeyDef {
  key: string;
  label: string;
  dbColumn: string | null;
  note?: string;
}

export interface CountryPack {
  countryCode: string;
  countryName: string;
  currency: string;
  defaultHolidays: HolidaySeed[];
  complianceRequirements: ComplianceRequirementSeed[];
  sensitiveFieldKeys: SensitiveFieldKeyDef[];
}

const IN_PACK: CountryPack = {
  countryCode: "IN",
  countryName: "India",
  currency: "INR",
  defaultHolidays: [
    { name: "Republic Day", date: "01-26", isPublic: true },
    { name: "Holi", date: "03-14", isPublic: true },
    { name: "Good Friday", date: "04-18", isPublic: true },
    { name: "Eid ul-Fitr", date: "04-21", isPublic: true },
    { name: "Independence Day", date: "08-15", isPublic: true },
    { name: "Janmashtami", date: "08-16", isPublic: true },
    { name: "Gandhi Jayanti", date: "10-02", isPublic: true },
    { name: "Dussehra", date: "10-02", isPublic: true },
    { name: "Diwali", date: "10-20", isPublic: true },
    { name: "Christmas Day", date: "12-25", isPublic: true },
  ],
  complianceRequirements: [
    {
      name: "PF Monthly Filing",
      category: "statutory_filing",
      frequency: "monthly",
      dueRule: { day: 15 },
      reminderDaysBefore: 7,
    },
    {
      name: "ESI Monthly Return",
      category: "statutory_filing",
      frequency: "monthly",
      dueRule: { day: 21 },
      reminderDaysBefore: 7,
    },
    {
      name: "Professional Tax Monthly",
      category: "statutory_filing",
      frequency: "monthly",
      dueRule: { day: 20 },
      reminderDaysBefore: 5,
    },
    {
      name: "TDS Quarterly Filing (Form 24Q)",
      category: "statutory_filing",
      frequency: "quarterly",
      dueRule: { offsetDays: 31 },
      reminderDaysBefore: 14,
    },
    {
      name: "Shops & Establishment Registration Renewal",
      category: "registration",
      frequency: "yearly",
      dueRule: { month: 12, day: 31 },
      reminderDaysBefore: 30,
    },
    {
      name: "POSH Annual Training",
      category: "training",
      frequency: "yearly",
      dueRule: { month: 3, day: 31 },
      reminderDaysBefore: 30,
    },
  ],
  sensitiveFieldKeys: [
    {
      key: "pan_number",
      label: "PAN Number",
      dbColumn: "pan_number",
    },
    {
      key: "national_id",
      label: "Aadhaar Number",
      dbColumn: "national_id",
    },
    {
      key: "pf_uan_number",
      label: "PF UAN Number",
      dbColumn: null,
      note: "Stored in bank_details JSONB as pfUanNumber",
    },
    {
      key: "esi_ip_number",
      label: "ESI IP Number",
      dbColumn: null,
      note: "Stored in bank_details JSONB as esiIpNumber (onboarding + sensitive tab)",
    },
    {
      key: "pt_registration",
      label: "Professional Tax Registration",
      dbColumn: null,
      note: "Org-level, not employee-level sensitive field",
    },
    {
      key: "tax_id",
      label: "Tax ID (TIN/TAN)",
      dbColumn: "tax_id",
    },
  ],
};

const GENERIC_PACK: CountryPack = {
  countryCode: "GENERIC",
  countryName: "Generic Template",
  currency: "USD",
  defaultHolidays: [
    { name: "New Year's Day", date: "01-01", isPublic: true },
    { name: "Labour Day", date: "05-01", isPublic: true },
    { name: "Christmas Day", date: "12-25", isPublic: true },
  ],
  complianceRequirements: [
    {
      name: "Annual Employment Law Compliance Review",
      category: "audit",
      frequency: "yearly",
      dueRule: { month: 12, day: 31 },
      reminderDaysBefore: 30,
    },
    {
      name: "Workplace Safety Posting",
      category: "posting",
      frequency: "once",
      dueRule: {},
      reminderDaysBefore: 14,
    },
  ],
  sensitiveFieldKeys: [
    {
      key: "national_id",
      label: "National ID",
      dbColumn: "national_id",
    },
    {
      key: "tax_id",
      label: "Tax ID",
      dbColumn: "tax_id",
    },
    {
      key: "passport_number",
      label: "Passport Number",
      dbColumn: "passport_number",
    },
  ],
};

/** Pilot packs — HR compliance seeds only; payroll calc remains India-first. */
const AE_PACK: CountryPack = {
  countryCode: "AE",
  countryName: "United Arab Emirates",
  currency: "AED",
  defaultHolidays: [
    { name: "New Year's Day", date: "01-01", isPublic: true },
    { name: "Eid al-Fitr", date: "04-10", isPublic: true },
    { name: "Arafat Day", date: "06-16", isPublic: true },
    { name: "National Day", date: "12-02", isPublic: true },
  ],
  complianceRequirements: [
    {
      name: "WPS Salary Payment File",
      category: "statutory_filing",
      frequency: "monthly",
      dueRule: { day: 28 },
      reminderDaysBefore: 5,
    },
    {
      name: "MOL / MOHRE Establishment Card Renewal",
      category: "registration",
      frequency: "yearly",
      dueRule: { month: 12, day: 31 },
      reminderDaysBefore: 45,
    },
  ],
  sensitiveFieldKeys: [
    { key: "national_id", label: "Emirates ID", dbColumn: "national_id" },
    { key: "passport_number", label: "Passport Number", dbColumn: "passport_number" },
  ],
};

const SG_PACK: CountryPack = {
  countryCode: "SG",
  countryName: "Singapore",
  currency: "SGD",
  defaultHolidays: [
    { name: "New Year's Day", date: "01-01", isPublic: true },
    { name: "Chinese New Year", date: "01-29", isPublic: true },
    { name: "National Day", date: "08-09", isPublic: true },
    { name: "Deepavali", date: "11-08", isPublic: true },
    { name: "Christmas Day", date: "12-25", isPublic: true },
  ],
  complianceRequirements: [
    {
      name: "CPF Contribution Submission",
      category: "statutory_filing",
      frequency: "monthly",
      dueRule: { day: 14 },
      reminderDaysBefore: 7,
    },
    {
      name: "IR8A Annual Submission",
      category: "statutory_filing",
      frequency: "yearly",
      dueRule: { month: 3, day: 1 },
      reminderDaysBefore: 30,
    },
  ],
  sensitiveFieldKeys: [
    { key: "national_id", label: "NRIC / FIN", dbColumn: "national_id" },
    { key: "tax_id", label: "Tax Reference", dbColumn: "tax_id" },
  ],
};

const US_PACK: CountryPack = {
  countryCode: "US",
  countryName: "United States",
  currency: "USD",
  defaultHolidays: [
    { name: "New Year's Day", date: "01-01", isPublic: true },
    { name: "Independence Day", date: "07-04", isPublic: true },
    { name: "Thanksgiving", date: "11-26", isPublic: true },
    { name: "Christmas Day", date: "12-25", isPublic: true },
  ],
  complianceRequirements: [
    {
      name: "Federal Payroll Tax Deposit",
      category: "statutory_filing",
      frequency: "monthly",
      dueRule: { day: 15 },
      reminderDaysBefore: 5,
    },
    {
      name: "Form 941 Quarterly Filing",
      category: "statutory_filing",
      frequency: "quarterly",
      dueRule: { offsetDays: 30 },
      reminderDaysBefore: 14,
    },
  ],
  sensitiveFieldKeys: [
    { key: "national_id", label: "SSN (masked)", dbColumn: "national_id" },
    { key: "tax_id", label: "ITIN / EIN (context)", dbColumn: "tax_id" },
  ],
};

export const COUNTRY_PACKS: Record<string, CountryPack> = {
  IN: IN_PACK,
  AE: AE_PACK,
  SG: SG_PACK,
  US: US_PACK,
  GENERIC: GENERIC_PACK,
};

export function getCountryPack(countryCode: string): CountryPack | undefined {
  return COUNTRY_PACKS[countryCode.toUpperCase()] ?? COUNTRY_PACKS["GENERIC"];
}
