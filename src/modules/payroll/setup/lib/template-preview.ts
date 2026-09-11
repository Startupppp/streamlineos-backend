import type { TemplateComponentDef, MoneyString, FormulaScope } from "../../payroll.types";
import { FORMULA_VARIABLES } from "../../payroll.types";
import { toPaise } from "../../runs/lib/money";

export interface PreviewLine {
  code: string;
  name: string;
  type: TemplateComponentDef["type"];
  monthlyAmount: MoneyString;
  calcMethod: TemplateComponentDef["calcMethod"];
  taxable: boolean;
  includeInCtc: boolean;
  isStatutory: boolean;
  sortOrder: number;
  explain: string;
}

export interface TemplatePreviewResult {
  annualCtc: number;
  monthlyCtc: number;
  components: PreviewLine[];
  totals: {
    grossEarnings: MoneyString;
    totalDeductions: MoneyString;
    employerContributions: MoneyString;
    netTakeHome: MoneyString;
  };
}

function safeEvalFormula(formula: string, scope: FormulaScope): number {
  const args = FORMULA_VARIABLES.join(", ");
  const values = FORMULA_VARIABLES.map((k) => scope[k]);
  try {
    const fn = new Function(args, `"use strict"; return (${formula});`) as (...a: number[]) => number;
    const result = fn(...values);
    if (typeof result !== "number" || !isFinite(result)) return 0;
    return Math.max(0, result);
  } catch {
    return 0;
  }
}

function toDecimalString(paise: number): MoneyString {
  return (Math.round(paise * 100) / 100).toFixed(2);
}

function buildExplain(comp: TemplateComponentDef): string {
  switch (comp.calcMethod) {
    case "FIXED":
      return comp.amount ? `Fixed ${comp.amount}/month` : "Fixed amount";
    case "PERCENT_OF_BASIC":
      return comp.percent ? `${comp.percent}% of Basic` : "% of Basic";
    case "PERCENT_OF_GROSS":
      return comp.percent ? `${comp.percent}% of Gross` : "% of Gross";
    case "FORMULA":
      return comp.formula ?? "Custom formula";
    case "ATTENDANCE_BASED":
      return "Attendance-linked";
    case "TIMESHEET_BASED":
      return "Timesheet-linked";
    case "MANUAL":
      return "Manually entered";
  }
}

export function computeTemplatePreview(
  components: TemplateComponentDef[],
  annualCtc: number,
): TemplatePreviewResult {
  const monthlyCtc = annualCtc / 12;
  const sorted = [...components].sort((a, b) => a.sortOrder - b.sortOrder);

  const baseScope: FormulaScope = {
    ctc: monthlyCtc,
    gross: 0,
    basic: 0,
    days_in_month: 26,
    paid_days: 26,
    lop_days: 0,
    overtime_hours: 0,
    incentive_amount: 0,
    reimbursement_amount: 0,
  };

  const computed = new Map<string, number>();

  for (const comp of sorted) {
    if (comp.calcMethod === "FORMULA" && comp.formula) {
      const scope: FormulaScope = { ...baseScope, basic: computed.get("BASIC") ?? 0 };
      computed.set(comp.code, safeEvalFormula(comp.formula, scope));
    }
  }

  const basic = computed.get("BASIC") ?? 0;
  baseScope.basic = basic;

  const lines: PreviewLine[] = [];
  let grossEarnings = 0;

  for (const comp of sorted) {
    let amount = 0;

    switch (comp.calcMethod) {
      case "FIXED":
        amount = parseFloat(comp.amount ?? "0");
        break;
      case "PERCENT_OF_BASIC":
        amount = basic * parseFloat(comp.percent ?? "0") / 100;
        break;
      case "PERCENT_OF_GROSS":
        amount = 0;
        break;
      case "FORMULA":
        if (comp.formula) {
          const scope: FormulaScope = { ...baseScope };
          amount = safeEvalFormula(comp.formula, scope);
        }
        break;
      case "ATTENDANCE_BASED":
        amount = 0;
        break;
      case "TIMESHEET_BASED":
        if (comp.formula) {
          amount = safeEvalFormula(comp.formula, baseScope);
        }
        break;
      case "MANUAL":
        amount = 0;
        break;
    }

    if (comp.type === "EARNING" || comp.type === "REIMBURSEMENT") {
      grossEarnings += amount;
    }

    lines.push({
      code: comp.code,
      name: comp.name,
      type: comp.type,
      monthlyAmount: toDecimalString(amount),
      calcMethod: comp.calcMethod,
      taxable: comp.taxable,
      includeInCtc: comp.includeInCtc,
      isStatutory: comp.isStatutory,
      sortOrder: comp.sortOrder,
      explain: buildExplain(comp),
    });
  }

  let totalDeductionsPaise = 0;
  let employerContributionsPaise = 0;

  for (const line of lines) {
    const comp = sorted.find((c) => c.code === line.code);
    if (!comp) continue;

    if (comp.calcMethod === "PERCENT_OF_GROSS" && (comp.type === "DEDUCTION" || comp.type === "TAX")) {
      const amt = grossEarnings * parseFloat(comp.percent ?? "0") / 100;
      line.monthlyAmount = toDecimalString(amt);
      totalDeductionsPaise += toPaise(line.monthlyAmount);
    } else if (comp.calcMethod === "PERCENT_OF_GROSS" && comp.type === "EMPLOYER_CONTRIBUTION") {
      const amt = grossEarnings * parseFloat(comp.percent ?? "0") / 100;
      line.monthlyAmount = toDecimalString(amt);
      employerContributionsPaise += toPaise(line.monthlyAmount);
    } else if (comp.type === "DEDUCTION" || comp.type === "TAX") {
      totalDeductionsPaise += toPaise(line.monthlyAmount);
    } else if (comp.type === "EMPLOYER_CONTRIBUTION") {
      employerContributionsPaise += toPaise(line.monthlyAmount);
    }
  }

  return {
    annualCtc,
    monthlyCtc,
    components: lines,
    totals: {
      grossEarnings: toDecimalString(grossEarnings),
      totalDeductions: toDecimalString(totalDeductionsPaise / 100),
      employerContributions: toDecimalString(employerContributionsPaise / 100),
      netTakeHome: toDecimalString(grossEarnings - totalDeductionsPaise / 100),
    },
  };
}

const FORMULA_ID_RE = /[a-zA-Z_][a-zA-Z0-9_]*/g;
const ALLOWED_FORMULA_IDS = new Set<string>(FORMULA_VARIABLES);
const ALLOWED_MATH_NAMES = new Set(["Math", "abs", "floor", "ceil", "round", "min", "max"]);

export function validateFormula(formula: string): { valid: boolean; unknownIdentifiers: string[] } {
  const identifiers = formula.match(FORMULA_ID_RE) ?? [];
  const unknownIdentifiers = identifiers.filter(
    (id) => !ALLOWED_FORMULA_IDS.has(id) && !ALLOWED_MATH_NAMES.has(id),
  );
  return { valid: unknownIdentifiers.length === 0, unknownIdentifiers };
}
