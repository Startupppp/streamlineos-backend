import type {
  PayrollPolicyConfig,
  PayrollToggles,
  PayrollWorkerType,
  CalculationSnapshotLine,
  StatutoryPackConfig,
} from "../../payroll.types";
import { toPaise, fromPaise, pctOf, applyRounding } from "./money";
import type { RoundingConfig } from "./money";
import { getStatutoryPack, type StatutoryPackItem } from "./statutory-packs";
import {
  getIndiaBundleForDate,
  getIndiaBundleForMonth,
  resolvePtMonthly,
  resolveLwf,
  validateLabourCodeWageDefinition,
  STATUTORY_CALCULATION_VERSION,
  type IndiaStatutoryBundle,
} from "./statutory-registry";

interface StatutoryInput {
  workerType: PayrollWorkerType;
  toggles: PayrollToggles;
  config: PayrollPolicyConfig;
  basicPaise: number;
  grossPaise: number;
  rounding: RoundingConfig;
  /** Optional state for PT/LWF; falls back to policy/config. */
  stateCode?: string | null;
  daPaise?: number;
  /** Payroll month "YYYY-MM"; selects the effective statutory bundle. */
  month?: string;
}

interface StatutoryResult {
  lines: CalculationSnapshotLine[];
  totalEmployeeDeductionPaise: number;
  totalEmployerContributionPaise: number;
  ruleVersion?: string;
  calculationVersion?: string;
  wageDefinitionWarning?: string;
}

const SORT_BASE = 900;

function applyPackBrackets(
  basePaise: number,
  brackets: { upToMonthly: string | null; percent: string }[],
): number {
  let taxPaise = 0;
  let previousTopPaise = 0;

  for (const band of brackets) {
    if (basePaise <= previousTopPaise) break;
    const bandTopPaise =
      band.upToMonthly != null
        ? Math.round(parseFloat(band.upToMonthly) * 100)
        : basePaise;
    const amountInBand = Math.min(basePaise, bandTopPaise) - previousTopPaise;
    if (amountInBand > 0) {
      taxPaise += pctOf(amountInBand, band.percent);
    }
    if (band.upToMonthly != null) {
      previousTopPaise = bandTopPaise;
    }
  }

  return taxPaise;
}

function calcPackItem(
  item: StatutoryPackItem,
  percentOverride: string | undefined,
  basicPaise: number,
  grossPaise: number,
  rounding: RoundingConfig,
  sortIndex: number,
): CalculationSnapshotLine | null {
  const effectivePercent = percentOverride ?? item.calc.percent;
  const base =
    item.calc.method === "PERCENT_OF_BASIC" ? basicPaise : grossPaise;

  const wageFloor =
    item.calc.wageFloorMonthly != null
      ? Math.round(parseFloat(item.calc.wageFloorMonthly) * 100)
      : null;

  if (wageFloor != null && grossPaise < wageFloor) {
    return null;
  }

  let rawPaise = 0;
  const steps: string[] = [];

  if (item.calc.method === "FIXED") {
    rawPaise = Math.round(parseFloat(item.calc.fixedAmount ?? "0") * 100);
    steps.push(`${item.label} = ${(rawPaise / 100).toFixed(2)} (fixed)`);
  } else if (
    (item.calc.method === "PERCENT_OF_BASIC" ||
      item.calc.method === "PERCENT_OF_GROSS") &&
    effectivePercent != null
  ) {
    const wageCeiling =
      item.calc.wageCeilingMonthly != null
        ? Math.round(parseFloat(item.calc.wageCeilingMonthly) * 100)
        : null;
    const cappedBase = wageCeiling != null ? Math.min(base, wageCeiling) : base;
    rawPaise = pctOf(cappedBase, effectivePercent);
    const baseLabel =
      item.calc.method === "PERCENT_OF_BASIC" ? "basic" : "gross";
    steps.push(
      wageCeiling != null && base > wageCeiling
        ? `Base = min(${baseLabel} ${(base / 100).toFixed(2)}, ceiling ${(wageCeiling / 100).toFixed(2)}) = ${(cappedBase / 100).toFixed(2)}`
        : `Base = ${baseLabel} ${(base / 100).toFixed(2)}`,
    );
    steps.push(
      `${item.label} = ${(cappedBase / 100).toFixed(2)} × ${effectivePercent}% = ${(rawPaise / 100).toFixed(2)}`,
    );
  } else if (item.calc.method === "BRACKETS" && item.calc.brackets != null) {
    if (item.calc.brackets.length === 0) {
      return null;
    }
    rawPaise = applyPackBrackets(grossPaise, item.calc.brackets);
    steps.push(
      `${item.label} = bracket calc on gross ${(grossPaise / 100).toFixed(2)} = ${(rawPaise / 100).toFixed(2)}`,
    );
    for (const band of item.calc.brackets) {
      steps.push(`  Band ≤ ${band.upToMonthly ?? "∞"}: ${band.percent}%`);
    }
  }

  if (rawPaise <= 0) return null;

  const rounded = applyRounding(rawPaise, rounding);
  const category =
    item.kind === "EMPLOYER_CONTRIBUTION"
      ? "EMPLOYER_CONTRIBUTION"
      : item.kind === "WITHHOLDING"
        ? "TAX"
        : "DEDUCTION";

  return {
    code: item.componentCode,
    name: item.label,
    category,
    amount: fromPaise(rounded),
    calcMethod: item.calc.method === "BRACKETS" ? "FORMULA" : item.calc.method,
    taxable: false,
    sortOrder: SORT_BASE + sortIndex,
    explain: {
      method: item.calc.method === "BRACKETS" ? "FORMULA" : item.calc.method,
      inputs: {
        basic: basicPaise / 100,
        gross: grossPaise / 100,
        percent: effectivePercent != null ? parseFloat(effectivePercent) : 0,
      },
      steps,
      note: item.note,
    },
  };
}

function calcStatutoryFromPack(
  input: StatutoryInput,
  packConfig: StatutoryPackConfig,
): StatutoryResult {
  const { basicPaise, grossPaise, rounding } = input;
  const pack = getStatutoryPack(packConfig.country);

  const lines: CalculationSnapshotLine[] = [];
  let totalEmployeeDeductionPaise = 0;
  let totalEmployerContributionPaise = 0;

  let sortIndex = 1;
  for (const itemCfg of packConfig.items) {
    if (!itemCfg.enabled) continue;
    const packItem = pack.items.find((p) => p.key === itemCfg.key);
    if (!packItem) continue;

    const line = calcPackItem(
      packItem,
      itemCfg.percentOverride,
      basicPaise,
      grossPaise,
      rounding,
      sortIndex,
    );
    if (!line) continue;

    lines.push(line);
    if (line.category === "DEDUCTION" || line.category === "TAX") {
      totalEmployeeDeductionPaise += toPaise(line.amount);
    } else if (line.category === "EMPLOYER_CONTRIBUTION") {
      totalEmployerContributionPaise += toPaise(line.amount);
    }
    sortIndex += 1;
  }

  return { lines, totalEmployeeDeductionPaise, totalEmployerContributionPaise };
}

export function calcStatutory(input: StatutoryInput): StatutoryResult {
  const { workerType, config } = input;

  if (workerType === "CONTRACTOR" || workerType === "CONSULTANT") {
    return {
      lines: [],
      totalEmployeeDeductionPaise: 0,
      totalEmployerContributionPaise: 0,
      calculationVersion: STATUTORY_CALCULATION_VERSION,
    };
  }

  if (config.statutoryPack && config.statutoryPack.country !== "IN") {
    return {
      ...calcStatutoryFromPack(input, config.statutoryPack),
      calculationVersion: STATUTORY_CALCULATION_VERSION,
    };
  }

  return calcStatutoryIndiaFromRegistry(input);
}

/**
 * Canonical India path — all PF/ESI/PT/LWF/gratuity use the versioned registry.
 * Policy config percents/ceilings may still override registry defaults for org customization.
 */
function calcStatutoryIndiaFromRegistry(
  input: StatutoryInput,
): StatutoryResult {
  const {
    toggles,
    config,
    basicPaise,
    grossPaise,
    rounding,
    stateCode,
    daPaise = 0,
  } = input;
  const bundle: IndiaStatutoryBundle = input.month
    ? getIndiaBundleForMonth(input.month)
    : getIndiaBundleForDate();

  const lines: CalculationSnapshotLine[] = [];
  let totalEmployeeDeductionPaise = 0;
  let totalEmployerContributionPaise = 0;

  const wageCheck = validateLabourCodeWageDefinition(
    basicPaise,
    daPaise,
    grossPaise,
    parseFloat(bundle.minWage.basicDaMinPercentOfGross),
  );
  const wageDefinitionWarning = wageCheck.ok ? undefined : wageCheck.message;

  if (toggles.pf) {
    const empPct =
      config.statutory.pfEmployeePercent ?? bundle.pf.employeePercent;
    const erPct =
      config.statutory.pfEmployerPercent ?? bundle.pf.employerPercent;
    // Prefer policy ceiling if set; else registry monthlyWageCeiling (correct name).
    // Policy may still pass the legacy 15000 monthly or misnamed 21600 — prefer explicit monthly.
    const ceilingStr =
      config.statutory.pfWageCeiling != null &&
      config.statutory.pfWageCeiling !== ""
        ? config.statutory.pfWageCeiling
        : bundle.pf.monthlyWageCeiling;
    const ceilingPaise = toPaise(ceilingStr);
    const pfBasePaise = Math.min(basicPaise, ceilingPaise);
    const pfEmpPaise = applyRounding(pctOf(pfBasePaise, empPct), rounding);
    const pfErPaise = applyRounding(pctOf(pfBasePaise, erPct), rounding);

    lines.push({
      code: "EPF_EMPLOYEE",
      name: "EPF Employee",
      category: "DEDUCTION",
      amount: fromPaise(pfEmpPaise),
      calcMethod: "PERCENT_OF_BASIC",
      taxable: false,
      sortOrder: SORT_BASE + 1,
      explain: {
        method: "PERCENT_OF_BASIC",
        inputs: {
          basic: basicPaise / 100,
          monthlyWageCeiling: ceilingPaise / 100,
          pfEmployeePercent: parseFloat(empPct),
        },
        steps: [
          `Rule ${bundle.pf.version}: monthly wage ceiling ₹${(ceilingPaise / 100).toFixed(2)} (legacy misnamed annual field was ${bundle.pf.legacyMisnamedAnnualField})`,
          `PF base = min(Basic ₹${(basicPaise / 100).toFixed(2)}, ceiling ₹${(ceilingPaise / 100).toFixed(2)}) = ₹${(pfBasePaise / 100).toFixed(2)}`,
          `EPF Employee = ₹${(pfBasePaise / 100).toFixed(2)} × ${empPct}% = ₹${(pfEmpPaise / 100).toFixed(2)}`,
        ],
      },
    });

    lines.push({
      code: "EPF_EMPLOYER",
      name: "EPF Employer",
      category: "EMPLOYER_CONTRIBUTION",
      amount: fromPaise(pfErPaise),
      calcMethod: "PERCENT_OF_BASIC",
      taxable: false,
      sortOrder: SORT_BASE + 2,
      explain: {
        method: "PERCENT_OF_BASIC",
        inputs: {
          basic: basicPaise / 100,
          monthlyWageCeiling: ceilingPaise / 100,
          pfEmployerPercent: parseFloat(erPct),
        },
        steps: [
          `PF base = min(Basic ₹${(basicPaise / 100).toFixed(2)}, ceiling ₹${(ceilingPaise / 100).toFixed(2)}) = ₹${(pfBasePaise / 100).toFixed(2)}`,
          `EPF Employer = ₹${(pfBasePaise / 100).toFixed(2)} × ${erPct}% = ₹${(pfErPaise / 100).toFixed(2)}`,
        ],
      },
    });

    totalEmployeeDeductionPaise += pfEmpPaise;
    totalEmployerContributionPaise += pfErPaise;
  }

  if (toggles.esi) {
    const empPct =
      config.statutory.esiEmployeePercent ?? bundle.esi.employeePercent;
    const erPct =
      config.statutory.esiEmployerPercent ?? bundle.esi.employerPercent;
    const ceilingStr =
      config.statutory.esiWageCeiling != null &&
      config.statutory.esiWageCeiling !== ""
        ? config.statutory.esiWageCeiling
        : bundle.esi.monthlyEligibilityCeiling;
    const esiCeilingPaise = toPaise(ceilingStr);
    if (grossPaise <= esiCeilingPaise) {
      const esiEmpPaise = applyRounding(pctOf(grossPaise, empPct), rounding);
      const esiErPaise = applyRounding(pctOf(grossPaise, erPct), rounding);

      lines.push({
        code: "ESI_EMPLOYEE",
        name: "ESI Employee",
        category: "DEDUCTION",
        amount: fromPaise(esiEmpPaise),
        calcMethod: "PERCENT_OF_GROSS",
        taxable: false,
        sortOrder: SORT_BASE + 3,
        explain: {
          method: "PERCENT_OF_GROSS",
          inputs: {
            gross: grossPaise / 100,
            monthlyEligibilityCeiling: esiCeilingPaise / 100,
            esiEmployeePercent: parseFloat(empPct),
          },
          steps: [
            `Rule ${bundle.esi.version}: Gross ₹${(grossPaise / 100).toFixed(2)} ≤ ESI ceiling ₹${(esiCeilingPaise / 100).toFixed(2)}`,
            `ESI Employee = ₹${(grossPaise / 100).toFixed(2)} × ${empPct}% = ₹${(esiEmpPaise / 100).toFixed(2)}`,
          ],
        },
      });

      lines.push({
        code: "ESI_EMPLOYER",
        name: "ESI Employer",
        category: "EMPLOYER_CONTRIBUTION",
        amount: fromPaise(esiErPaise),
        calcMethod: "PERCENT_OF_GROSS",
        taxable: false,
        sortOrder: SORT_BASE + 4,
        explain: {
          method: "PERCENT_OF_GROSS",
          inputs: {
            gross: grossPaise / 100,
            esiEmployerPercent: parseFloat(erPct),
          },
          steps: [
            `ESI Employer = ₹${(grossPaise / 100).toFixed(2)} × ${erPct}% = ₹${(esiErPaise / 100).toFixed(2)}`,
          ],
        },
      });

      totalEmployeeDeductionPaise += esiEmpPaise;
      totalEmployerContributionPaise += esiErPaise;
    }
  }

  if (toggles.professionalTax) {
    const ptMonthly =
      config.statutory.professionalTaxMonthly != null &&
      config.statutory.professionalTaxMonthly !== ""
        ? config.statutory.professionalTaxMonthly
        : resolvePtMonthly(bundle, stateCode);
    const ptRounded = applyRounding(toPaise(ptMonthly), rounding);
    lines.push({
      code: "PROFESSIONAL_TAX",
      name: "Professional Tax",
      category: "DEDUCTION",
      amount: fromPaise(ptRounded),
      calcMethod: "FIXED",
      taxable: false,
      sortOrder: SORT_BASE + 5,
      explain: {
        method: "FIXED",
        inputs: {
          professionalTaxMonthly: ptRounded / 100,
        },
        steps: [
          `Rule ${bundle.pt.version}${stateCode ? ` (state ${stateCode})` : ""}`,
          `Professional Tax = ₹${(ptRounded / 100).toFixed(2)} (fixed monthly)`,
        ],
      },
    });
    totalEmployeeDeductionPaise += ptRounded;
  }

  if (toggles.gratuity) {
    const pct = bundle.gratuity.provisionPercentOfBasic;
    const gratuityPaise = applyRounding(pctOf(basicPaise, pct), rounding);
    lines.push({
      code: "GRATUITY",
      name: "Gratuity",
      category: "EMPLOYER_CONTRIBUTION",
      amount: fromPaise(gratuityPaise),
      calcMethod: "PERCENT_OF_BASIC",
      taxable: false,
      sortOrder: SORT_BASE + 6,
      explain: {
        method: "PERCENT_OF_BASIC",
        inputs: {
          basic: basicPaise / 100,
          gratuityPercent: parseFloat(pct),
        },
        steps: [
          `Rule ${bundle.gratuity.version}: provision ${pct}% of basic (eligibility ${bundle.gratuity.eligibilityYears}y service for payout)`,
          `Gratuity = Basic ₹${(basicPaise / 100).toFixed(2)} × ${pct}% = ₹${(gratuityPaise / 100).toFixed(2)}`,
        ],
      },
    });
    totalEmployerContributionPaise += gratuityPaise;
  }

  if (toggles.lwf) {
    const lwf = resolveLwf(bundle, stateCode);
    const lwfEmpRounded = applyRounding(toPaise(lwf.employeeFixed), rounding);
    const lwfErRounded = applyRounding(toPaise(lwf.employerFixed), rounding);

    lines.push({
      code: "LWF_EMPLOYEE",
      name: "LWF Employee",
      category: "DEDUCTION",
      amount: fromPaise(lwfEmpRounded),
      calcMethod: "FIXED",
      taxable: false,
      sortOrder: SORT_BASE + 7,
      explain: {
        method: "FIXED",
        inputs: { lwfEmployee: lwfEmpRounded / 100 },
        steps: [
          `Rule ${bundle.lwf.version}${stateCode ? ` (state ${stateCode})` : ""}`,
          `LWF Employee = ₹${(lwfEmpRounded / 100).toFixed(2)} (fixed)`,
        ],
      },
    });

    lines.push({
      code: "LWF_EMPLOYER",
      name: "LWF Employer",
      category: "EMPLOYER_CONTRIBUTION",
      amount: fromPaise(lwfErRounded),
      calcMethod: "FIXED",
      taxable: false,
      sortOrder: SORT_BASE + 8,
      explain: {
        method: "FIXED",
        inputs: { lwfEmployer: lwfErRounded / 100 },
        steps: [`LWF Employer = ₹${(lwfErRounded / 100).toFixed(2)} (fixed)`],
      },
    });

    totalEmployeeDeductionPaise += lwfEmpRounded;
    totalEmployerContributionPaise += lwfErRounded;
  }

  return {
    lines,
    totalEmployeeDeductionPaise,
    totalEmployerContributionPaise,
    ruleVersion: bundle.bundleVersion,
    calculationVersion: STATUTORY_CALCULATION_VERSION,
    wageDefinitionWarning,
  };
}
