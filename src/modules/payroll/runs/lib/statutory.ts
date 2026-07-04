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

interface StatutoryInput {
  workerType: PayrollWorkerType;
  toggles: PayrollToggles;
  config: PayrollPolicyConfig;
  basicPaise: number;
  grossPaise: number;
  rounding: RoundingConfig;
}

interface StatutoryResult {
  lines: CalculationSnapshotLine[];
  totalEmployeeDeductionPaise: number;
  totalEmployerContributionPaise: number;
}

const LWF_EMPLOYEE_PAISE = 2500;
const LWF_EMPLOYER_PAISE = 2500;
const GRATUITY_PERCENT = "4.81";
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
      band.upToMonthly != null ? Math.round(parseFloat(band.upToMonthly) * 100) : basePaise;
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
  const base = item.calc.method === "PERCENT_OF_BASIC" ? basicPaise : grossPaise;

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
    (item.calc.method === "PERCENT_OF_BASIC" || item.calc.method === "PERCENT_OF_GROSS") &&
    effectivePercent != null
  ) {
    const wageCeiling =
      item.calc.wageCeilingMonthly != null
        ? Math.round(parseFloat(item.calc.wageCeilingMonthly) * 100)
        : null;
    const cappedBase = wageCeiling != null ? Math.min(base, wageCeiling) : base;
    rawPaise = pctOf(cappedBase, effectivePercent);
    const baseLabel = item.calc.method === "PERCENT_OF_BASIC" ? "basic" : "gross";
    steps.push(
      wageCeiling != null && base > wageCeiling
        ? `Base = min(${baseLabel} ${(base / 100).toFixed(2)}, ceiling ${(wageCeiling / 100).toFixed(2)}) = ${(cappedBase / 100).toFixed(2)}`
        : `Base = ${baseLabel} ${(base / 100).toFixed(2)}`,
    );
    steps.push(`${item.label} = ${(cappedBase / 100).toFixed(2)} × ${effectivePercent}% = ${(rawPaise / 100).toFixed(2)}`);
  } else if (item.calc.method === "BRACKETS" && item.calc.brackets != null) {
    if (item.calc.brackets.length === 0) {
      return null;
    }
    rawPaise = applyPackBrackets(grossPaise, item.calc.brackets);
    steps.push(`${item.label} = bracket calc on gross ${(grossPaise / 100).toFixed(2)} = ${(rawPaise / 100).toFixed(2)}`);
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
  const { workerType, toggles, config, basicPaise, grossPaise, rounding } = input;

  if (workerType === "CONTRACTOR" || workerType === "CONSULTANT") {
    return { lines: [], totalEmployeeDeductionPaise: 0, totalEmployerContributionPaise: 0 };
  }

  if (config.statutoryPack && config.statutoryPack.country !== "IN") {
    return calcStatutoryFromPack(input, config.statutoryPack);
  }

  return calcStatutoryLegacyIN(input);
}

function calcStatutoryLegacyIN(input: StatutoryInput): StatutoryResult {
  const { workerType, toggles, config, basicPaise, grossPaise, rounding } = input;

  const lines: CalculationSnapshotLine[] = [];
  let totalEmployeeDeductionPaise = 0;
  let totalEmployerContributionPaise = 0;

  if (toggles.pf) {
    const { pfEmployeePercent, pfEmployerPercent, pfWageCeiling } = config.statutory;
    const ceilingPaise = pfWageCeiling != null ? toPaise(pfWageCeiling) : Infinity;
    const pfBasePaise = Math.min(basicPaise, ceilingPaise);
    const pfEmpPaise = applyRounding(pctOf(pfBasePaise, pfEmployeePercent), rounding);
    const pfErPaise = applyRounding(pctOf(pfBasePaise, pfEmployerPercent), rounding);

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
        inputs: { basic: basicPaise / 100, pfWageCeiling: pfBasePaise / 100, pfEmployeePercent: parseFloat(pfEmployeePercent) },
        steps: [
          `PF base = min(Basic ₹${(basicPaise / 100).toFixed(2)}, ceiling ₹${pfBasePaise === Infinity ? "∞" : (pfBasePaise / 100).toFixed(2)}) = ₹${(pfBasePaise / 100).toFixed(2)}`,
          `EPF Employee = ₹${(pfBasePaise / 100).toFixed(2)} × ${pfEmployeePercent}% = ₹${(pfEmpPaise / 100).toFixed(2)}`,
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
        inputs: { basic: basicPaise / 100, pfWageCeiling: pfBasePaise / 100, pfEmployerPercent: parseFloat(pfEmployerPercent) },
        steps: [
          `PF base = min(Basic ₹${(basicPaise / 100).toFixed(2)}, ceiling ₹${pfBasePaise === Infinity ? "∞" : (pfBasePaise / 100).toFixed(2)}) = ₹${(pfBasePaise / 100).toFixed(2)}`,
          `EPF Employer = ₹${(pfBasePaise / 100).toFixed(2)} × ${pfEmployerPercent}% = ₹${(pfErPaise / 100).toFixed(2)}`,
        ],
      },
    });

    totalEmployeeDeductionPaise += pfEmpPaise;
    totalEmployerContributionPaise += pfErPaise;
  }

  if (toggles.esi) {
    const { esiEmployeePercent, esiEmployerPercent, esiWageCeiling } = config.statutory;
    const esiCeilingPaise = esiWageCeiling != null ? toPaise(esiWageCeiling) : 999999999;
    if (grossPaise <= esiCeilingPaise) {
      const esiEmpPaise = applyRounding(pctOf(grossPaise, esiEmployeePercent), rounding);
      const esiErPaise = applyRounding(pctOf(grossPaise, esiEmployerPercent), rounding);

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
          inputs: { gross: grossPaise / 100, esiWageCeiling: esiCeilingPaise / 100, esiEmployeePercent: parseFloat(esiEmployeePercent) },
          steps: [
            `Gross ₹${(grossPaise / 100).toFixed(2)} ≤ ESI ceiling ₹${(esiCeilingPaise / 100).toFixed(2)}`,
            `ESI Employee = ₹${(grossPaise / 100).toFixed(2)} × ${esiEmployeePercent}% = ₹${(esiEmpPaise / 100).toFixed(2)}`,
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
          inputs: { gross: grossPaise / 100, esiEmployerPercent: parseFloat(esiEmployerPercent) },
          steps: [
            `ESI Employer = ₹${(grossPaise / 100).toFixed(2)} × ${esiEmployerPercent}% = ₹${(esiErPaise / 100).toFixed(2)}`,
          ],
        },
      });

      totalEmployeeDeductionPaise += esiEmpPaise;
      totalEmployerContributionPaise += esiErPaise;
    }
  }

  if (toggles.professionalTax) {
    const ptPaise = toPaise(config.statutory.professionalTaxMonthly);
    const ptRounded = applyRounding(ptPaise, rounding);
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
        inputs: { professionalTaxMonthly: ptRounded / 100 },
        steps: [`Professional Tax = ₹${(ptRounded / 100).toFixed(2)} (fixed monthly)`],
      },
    });
    totalEmployeeDeductionPaise += ptRounded;
  }

  if (toggles.gratuity) {
    const gratuityPaise = applyRounding(pctOf(basicPaise, GRATUITY_PERCENT), rounding);
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
        inputs: { basic: basicPaise / 100, gratuityPercent: parseFloat(GRATUITY_PERCENT) },
        steps: [`Gratuity = Basic ₹${(basicPaise / 100).toFixed(2)} × 4.81% = ₹${(gratuityPaise / 100).toFixed(2)}`],
      },
    });
    totalEmployerContributionPaise += gratuityPaise;
  }

  if (toggles.lwf) {
    const lwfEmpRounded = applyRounding(LWF_EMPLOYEE_PAISE, rounding);
    const lwfErRounded = applyRounding(LWF_EMPLOYER_PAISE, rounding);

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
        steps: [`LWF Employee = ₹${(lwfEmpRounded / 100).toFixed(2)} (fixed)`],
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

  return { lines, totalEmployeeDeductionPaise, totalEmployerContributionPaise };
}
