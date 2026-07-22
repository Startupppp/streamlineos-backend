import { toPaise, fromPaise, pctOf, applyRounding } from "./money";
import type { RoundingConfig } from "./money";
import {
  getIndiaBundleForDate,
  calcHraExemptionPaise,
  type IndiaStatutoryBundle,
} from "./statutory-registry";

export interface TdsMonthlyInput {
  monthlyTaxablePaise: number;
  /** Months remaining in FY including current (1–12). */
  monthsRemainingInFy: number;
  ytdTaxablePaise: number;
  ytdTdsPaise: number;
  previousEmployerIncomePaise: number;
  previousEmployerTdsPaise: number;
  perquisitesPaise: number;
  section80cPaise: number;
  section80dPaise: number;
  homeLoanInterestPaise: number;
  section80gPaise: number;
  hraExemptionPaise: number;
  regime: "OLD" | "NEW";
  rounding: RoundingConfig;
  bundle?: IndiaStatutoryBundle;
}

export interface TdsMonthlyResult {
  monthlyTdsPaise: number;
  annualProjectedTaxablePaise: number;
  annualTaxPaise: number;
  surchargePaise: number;
  cessPaise: number;
  rebatePaise: number;
  ruleVersion: string;
  formLabels: { quarterlyReturn: string; annualCertificate: string };
  ruleYearLabel: string;
  steps: string[];
}

/** Simplified new-regime slab for FY 2025-26 (illustrative production defaults). */
function newRegimeTaxPaise(annualTaxablePaise: number): number {
  // Slabs: 0–3L nil, 3–7L 5%, 7–10L 10%, 10–12L 15%, 12–15L 20%, 15L+ 30%
  const slabs: { upTo: number; rate: number }[] = [
    { upTo: 30000000, rate: 0 },
    { upTo: 70000000, rate: 5 },
    { upTo: 100000000, rate: 10 },
    { upTo: 120000000, rate: 15 },
    { upTo: 150000000, rate: 20 },
    { upTo: Infinity, rate: 30 },
  ];
  let tax = 0;
  let prev = 0;
  for (const s of slabs) {
    if (annualTaxablePaise <= prev) break;
    const band = Math.min(annualTaxablePaise, s.upTo) - prev;
    if (band > 0) tax += Math.round((band * s.rate) / 100);
    prev = s.upTo;
  }
  return tax;
}

export function calcMonthlyTds(input: TdsMonthlyInput): TdsMonthlyResult {
  const bundle = input.bundle ?? getIndiaBundleForDate();
  const steps: string[] = [];

  const remaining = Math.max(1, input.monthsRemainingInFy);
  const projectedAnnual =
    input.ytdTaxablePaise +
    input.monthlyTaxablePaise * remaining +
    input.previousEmployerIncomePaise +
    input.perquisitesPaise;

  steps.push(
    `Projected annual taxable (pre-deductions) = YTD ${(input.ytdTaxablePaise / 100).toFixed(2)} + monthly × ${remaining} + prev employer + perqs = ₹${(projectedAnnual / 100).toFixed(2)}`,
  );

  let taxable = projectedAnnual;
  if (input.regime === "NEW") {
    taxable -= bundle.tds.newRegimeStandardDeductionPaise;
    steps.push(`Less standard deduction ₹${(bundle.tds.newRegimeStandardDeductionPaise / 100).toFixed(2)}`);
  } else {
    const chapterVia =
      input.section80cPaise +
      input.section80dPaise +
      input.homeLoanInterestPaise +
      input.section80gPaise +
      input.hraExemptionPaise;
    taxable -= chapterVia;
    steps.push(`Less Chapter VI-A + HRA exemption ₹${(chapterVia / 100).toFixed(2)}`);
  }
  taxable = Math.max(0, taxable);

  let tax = newRegimeTaxPaise(taxable);
  steps.push(`Slab tax on ₹${(taxable / 100).toFixed(2)} = ₹${(tax / 100).toFixed(2)}`);

  let rebate = 0;
  if (taxable <= bundle.tds.rebate87AIncomeLimitPaise) {
    rebate = Math.min(tax, bundle.tds.rebate87AMaxPaise);
    tax -= rebate;
    steps.push(`Rebate u/s 87A = ₹${(rebate / 100).toFixed(2)}`);
  }

  // Surcharge simplified: 10% above 50L, 15% above 1Cr (taxable income)
  let surcharge = 0;
  if (taxable > 1000000000) surcharge = Math.round(tax * 0.15);
  else if (taxable > 500000000) surcharge = Math.round(tax * 0.1);
  tax += surcharge;
  if (surcharge > 0) steps.push(`Surcharge = ₹${(surcharge / 100).toFixed(2)}`);

  const cess = pctOf(tax, bundle.tds.cessPercent);
  tax += cess;
  steps.push(`Health & education cess ${bundle.tds.cessPercent}% = ₹${(cess / 100).toFixed(2)}`);

  const alreadyPaid = input.ytdTdsPaise + input.previousEmployerTdsPaise;
  const remainingTax = Math.max(0, tax - alreadyPaid);
  const monthly = applyRounding(Math.round(remainingTax / remaining), input.rounding);

  steps.push(
    `Remaining tax ₹${(remainingTax / 100).toFixed(2)} / ${remaining} months = ₹${(monthly / 100).toFixed(2)}`,
  );

  return {
    monthlyTdsPaise: monthly,
    annualProjectedTaxablePaise: taxable,
    annualTaxPaise: tax,
    surchargePaise: surcharge,
    cessPaise: cess,
    rebatePaise: rebate,
    ruleVersion: bundle.tds.version,
    formLabels: bundle.tds.formLabels,
    ruleYearLabel: bundle.tds.ruleYearLabel,
    steps,
  };
}

export function calcHraForMonth(input: {
  basic: string;
  hraReceived: string;
  rentPaid: string;
  city?: string | null;
}): { exemption: string; steps: string[] } {
  const bundle = getIndiaBundleForDate();
  const isMetro = !!input.city && bundle.hra.metroCities.some(
    (c) => c.toLowerCase() === input.city!.toLowerCase(),
  );
  const { exemptionPaise, steps } = calcHraExemptionPaise({
    basicPaise: toPaise(input.basic),
    hraReceivedPaise: toPaise(input.hraReceived),
    rentPaidPaise: toPaise(input.rentPaid),
    isMetro,
    rule: bundle.hra,
  });
  return { exemption: fromPaise(exemptionPaise), steps };
}
