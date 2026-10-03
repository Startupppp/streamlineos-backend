import type {
  MoneyString,
  PayrollPolicyConfig,
  PayrollToggles,
  PayrollWorkerType,
  SalaryComponentType,
  TaxRegimeType,
} from "../../payroll.types";
import { calcPayroll, type ResolvedComponent } from "./calculation-engine";
import { daysInMonth, fromPaise, toPaise } from "./money";

export interface CtcBreakupInput {
  annualCtc: MoneyString;
  components: ResolvedComponent[];
  toggles: PayrollToggles;
  config: PayrollPolicyConfig;
  month: string;
  regime: TaxRegimeType | null;
  stateCode: string | null;
  workerType: PayrollWorkerType;
  currency: string;
  policyVersionId: number | null;
}

export interface CtcBreakupLine {
  code: string;
  name: string;
  category: SalaryComponentType;
  taxable: boolean;
  monthly: MoneyString;
  annual: MoneyString;
  note: string | null;
}

export interface CtcBreakupTotals {
  gross: MoneyString;
  deductions: MoneyString;
  employerContributions: MoneyString;
  net: MoneyString;
}

export interface CtcBreakup {
  annualCtc: MoneyString;
  month: string;
  regime: TaxRegimeType;
  stateCode: string | null;
  lines: CtcBreakupLine[];
  monthly: CtcBreakupTotals;
  annual: CtcBreakupTotals;
  warnings: string[];
}

const annualOf = (monthly: MoneyString): MoneyString => fromPaise(toPaise(monthly) * 12);

export function ctcBreakup(input: CtcBreakupInput): CtcBreakup {
  const days = String(daysInMonth(input.month));
  const snapshot = calcPayroll({
    policyVersionId: input.policyVersionId,
    month: input.month,
    annualCtcDecimal: input.annualCtc,
    workerType: input.workerType,
    currency: input.currency,
    payoutCurrency: null,
    fxRate: null,
    taxRegime: input.regime,
    components: input.components,
    toggles: input.toggles,
    config: input.config,
    inputs: { scheduledDays: days, paidDays: days, lopDays: "0", overtimeHours: "0", billableHours: "0" },
    pulls: { approvedBonuses: [], approvedIncentives: [], approvedReimbursements: [], activeLoans: [], taxDeclaration: null },
    previousSnapshot: null,
    stateCode: input.stateCode,
  });

  const lines = snapshot.lines.map((l) => ({
    code: l.code,
    name: l.name,
    category: l.category,
    taxable: l.taxable,
    monthly: l.amount,
    annual: annualOf(l.amount),
    note: l.explain.note ?? null,
  }));
  const { gross, deductions, employerContributions, net } = snapshot.totals;
  const monthly = { gross, deductions, employerContributions, net };

  return {
    annualCtc: input.annualCtc,
    month: input.month,
    regime: input.regime ?? "NEW",
    stateCode: input.stateCode,
    lines,
    monthly,
    annual: {
      gross: annualOf(gross),
      deductions: annualOf(deductions),
      employerContributions: annualOf(employerContributions),
      net: annualOf(net),
    },
    warnings: [
      ...snapshot.lines
        .filter((l) => l.explain.steps.some((step) => step.startsWith("Error: ")))
        .map((l) => `${l.name}: ${l.explain.note ?? "formula error"}`),
      ...(snapshot.wageDefinitionWarning ? [snapshot.wageDefinitionWarning] : []),
    ],
  };
}
