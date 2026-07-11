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
      note: "Gap: not in hr_employee_sensitive_fields — store in work_authorizations note or extend schema",
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

export const COUNTRY_PACKS: Record<string, CountryPack> = {
  IN: IN_PACK,
  GENERIC: GENERIC_PACK,
};

export function getCountryPack(countryCode: string): CountryPack | undefined {
  return COUNTRY_PACKS[countryCode.toUpperCase()] ?? COUNTRY_PACKS["GENERIC"];
}
