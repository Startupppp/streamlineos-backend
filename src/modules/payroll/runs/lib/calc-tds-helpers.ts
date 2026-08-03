import { calcSlabTaxRupees, type TdsRule } from "./statutory-registry";

export function surchargeRate(taxableRupees: number, regime: "NEW" | "OLD"): number {
  if (taxableRupees <= 5_000_000) return 0;
  if (taxableRupees <= 10_000_000) return 0.1;
  if (taxableRupees <= 20_000_000) return 0.15;
  if (regime === "NEW") return 0.25;
  if (taxableRupees <= 50_000_000) return 0.25;
  return 0.37;
}

export function taxSlabNew(annualGrossPaise: number, tds: TdsRule): number {
  const regime = tds.newRegime;
  const taxablePaise = Math.max(0, annualGrossPaise - regime.standardDeductionPaise);
  const g = taxablePaise / 100;
  const tax = calcSlabTaxRupees(g, regime);
  const surcharge = tax * surchargeRate(g, "NEW");
  return (tax + surcharge) * (1 + parseFloat(tds.cessPercent) / 100);
}

export function taxSlabOld(annualGrossPaise: number, annualDeductionPaise: number, tds: TdsRule): number {
  const regime = tds.oldRegime;
  const totalDeductionPaise = regime.standardDeductionPaise + annualDeductionPaise;
  const taxablePaise = Math.max(0, annualGrossPaise - totalDeductionPaise);
  const g = taxablePaise / 100;
  const tax = calcSlabTaxRupees(g, regime);
  const surcharge = tax * surchargeRate(g, "OLD");
  return (tax + surcharge) * (1 + parseFloat(tds.cessPercent) / 100);
}
