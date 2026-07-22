import {
  IN_STATUTORY_2025_04,
  resolvePtMonthly,
} from "../../payroll/runs/lib/statutory-registry";

export interface TaxSlab {
  min: number;
  max: number;
  rate: number;
}

export interface SalaryBand {
  label: string;
  min: number;
  max: number;
}

export interface CountryFiscalConfig {
  country: string;
  fiscalYear: string;
  currency: string;
  locale: string;
  currencySymbol: string;
  incomeTax: {
    oldRegimeSlabs: TaxSlab[];
    newRegimeSlabs: TaxSlab[];
    standardDeduction: number;
    cessPercent: number;
  };
  pf: {
    employeePercent: number;
    employerPercent: number;
    /**
     * Annual PF *contribution* cap (not a wage ceiling): ₹15,000/mo wage base
     * × 12% × 12 = ₹21,600/yr. Renamed from the misleading `annualWageCeiling`.
     */
    annualContributionCeiling: number;
  };
  esi: {
    employeePercent: number;
    employerPercent: number;
    monthlyWageCeiling: number;
  };
  professionalTaxAnnual: number;
  salaryBands: SalaryBand[];
}

// Single source of truth for shared statutory scalars: the canonical versioned
// registry that the modern run engine also reads (PayrollOS PRD §8.2 — one rule
// source, not three). Only the legacy-analytics presentation layer (regime slab
// tables + salary bands, which the registry does not model for this read surface)
// remains local. A rate change in the registry now flows through here too.
const REG = IN_STATUTORY_2025_04;

const IN_FY_2025_26: CountryFiscalConfig = {
  country: "IN",
  fiscalYear: "2025-26",
  currency: "INR",
  locale: "en-IN",
  currencySymbol: "₹",
  incomeTax: {
    oldRegimeSlabs: [
      { min: 0, max: 250000, rate: 0 },
      { min: 250000, max: 500000, rate: 5 },
      { min: 500000, max: 1000000, rate: 20 },
      { min: 1000000, max: Infinity, rate: 30 },
    ],
    newRegimeSlabs: [
      { min: 0, max: 300000, rate: 0 },
      { min: 300000, max: 700000, rate: 5 },
      { min: 700000, max: 1000000, rate: 10 },
      { min: 1000000, max: 1200000, rate: 15 },
      { min: 1200000, max: 1500000, rate: 20 },
      { min: 1500000, max: Infinity, rate: 30 },
    ],
    standardDeduction: REG.tds.newRegimeStandardDeductionPaise / 100,
    cessPercent: Number(REG.tds.cessPercent),
  },
  pf: {
    employeePercent: Number(REG.pf.employeePercent),
    employerPercent: Number(REG.pf.employerPercent),
    annualContributionCeiling: Number(REG.pf.legacyMisnamedAnnualField),
  },
  esi: {
    employeePercent: Number(REG.esi.employeePercent),
    employerPercent: Number(REG.esi.employerPercent),
    monthlyWageCeiling: Number(REG.esi.monthlyEligibilityCeiling),
  },
  professionalTaxAnnual: Number(resolvePtMonthly(REG)) * 12,
  salaryBands: [
    { label: "< 3L", min: 0, max: 300_000 },
    { label: "3–6L", min: 300_000, max: 600_000 },
    { label: "6–10L", min: 600_000, max: 1_000_000 },
    { label: "10–15L", min: 1_000_000, max: 1_500_000 },
    { label: "15–25L", min: 1_500_000, max: 2_500_000 },
    { label: "> 25L", min: 2_500_000, max: Infinity },
  ],
};

const STATUTORY_REGISTRY: CountryFiscalConfig[] = [IN_FY_2025_26];

export function getStatutoryConfig(country: string, fiscalYear?: string): CountryFiscalConfig {
  const fy = fiscalYear ?? "2025-26";
  const found = STATUTORY_REGISTRY.find((c) => c.country === country && c.fiscalYear === fy);
  return found ?? IN_FY_2025_26;
}

export function calculateIncomeTax(taxableIncome: number, slabs: TaxSlab[]): number {
  let tax = 0;
  for (const slab of slabs) {
    if (taxableIncome <= slab.min) break;
    const taxableInSlab = Math.min(taxableIncome, slab.max) - slab.min;
    tax += (taxableInSlab * slab.rate) / 100;
  }
  return Math.round(tax);
}

export function formatCurrency(
  value: number,
  locale: string,
  currencyCode: string,
): string {
  return value.toLocaleString(locale, { minimumFractionDigits: 2 });
}
