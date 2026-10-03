/**
 * Canonical versioned India statutory rule registry.
 * Single source of truth for PF/ESI/PT/LWF/gratuity/min-wage/HRA/TDS defaults.
 *
 * Historical note: a legacy config field was named `annualWageCeiling: 21600`.
 * Arithmetic used it as the *monthly* wage ceiling in rupees for PF
 * (₹15,000 × 12% = ₹1,800/mo → ₹21,600/yr max employee PF). We preserve
 * that arithmetic via monthlyWageCeiling = 15000 and document the rename.
 */

export const STATUTORY_CALCULATION_VERSION = "1.1.0";
export const IN_STATUTORY_RULE_BUNDLE_VERSION = "IN-2025.04";
export const IN_STATUTORY_RULE_BUNDLE_VERSION_2026 = "IN-2026.04";

export interface PfRule {
  version: string;
  employeePercent: string;
  employerPercent: string;
  /** Correct field: monthly wage ceiling for PF base (₹15,000). */
  monthlyWageCeiling: string;
  /** Legacy misnamed value kept for migration diagnostics only. */
  legacyMisnamedAnnualField: string;
}

export interface EsiRule {
  version: string;
  employeePercent: string;
  employerPercent: string;
  monthlyEligibilityCeiling: string;
}

export interface PtSlab {
  grossUpTo: number | null;
  monthly: string;
  february?: string;
}

export interface PtRule {
  version: string;
  defaultMonthly: string;
  /** State → monthly amount overrides */
  byState: Record<string, string>;
  slabsByState?: Record<string, PtSlab[]>;
}

export interface LwfRule {
  version: string;
  employeeFixed: string;
  employerFixed: string;
  byState: Record<string, { employeeFixed: string; employerFixed: string }>;
}

export interface GratuityRule {
  version: string;
  provisionPercentOfBasic: string;
  eligibilityYears: number;
  wageBase: "last_drawn_basic_da";
}

export interface HraRule {
  version: string;
  metroCities: string[];
  metroPercentOfBasic: string;
  nonMetroPercentOfBasic: string;
}

export interface MinWageRule {
  version: string;
  basicDaMinPercentOfGross: string;
  labourCodeWageDefinition: true;
}

export interface TaxSlab {
  /** Upper bound of the slab in rupees of taxable income; null = no upper bound. */
  uptoRupees: number | null;
  percent: number;
}

export interface TdsRegimeRule {
  standardDeductionPaise: number;
  slabs: TaxSlab[];
  rebateMaxPaise: number;
  rebateIncomeLimitPaise: number;
}

export interface TdsRule {
  version: string;
  ruleYearLabel: string;
  formLabels: { quarterlyReturn: string; annualCertificate: string };
  newRegime: TdsRegimeRule;
  oldRegime: TdsRegimeRule;
  cessPercent: string;
}

export interface IndiaStatutoryBundle {
  bundleVersion: string;
  effectiveFrom: string;
  pf: PfRule;
  esi: EsiRule;
  pt: PtRule;
  lwf: LwfRule;
  gratuity: GratuityRule;
  hra: HraRule;
  minWage: MinWageRule;
  tds: TdsRule;
}

export const IN_STATUTORY_2025_04: IndiaStatutoryBundle = {
  bundleVersion: IN_STATUTORY_RULE_BUNDLE_VERSION,
  effectiveFrom: "2025-04-01",
  pf: {
    version: "IN-PF-2025.04",
    employeePercent: "12",
    employerPercent: "12",
    monthlyWageCeiling: "15000.00",
    legacyMisnamedAnnualField: "21600",
  },
  esi: {
    version: "IN-ESI-2025.04",
    employeePercent: "0.75",
    employerPercent: "3.25",
    monthlyEligibilityCeiling: "21000.00",
  },
  pt: {
    version: "IN-PT-DEFAULT-2025.04",
    defaultMonthly: "200.00",
    /** Sample state map — not full India matrix; legal review required for production PT. */
    byState: {
      MH: "200.00",
      KA: "200.00",
      TN: "208.33",
      WB: "150.00",
      GJ: "200.00",
      TL: "200.00",
      AP: "200.00",
      TS: "200.00",
      DL: "0.00",
      HR: "200.00",
      PB: "200.00",
      RJ: "200.00",
      MP: "200.00",
      UP: "200.00",
      BR: "0.00",
      OR: "200.00",
      KL: "0.00",
      AS: "0.00",
    },
    slabsByState: {
      MH: [
        { grossUpTo: 7500, monthly: "0.00" },
        { grossUpTo: 10000, monthly: "175.00" },
        { grossUpTo: null, monthly: "200.00", february: "300.00" },
      ],
      KA: [
        { grossUpTo: 24999.99, monthly: "0.00" },
        { grossUpTo: null, monthly: "200.00" },
      ],
      WB: [
        { grossUpTo: 10000, monthly: "0.00" },
        { grossUpTo: 15000, monthly: "110.00" },
        { grossUpTo: 25000, monthly: "130.00" },
        { grossUpTo: 40000, monthly: "150.00" },
        { grossUpTo: null, monthly: "200.00" },
      ],
      GJ: [
        { grossUpTo: 11999.99, monthly: "0.00" },
        { grossUpTo: null, monthly: "200.00" },
      ],
      TS: [
        { grossUpTo: 15000, monthly: "0.00" },
        { grossUpTo: 20000, monthly: "150.00" },
        { grossUpTo: null, monthly: "200.00" },
      ],
      TL: [
        { grossUpTo: 15000, monthly: "0.00" },
        { grossUpTo: 20000, monthly: "150.00" },
        { grossUpTo: null, monthly: "200.00" },
      ],
      AP: [
        { grossUpTo: 15000, monthly: "0.00" },
        { grossUpTo: 20000, monthly: "150.00" },
        { grossUpTo: null, monthly: "200.00" },
      ],
    },
  },
  lwf: {
    version: "IN-LWF-DEFAULT-2025.04",
    employeeFixed: "25.00",
    employerFixed: "25.00",
    /** Sample state map — not full India matrix; legal review required for production LWF. */
    byState: {
      MH: { employeeFixed: "25.00", employerFixed: "75.00" },
      KA: { employeeFixed: "20.00", employerFixed: "40.00" },
      TN: { employeeFixed: "20.00", employerFixed: "40.00" },
      WB: { employeeFixed: "3.00", employerFixed: "15.00" },
      GJ: { employeeFixed: "6.00", employerFixed: "12.00" },
      DL: { employeeFixed: "0.75", employerFixed: "2.25" },
      HR: { employeeFixed: "25.00", employerFixed: "50.00" },
      PB: { employeeFixed: "5.00", employerFixed: "20.00" },
      KL: { employeeFixed: "20.00", employerFixed: "20.00" },
      MP: { employeeFixed: "10.00", employerFixed: "30.00" },
    },
  },
  gratuity: {
    version: "IN-GRATUITY-2025.04",
    provisionPercentOfBasic: "4.81",
    eligibilityYears: 5,
    wageBase: "last_drawn_basic_da",
  },
  hra: {
    version: "IN-HRA-2025.04",
    metroCities: ["Mumbai", "Delhi", "Kolkata", "Chennai"],
    metroPercentOfBasic: "50",
    nonMetroPercentOfBasic: "40",
  },
  minWage: {
    version: "IN-MINWAGE-LABOUR-CODE",
    basicDaMinPercentOfGross: "50",
    labourCodeWageDefinition: true,
  },
  tds: {
    version: "IN-TDS-2025.04",
    ruleYearLabel: "FY 2025-26",
    formLabels: {
      quarterlyReturn: "Form 24Q",
      annualCertificate: "Form 16",
    },
    newRegime: {
      standardDeductionPaise: 7_500_000,
      slabs: [
        { uptoRupees: 300_000, percent: 0 },
        { uptoRupees: 700_000, percent: 5 },
        { uptoRupees: 1_000_000, percent: 10 },
        { uptoRupees: 1_200_000, percent: 15 },
        { uptoRupees: 1_500_000, percent: 20 },
        { uptoRupees: null, percent: 30 },
      ],
      rebateMaxPaise: 2_500_000,
      rebateIncomeLimitPaise: 70_000_000,
    },
    oldRegime: {
      standardDeductionPaise: 5_000_000,
      slabs: [
        { uptoRupees: 250_000, percent: 0 },
        { uptoRupees: 500_000, percent: 5 },
        { uptoRupees: 1_000_000, percent: 20 },
        { uptoRupees: null, percent: 30 },
      ],
      rebateMaxPaise: 1_250_000,
      rebateIncomeLimitPaise: 50_000_000,
    },
    cessPercent: "4",
  },
};

/**
 * FY 2026-27 pack (Income-tax Act, 2025 effective 1 Apr 2026): revised new-regime
 * slabs, §87A rebate ₹60,000 up to ₹12,00,000 taxable income, and renamed forms
 * (quarterly salary TDS statement Form 138; annual certificate Form 130).
 * PF/ESI ceilings unchanged; PT/LWF matrices carried forward and still require
 * legal review before production filing claims.
 */
export const IN_STATUTORY_2026_04: IndiaStatutoryBundle = {
  bundleVersion: IN_STATUTORY_RULE_BUNDLE_VERSION_2026,
  effectiveFrom: "2026-04-01",
  pf: { ...IN_STATUTORY_2025_04.pf, version: "IN-PF-2026.04" },
  esi: { ...IN_STATUTORY_2025_04.esi, version: "IN-ESI-2026.04" },
  pt: { ...IN_STATUTORY_2025_04.pt, version: "IN-PT-DEFAULT-2026.04" },
  lwf: { ...IN_STATUTORY_2025_04.lwf, version: "IN-LWF-DEFAULT-2026.04" },
  gratuity: { ...IN_STATUTORY_2025_04.gratuity, version: "IN-GRATUITY-2026.04" },
  hra: { ...IN_STATUTORY_2025_04.hra, version: "IN-HRA-2026.04" },
  minWage: IN_STATUTORY_2025_04.minWage,
  tds: {
    version: "IN-TDS-2026.04",
    ruleYearLabel: "FY 2026-27",
    formLabels: {
      quarterlyReturn: "Form 138",
      annualCertificate: "Form 130",
    },
    newRegime: {
      standardDeductionPaise: 7_500_000,
      slabs: [
        { uptoRupees: 400_000, percent: 0 },
        { uptoRupees: 800_000, percent: 5 },
        { uptoRupees: 1_200_000, percent: 10 },
        { uptoRupees: 1_600_000, percent: 15 },
        { uptoRupees: 2_000_000, percent: 20 },
        { uptoRupees: 2_400_000, percent: 25 },
        { uptoRupees: null, percent: 30 },
      ],
      rebateMaxPaise: 6_000_000,
      rebateIncomeLimitPaise: 120_000_000,
    },
    oldRegime: { ...IN_STATUTORY_2025_04.tds.oldRegime },
    cessPercent: "4",
  },
};

const IN_BUNDLES_DESC: IndiaStatutoryBundle[] = [IN_STATUTORY_2026_04, IN_STATUTORY_2025_04];

/** Compute annual income tax in rupees from a regime rule (slabs + rebate, before surcharge/cess). */
export function calcSlabTaxRupees(taxableRupees: number, regime: TdsRegimeRule): number {
  let tax = 0;
  let lower = 0;
  for (const slab of regime.slabs) {
    const upper = slab.uptoRupees ?? Number.POSITIVE_INFINITY;
    if (taxableRupees > lower) {
      tax += (Math.min(taxableRupees, upper) - lower) * (slab.percent / 100);
    }
    lower = upper;
  }
  if (taxableRupees * 100 <= regime.rebateIncomeLimitPaise) {
    tax = Math.max(0, tax - regime.rebateMaxPaise / 100);
  }
  return tax;
}

/** Resolve PT monthly amount for a state (falls back to default). */
export function resolvePtMonthly(
  bundle: IndiaStatutoryBundle,
  stateCode?: string | null,
  monthlyGrossRupees?: number,
  month?: string,
): string {
  const slabs = stateCode ? bundle.pt.slabsByState?.[stateCode.toUpperCase()] : undefined;
  if (slabs && monthlyGrossRupees != null) {
    const slab = slabs.find((s) => s.grossUpTo == null || monthlyGrossRupees <= s.grossUpTo);
    if (slab) return month?.endsWith("-02") && slab.february ? slab.february : slab.monthly;
  }
  if (stateCode && bundle.pt.byState[stateCode.toUpperCase()]) {
    return bundle.pt.byState[stateCode.toUpperCase()];
  }
  return bundle.pt.defaultMonthly;
}

/** Resolve LWF fixed amounts for a state. */
export function resolveLwf(
  bundle: IndiaStatutoryBundle,
  stateCode?: string | null,
): { employeeFixed: string; employerFixed: string } {
  if (stateCode && bundle.lwf.byState[stateCode.toUpperCase()]) {
    return bundle.lwf.byState[stateCode.toUpperCase()];
  }
  return {
    employeeFixed: bundle.lwf.employeeFixed,
    employerFixed: bundle.lwf.employerFixed,
  };
}

/**
 * Labour Code wage-definition check: basic+DA should be ≥ 50% of gross wages.
 * Returns null if valid, or a warning message if violated.
 */
export function validateLabourCodeWageDefinition(
  basicPaise: number,
  daPaise: number,
  grossPaise: number,
  minPercent = 50,
): { ok: true } | { ok: false; basicDaPercent: number; message: string } {
  if (grossPaise <= 0) return { ok: true };
  const basicDa = basicPaise + daPaise;
  const pct = (basicDa / grossPaise) * 100;
  if (pct + 1e-9 >= minPercent) return { ok: true };
  return {
    ok: false,
    basicDaPercent: Math.round(pct * 100) / 100,
    message: `Labour Code wage definition: Basic+DA is ${pct.toFixed(1)}% of gross (minimum ${minPercent}%).`,
  };
}

/**
 * HRA exemption under s.10(13A) — min of:
 * 1. Actual HRA received
 * 2. Rent paid − 10% of basic
 * 3. 50% (metro) or 40% (non-metro) of basic
 */
export function calcHraExemptionPaise(input: {
  basicPaise: number;
  hraReceivedPaise: number;
  rentPaidPaise: number;
  isMetro: boolean;
  rule?: HraRule;
}): { exemptionPaise: number; steps: string[] } {
  const rule = input.rule ?? IN_STATUTORY_2025_04.hra;
  const pct = input.isMetro ? rule.metroPercentOfBasic : rule.nonMetroPercentOfBasic;
  const pctOfBasic = Math.round((input.basicPaise * parseFloat(pct)) / 100);
  const rentMinus10 = Math.max(0, input.rentPaidPaise - Math.round(input.basicPaise * 0.1));
  const exemptionPaise = Math.max(
    0,
    Math.min(input.hraReceivedPaise, rentMinus10, pctOfBasic),
  );
  const steps = [
    `Actual HRA received = ₹${(input.hraReceivedPaise / 100).toFixed(2)}`,
    `Rent − 10% of basic = ₹${(rentMinus10 / 100).toFixed(2)}`,
    `${pct}% of basic (${input.isMetro ? "metro" : "non-metro"}) = ₹${(pctOfBasic / 100).toFixed(2)}`,
    `HRA exemption = min(...) = ₹${(exemptionPaise / 100).toFixed(2)}`,
  ];
  return { exemptionPaise, steps };
}

export function getIndiaBundleForDate(asOf = new Date()): IndiaStatutoryBundle {
  const asOfIso = asOf.toISOString().slice(0, 10);
  for (const bundle of IN_BUNDLES_DESC) {
    if (bundle.effectiveFrom <= asOfIso) return bundle;
  }
  return IN_BUNDLES_DESC[IN_BUNDLES_DESC.length - 1];
}

/** Resolve the India bundle for a payroll month ("YYYY-MM") using the month end. */
export function getIndiaBundleForMonth(month: string): IndiaStatutoryBundle {
  const [yearStr, monStr] = month.split("-");
  const year = Number.parseInt(yearStr ?? "", 10);
  const mon = Number.parseInt(monStr ?? "", 10);
  if (!Number.isFinite(year) || !Number.isFinite(mon)) return getIndiaBundleForDate();
  return getIndiaBundleForDate(new Date(Date.UTC(year, mon, 0)));
}
