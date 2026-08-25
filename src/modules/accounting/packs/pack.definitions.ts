import {
  chartWith,
  GENERIC_VAT_ACCOUNTS,
  IN_GST_ACCOUNTS,
  US_SALES_TAX_ACCOUNTS,
} from "./coa-template";
import type { DocumentSeriesKind, DocumentSeriesPattern, LocalizationPack } from "./pack.types";

/** India resets every series on 1 April; most other jurisdictions run continuous. */
function series(
  prefix: string,
  resetEachFiscalYear: boolean,
  padding = resetEachFiscalYear ? 4 : 5,
): DocumentSeriesPattern {
  return {
    pattern: resetEachFiscalYear ? "{PREFIX}/{FY}/{SEQ}" : "{PREFIX}-{SEQ}",
    prefix,
    padding,
    resetEachFiscalYear,
  };
}

function seriesSet(resetEachFiscalYear: boolean): Record<DocumentSeriesKind, DocumentSeriesPattern> {
  return {
    salesInvoice: series("INV", resetEachFiscalYear),
    creditNote: series("CRN", resetEachFiscalYear),
    debitNote: series("DBN", resetEachFiscalYear),
    purchaseBill: series("BILL", resetEachFiscalYear),
    receipt: series("RCP", resetEachFiscalYear),
    payment: series("PAY", resetEachFiscalYear),
    journal: series("JV", resetEachFiscalYear),
  };
}

/**
 * Pack `IN` — the first real implementation. Fiscal year 1 Apr – 31 Mar,
 * INR, GST accounts tagged, fresh document series each year.
 */
export const IN_PACK: LocalizationPack = Object.freeze({
  code: "IN",
  title: "India",
  status: "enabled",
  countryCodes: ["IN"],
  defaultCurrency: "INR",
  defaultTimezone: "Asia/Kolkata",
  locale: "en-IN",
  fiscalYearStart: { month: 4, day: 1 },
  fiscalYearNaming: "span",
  taxEngine: "IN",
  regionRequired: true,
  documentSeries: seriesSet(true),
  chartOfAccounts: chartWith(IN_GST_ACCOUNTS),
});

/**
 * Pack `GENERIC_VAT` — a single standard rate, enough to run books anywhere
 * a real pack does not exist yet. The Lisbon founder in the PRD's definition
 * of shipped uses this one.
 */
export const GENERIC_VAT_PACK: LocalizationPack = Object.freeze({
  code: "GENERIC_VAT",
  title: "Generic VAT",
  status: "enabled",
  countryCodes: [],
  defaultCurrency: "EUR",
  defaultTimezone: "UTC",
  locale: "en-GB",
  fiscalYearStart: { month: 1, day: 1 },
  fiscalYearNaming: "calendar",
  taxEngine: "GENERIC_VAT",
  regionRequired: false,
  documentSeries: seriesSet(false),
  chartOfAccounts: chartWith(GENERIC_VAT_ACCOUNTS),
});

/**
 * Stubs. These register so the country is selectable, the chart is right and
 * the schema holds the fields the real pack will need — but `determine()`
 * refuses with a structured error rather than booking zero tax (PRD 10 M2).
 */
function stub(
  overrides: Pick<LocalizationPack, "code" | "title" | "countryCodes" | "defaultCurrency"> &
    Partial<LocalizationPack>,
): LocalizationPack {
  return Object.freeze({
    status: "stub",
    defaultTimezone: "UTC",
    locale: "en-GB",
    fiscalYearStart: { month: 1, day: 1 },
    fiscalYearNaming: "calendar" as const,
    taxEngine: overrides.code,
    regionRequired: false,
    documentSeries: seriesSet(false),
    chartOfAccounts: chartWith(GENERIC_VAT_ACCOUNTS),
    ...overrides,
  });
}

export const US_PACK = stub({
  code: "US",
  title: "United States",
  countryCodes: ["US"],
  defaultCurrency: "USD",
  defaultTimezone: "America/New_York",
  locale: "en-US",
  // Destination state drives every US sales-tax question.
  regionRequired: true,
  chartOfAccounts: chartWith(US_SALES_TAX_ACCOUNTS),
});

export const GB_PACK = stub({
  code: "GB",
  title: "United Kingdom",
  countryCodes: ["GB"],
  defaultCurrency: "GBP",
  defaultTimezone: "Europe/London",
  // Companies House year-ends cluster on 31 March; a book can override.
  fiscalYearStart: { month: 4, day: 1 },
  fiscalYearNaming: "span",
});

export const EU_PACK = stub({
  code: "EU",
  title: "European Union (VAT)",
  countryCodes: ["DE", "FR", "NL", "ES", "IT", "PT", "IE", "BE", "AT", "PL", "SE", "FI", "DK"],
  defaultCurrency: "EUR",
  defaultTimezone: "Europe/Brussels",
});

export const SG_PACK = stub({
  code: "SG",
  title: "Singapore",
  countryCodes: ["SG"],
  defaultCurrency: "SGD",
  defaultTimezone: "Asia/Singapore",
});

export const AU_PACK = stub({
  code: "AU",
  title: "Australia",
  countryCodes: ["AU"],
  defaultCurrency: "AUD",
  defaultTimezone: "Australia/Sydney",
  fiscalYearStart: { month: 7, day: 1 },
  fiscalYearNaming: "span",
});

export const CA_PACK = stub({
  code: "CA",
  title: "Canada",
  countryCodes: ["CA"],
  defaultCurrency: "CAD",
  defaultTimezone: "America/Toronto",
  regionRequired: true,
});

export const AE_PACK = stub({
  code: "AE",
  title: "United Arab Emirates (GCC VAT)",
  countryCodes: ["AE", "SA", "OM", "BH", "KW", "QA"],
  defaultCurrency: "AED",
  defaultTimezone: "Asia/Dubai",
});

export const ALL_PACKS: readonly LocalizationPack[] = Object.freeze([
  IN_PACK,
  GENERIC_VAT_PACK,
  US_PACK,
  GB_PACK,
  EU_PACK,
  SG_PACK,
  AU_PACK,
  CA_PACK,
  AE_PACK,
]);
