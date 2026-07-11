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
    annualWageCeiling: number;
  };
  esi: {
    employeePercent: number;
    employerPercent: number;
    monthlyWageCeiling: number;
  };
  professionalTaxAnnual: number;
  salaryBands: SalaryBand[];
}

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
    standardDeduction: 75000,
    cessPercent: 4,
  },
  pf: {
    employeePercent: 12,
    employerPercent: 12,
    annualWageCeiling: 21600,
  },
  esi: {
    employeePercent: 0.75,
    employerPercent: 3.25,
    monthlyWageCeiling: 21000,
  },
  professionalTaxAnnual: 2400,
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
