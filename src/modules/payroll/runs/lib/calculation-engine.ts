import type {
  CalculationSnapshot,
  CalculationSnapshotLine,
  PayrollPolicyConfig,
  PayrollToggles,
  PayrollWorkerType,
  FormulaScope,
  MoneyString,
  TaxRegimeType,
  RunEmployeeVariance,
} from "../../payroll.types";
import type { SalaryComponentType, SalaryComponentCalcMethod } from "../../payroll.types";
import { toPaise, fromPaise, pctOf, applyRounding, daysInMonth } from "./money";
import { evalFormula } from "./formula-engine";
import { calcStatutory } from "./statutory";

export interface ResolvedComponent {
  id: number;
  code: string;
  name: string;
  type: SalaryComponentType;
  calcMethod: SalaryComponentCalcMethod;
  amount: MoneyString | null;
  percent: string | null;
  formula: string | null;
  taxable: boolean;
  showOnPayslip: boolean;
  includeInCtc: boolean;
  isStatutory: boolean;
  sortOrder: number;
}

export interface CalcInputPulls {
  approvedBonuses: { amount: MoneyString; type: string; taxable: boolean }[];
  approvedIncentives: { amount: MoneyString }[];
  approvedReimbursements: { amount: MoneyString; category: string }[];
  consumedReimbursementIds?: number[];
  consumedIncentiveIds?: number[];
  activeLoans: {
    id: number;
    emiAmount: MoneyString | null;
    amount: MoneyString;
    paidEmis: number;
    totalEmis: number | null;
    adjustment: { type: string; amount: MoneyString | null } | null;
  }[];
  taxDeclaration?: {
    section80c: string;
    section80d: string;
    hra: string;
    lta: string;
    homeLoanInterest: string;
    section80g: string;
    previousEmploymentIncome: string;
    previousEmployerTds: string;
  } | null;
}

export interface CalcEngineInput {
  policyVersionId: number | null;
  month: string;
  annualCtcDecimal: MoneyString;
  workerType: PayrollWorkerType;
  currency: string;
  payoutCurrency: string | null;
  fxRate: string | null;
  taxRegime: TaxRegimeType | null;
  components: ResolvedComponent[];
  toggles: PayrollToggles;
  config: PayrollPolicyConfig;
  inputs: {
    scheduledDays: string;
    paidDays: string;
    lopDays: string;
    overtimeHours: string;
    billableHours?: string;
  };
  pulls: CalcInputPulls;
  previousSnapshot: CalculationSnapshot | null;
}

function taxSlabNew(annualGrossPaise: number): number {
  const STD_DEDUCTION_PAISE = 7_500_000;
  const taxablePaise = Math.max(0, annualGrossPaise - STD_DEDUCTION_PAISE);
  const g = taxablePaise / 100;

  let tax = 0;
  if (g <= 300000) {
    tax = 0;
  } else if (g <= 700000) {
    tax = (g - 300000) * 0.05;
  } else if (g <= 1000000) {
    tax = 20000 + (g - 700000) * 0.10;
  } else if (g <= 1200000) {
    tax = 50000 + (g - 1000000) * 0.15;
  } else if (g <= 1500000) {
    tax = 80000 + (g - 1200000) * 0.20;
  } else {
    tax = 140000 + (g - 1500000) * 0.30;
  }

  if (tax > 0 && tax <= 60000) {
    tax = 0;
  }

  return tax * 1.04;
}

function taxSlabOld(annualGrossPaise: number, annualDeductionPaise: number): number {
  const STD_DEDUCTION_PAISE = 5_000_000;
  const totalDeductionPaise = STD_DEDUCTION_PAISE + annualDeductionPaise;
  const taxablePaise = Math.max(0, annualGrossPaise - totalDeductionPaise);
  const g = taxablePaise / 100;

  let tax = 0;
  if (g <= 250000) {
    tax = 0;
  } else if (g <= 500000) {
    tax = (g - 250000) * 0.05;
  } else if (g <= 1000000) {
    tax = 12500 + (g - 500000) * 0.20;
  } else {
    tax = 112500 + (g - 1000000) * 0.30;
  }

  if (tax > 0 && tax <= 12500) {
    tax = 0;
  }

  return tax * 1.04;
}

export function calcPayroll(input: CalcEngineInput): CalculationSnapshot {
  const {
    policyVersionId, month, annualCtcDecimal, workerType, currency,
    payoutCurrency, fxRate, taxRegime, components, toggles, config, pulls, previousSnapshot,
  } = input;

  const rounding = config.rounding;
  const monthlyCtcPaise = applyRounding(Math.round(toPaise(annualCtcDecimal) / 12), rounding);

  const scheduledDays = parseFloat(input.inputs.scheduledDays) || 0;
  const paidDays = parseFloat(input.inputs.paidDays) || 0;
  const lopDays = parseFloat(input.inputs.lopDays) || 0;
  const overtimeHours = parseFloat(input.inputs.overtimeHours) || 0;
  const billableHours = parseFloat(input.inputs.billableHours ?? "0") || 0;
  const prorationFactor = scheduledDays > 0 ? paidDays / scheduledDays : 0;
  const totalDaysInMonth = daysInMonth(month);

  const totalIncentivePaise = pulls.approvedIncentives.reduce((s, i) => s + toPaise(i.amount), 0);

  const lines: CalculationSnapshotLine[] = [];

  const earningComps = components.filter(c => c.type === "EARNING" && !c.isStatutory).sort((a, b) => a.sortOrder - b.sortOrder);
  const deductionComps = components.filter(c => c.type === "DEDUCTION" && !c.isStatutory).sort((a, b) => a.sortOrder - b.sortOrder);
  const adjustmentComps = components.filter(c => c.type === "ADJUSTMENT" && !c.isStatutory).sort((a, b) => a.sortOrder - b.sortOrder);

  let basicPaise = 0;
  let earningGrossSoFar = 0;
  const pendingGrossPercent: ResolvedComponent[] = [];

  for (const comp of earningComps) {
    if (comp.calcMethod === "PERCENT_OF_GROSS") {
      pendingGrossPercent.push(comp);
      continue;
    }

    let rawPaise = 0;

    if (comp.calcMethod === "FIXED" && comp.amount != null) {
      rawPaise = toPaise(comp.amount);
    } else if (comp.calcMethod === "PERCENT_OF_BASIC" && comp.percent != null) {
      const pctBase = basicPaise > 0 ? basicPaise : monthlyCtcPaise;
      rawPaise = pctOf(pctBase, comp.percent);
    } else if (comp.calcMethod === "ATTENDANCE_BASED" && comp.amount != null) {
      rawPaise = Math.round(toPaise(comp.amount) * prorationFactor);
    } else if (comp.calcMethod === "TIMESHEET_BASED" && comp.amount != null) {
      rawPaise = Math.round(parseFloat(comp.amount) * billableHours * 100);
    } else if (comp.calcMethod === "FORMULA" && comp.formula != null) {
      const scope: FormulaScope = {
        basic: basicPaise / 100,
        gross: earningGrossSoFar / 100,
        ctc: monthlyCtcPaise / 100,
        days_in_month: totalDaysInMonth,
        paid_days: paidDays,
        lop_days: lopDays,
        overtime_hours: overtimeHours,
        incentive_amount: totalIncentivePaise / 100,
        reimbursement_amount: 0,
      };
      const result = evalFormula(comp.formula, scope);
      if (result.ok) {
        rawPaise = Math.round(result.value * 100);
      } else {
        lines.push({
          code: comp.code,
          name: comp.name,
          category: "EARNING",
          amount: "0.00",
          calcMethod: comp.calcMethod,
          taxable: comp.taxable,
          sortOrder: comp.sortOrder,
          explain: {
            method: comp.calcMethod,
            formula: comp.formula,
            inputs: { ctc: monthlyCtcPaise / 100, basic: basicPaise / 100 },
            steps: [`Error: ${result.error}`],
            note: result.error,
          },
        });
        if (comp.code === "BASIC") basicPaise = 0;
        continue;
      }
    } else if (comp.calcMethod === "MANUAL") {
      rawPaise = 0;
    }

    const noProrate = comp.calcMethod === "ATTENDANCE_BASED" || comp.calcMethod === "TIMESHEET_BASED";
    const proratedPaise = noProrate ? rawPaise : applyRounding(Math.round(rawPaise * prorationFactor), rounding);

    const pctBase = comp.calcMethod === "PERCENT_OF_BASIC"
      ? (basicPaise > 0 ? basicPaise : monthlyCtcPaise)
      : monthlyCtcPaise;

    if (comp.calcMethod === "TIMESHEET_BASED") {
      lines.push({
        code: comp.code,
        name: comp.name,
        category: "EARNING",
        amount: fromPaise(proratedPaise),
        calcMethod: comp.calcMethod,
        taxable: comp.taxable,
        sortOrder: comp.sortOrder,
        explain: {
          method: comp.calcMethod,
          inputs: { hourlyRate: parseFloat(comp.amount ?? "0"), billableHours },
          steps: [
            `${comp.name} = ₹${parseFloat(comp.amount ?? "0").toFixed(2)}/hr × ${billableHours}h = ₹${(proratedPaise / 100).toFixed(2)}`,
          ],
        },
      });
    } else {
      const baseLabel = comp.calcMethod === "PERCENT_OF_BASIC"
        ? (basicPaise > 0 ? `basic ₹${(pctBase / 100).toFixed(2)}` : `monthly CTC ₹${(pctBase / 100).toFixed(2)}`)
        : "";
      lines.push({
        code: comp.code,
        name: comp.name,
        category: "EARNING",
        amount: fromPaise(proratedPaise),
        calcMethod: comp.calcMethod,
        taxable: comp.taxable,
        sortOrder: comp.sortOrder,
        explain: {
          method: comp.calcMethod,
          formula: comp.formula ?? undefined,
          inputs: { ctc: monthlyCtcPaise / 100, percent: comp.percent ? parseFloat(comp.percent) : 0 },
          steps: [
            comp.calcMethod === "PERCENT_OF_BASIC"
              ? `${comp.name} = ${comp.percent}% of ${baseLabel} = ₹${(rawPaise / 100).toFixed(2)}`
              : `${comp.name} = ₹${(rawPaise / 100).toFixed(2)}`,
            proratedPaise !== rawPaise
              ? `Prorated ₹${(rawPaise / 100).toFixed(2)} × ${paidDays}/${scheduledDays} paid days = ₹${(proratedPaise / 100).toFixed(2)}`
              : `Full amount = ₹${(proratedPaise / 100).toFixed(2)}`,
          ],
        },
      });
    }

    if (comp.code === "BASIC") basicPaise = proratedPaise;
    earningGrossSoFar += proratedPaise;
  }

  let grossPaise = lines
    .filter(l => l.category === "EARNING")
    .reduce((s, l) => s + toPaise(l.amount), 0);

  for (const comp of pendingGrossPercent) {
    if (comp.percent == null) continue;
    const rawPaise = pctOf(grossPaise, comp.percent);
    const proratedPaise = applyRounding(Math.round(rawPaise * prorationFactor), rounding);
    lines.push({
      code: comp.code,
      name: comp.name,
      category: "EARNING",
      amount: fromPaise(proratedPaise),
      calcMethod: comp.calcMethod,
      taxable: comp.taxable,
      sortOrder: comp.sortOrder,
      explain: {
        method: comp.calcMethod,
        inputs: { gross: grossPaise / 100, percent: parseFloat(comp.percent) },
        steps: [
          `${comp.name} = ${comp.percent}% of gross ₹${(grossPaise / 100).toFixed(2)} = ₹${(proratedPaise / 100).toFixed(2)}`,
        ],
      },
    });
  }

  grossPaise = lines
    .filter(l => l.category === "EARNING")
    .reduce((s, l) => s + toPaise(l.amount), 0);

  let nonStatDeductionPaise = 0;
  const pendingGrossDeductions: ResolvedComponent[] = [];

  const buildDeductionScope = (): FormulaScope => ({
    basic: basicPaise / 100,
    gross: grossPaise / 100,
    ctc: monthlyCtcPaise / 100,
    days_in_month: totalDaysInMonth,
    paid_days: paidDays,
    lop_days: lopDays,
    overtime_hours: overtimeHours,
    incentive_amount: totalIncentivePaise / 100,
    reimbursement_amount: 0,
  });

  for (const comp of deductionComps) {
    if (comp.calcMethod === "PERCENT_OF_GROSS") {
      pendingGrossDeductions.push(comp);
      continue;
    }

    let paise = 0;

    if (comp.calcMethod === "FIXED" && comp.amount != null) {
      paise = applyRounding(toPaise(comp.amount), rounding);
      lines.push({
        code: comp.code,
        name: comp.name,
        category: "DEDUCTION",
        amount: fromPaise(paise),
        calcMethod: comp.calcMethod,
        taxable: comp.taxable,
        sortOrder: comp.sortOrder,
        explain: {
          method: comp.calcMethod,
          inputs: { amount: paise / 100 },
          steps: [`${comp.name} = ₹${(paise / 100).toFixed(2)} (fixed deduction)`],
        },
      });
    } else if (comp.calcMethod === "PERCENT_OF_BASIC" && comp.percent != null) {
      paise = applyRounding(pctOf(basicPaise, comp.percent), rounding);
      lines.push({
        code: comp.code,
        name: comp.name,
        category: "DEDUCTION",
        amount: fromPaise(paise),
        calcMethod: comp.calcMethod,
        taxable: comp.taxable,
        sortOrder: comp.sortOrder,
        explain: {
          method: comp.calcMethod,
          inputs: { basic: basicPaise / 100, percent: parseFloat(comp.percent) },
          steps: [`${comp.name} = ${comp.percent}% of basic ₹${(basicPaise / 100).toFixed(2)} = ₹${(paise / 100).toFixed(2)}`],
        },
      });
    } else if (comp.calcMethod === "FORMULA" && comp.formula != null) {
      const result = evalFormula(comp.formula, buildDeductionScope());
      if (!result.ok) {
        lines.push({
          code: comp.code,
          name: comp.name,
          category: "DEDUCTION",
          amount: "0.00",
          calcMethod: comp.calcMethod,
          taxable: comp.taxable,
          sortOrder: comp.sortOrder,
          explain: {
            method: comp.calcMethod,
            formula: comp.formula,
            inputs: buildDeductionScope() as unknown as Record<string, number>,
            steps: [`Error: ${result.error}`],
            note: result.error,
          },
        });
        continue;
      }
      paise = applyRounding(Math.round(result.value * 100), rounding);
      lines.push({
        code: comp.code,
        name: comp.name,
        category: "DEDUCTION",
        amount: fromPaise(paise),
        calcMethod: comp.calcMethod,
        taxable: comp.taxable,
        sortOrder: comp.sortOrder,
        explain: {
          method: comp.calcMethod,
          formula: comp.formula,
          inputs: buildDeductionScope() as unknown as Record<string, number>,
          steps: [`${comp.name} = formula result = ₹${(paise / 100).toFixed(2)}`],
        },
      });
    } else {
      continue;
    }

    nonStatDeductionPaise += paise;
  }

  let adjustmentPaise = 0;

  for (const comp of adjustmentComps) {
    let paise = 0;

    if (comp.calcMethod === "FIXED" && comp.amount != null) {
      paise = applyRounding(toPaise(comp.amount), rounding);
    } else if (comp.calcMethod === "PERCENT_OF_BASIC" && comp.percent != null) {
      paise = applyRounding(pctOf(basicPaise, comp.percent), rounding);
    } else if (comp.calcMethod === "PERCENT_OF_GROSS" && comp.percent != null) {
      paise = applyRounding(pctOf(grossPaise, comp.percent), rounding);
    } else if (comp.calcMethod === "FORMULA" && comp.formula != null) {
      const result = evalFormula(comp.formula, buildDeductionScope());
      if (!result.ok) {
        lines.push({
          code: comp.code,
          name: comp.name,
          category: "ADJUSTMENT",
          amount: "0.00",
          calcMethod: comp.calcMethod,
          taxable: comp.taxable,
          sortOrder: comp.sortOrder,
          explain: {
            method: comp.calcMethod,
            formula: comp.formula,
            inputs: buildDeductionScope() as unknown as Record<string, number>,
            steps: [`Error: ${result.error}`],
            note: result.error,
          },
        });
        continue;
      }
      paise = applyRounding(Math.round(result.value * 100), rounding);
    } else if (comp.calcMethod === "MANUAL") {
      paise = 0;
    } else {
      continue;
    }

    lines.push({
      code: comp.code,
      name: comp.name,
      category: "ADJUSTMENT",
      amount: fromPaise(paise),
      calcMethod: comp.calcMethod,
      taxable: comp.taxable,
      sortOrder: comp.sortOrder,
      explain: {
        method: comp.calcMethod,
        formula: comp.formula ?? undefined,
        inputs: { amount: paise / 100 },
        steps: [`${comp.name} = ₹${(paise / 100).toFixed(2)} (adjustment / clawback)`],
      },
    });

    adjustmentPaise += paise;
  }

  if (toggles.overtime && overtimeHours > 0 && scheduledDays > 0) {
    const otBasisPaise = config.overtime.basis === "BASIC" ? basicPaise : grossPaise;
    const ratePerHour = otBasisPaise / (scheduledDays * 8);
    const otPaise = Math.round(parseFloat(config.overtime.multiplier) * ratePerHour * overtimeHours);
    lines.push({
      code: "OVERTIME",
      name: "Overtime",
      category: "EARNING",
      amount: fromPaise(otPaise),
      calcMethod: "ATTENDANCE_BASED",
      taxable: true,
      sortOrder: 800,
      explain: {
        method: "ATTENDANCE_BASED",
        inputs: { basisPaise: otBasisPaise / 100, multiplier: parseFloat(config.overtime.multiplier), overtimeHours },
        steps: [
          `OT basis (${config.overtime.basis}) = ₹${(otBasisPaise / 100).toFixed(2)}`,
          `Rate/hr = ₹${(otBasisPaise / 100).toFixed(2)} / (${scheduledDays} days × 8h) = ₹${(ratePerHour / 100).toFixed(4)}`,
          `OT = ₹${(ratePerHour / 100).toFixed(4)}/hr × ${config.overtime.multiplier}x × ${overtimeHours}h = ₹${(otPaise / 100).toFixed(2)}`,
        ],
      },
    });
  }

  if (toggles.bonuses) {
    pulls.approvedBonuses.forEach((b, idx) => {
      const bPaise = toPaise(b.amount);
      lines.push({
        code: `BONUS_${idx + 1}`,
        name: `Bonus (${b.type})`,
        category: "EARNING",
        amount: fromPaise(bPaise),
        calcMethod: "MANUAL",
        taxable: b.taxable,
        sortOrder: 810 + idx,
        explain: {
          method: "MANUAL",
          inputs: { amount: bPaise / 100 },
          steps: [`Bonus ${b.type} = ₹${(bPaise / 100).toFixed(2)}`],
        },
      });
    });
  }

  if (toggles.incentives) {
    pulls.approvedIncentives.forEach((inc, idx) => {
      const iPaise = toPaise(inc.amount);
      lines.push({
        code: `INCENTIVE_${idx + 1}`,
        name: "Incentive",
        category: "EARNING",
        amount: fromPaise(iPaise),
        calcMethod: "MANUAL",
        taxable: true,
        sortOrder: 820 + idx,
        explain: {
          method: "MANUAL",
          inputs: { amount: iPaise / 100 },
          steps: [`Incentive = ₹${(iPaise / 100).toFixed(2)}`],
        },
      });
    });
  }

  if (toggles.reimbursements) {
    pulls.approvedReimbursements.forEach((r, idx) => {
      const rPaise = toPaise(r.amount);
      lines.push({
        code: `REIMBURSEMENT_${idx + 1}`,
        name: `Reimbursement (${r.category})`,
        category: "REIMBURSEMENT",
        amount: fromPaise(rPaise),
        calcMethod: "MANUAL",
        taxable: false,
        sortOrder: 830 + idx,
        explain: {
          method: "MANUAL",
          inputs: { amount: rPaise / 100 },
          steps: [`Reimbursement ${r.category} = ₹${(rPaise / 100).toFixed(2)}`],
        },
      });
    });
  }

  grossPaise = lines
    .filter(l => l.category === "EARNING")
    .reduce((s, l) => s + toPaise(l.amount), 0);

  for (const comp of pendingGrossDeductions) {
    if (comp.percent == null) continue;
    const paise = applyRounding(pctOf(grossPaise, comp.percent), rounding);
    lines.push({
      code: comp.code,
      name: comp.name,
      category: "DEDUCTION",
      amount: fromPaise(paise),
      calcMethod: comp.calcMethod,
      taxable: comp.taxable,
      sortOrder: comp.sortOrder,
      explain: {
        method: comp.calcMethod,
        inputs: { gross: grossPaise / 100, percent: parseFloat(comp.percent) },
        steps: [`${comp.name} = ${comp.percent}% of gross ₹${(grossPaise / 100).toFixed(2)} = ₹${(paise / 100).toFixed(2)}`],
      },
    });
    nonStatDeductionPaise += paise;
  }

  const reimbursementPaise = lines
    .filter(l => l.category === "REIMBURSEMENT")
    .reduce((s, l) => s + toPaise(l.amount), 0);

  const statResult = calcStatutory({
    workerType,
    toggles,
    config,
    basicPaise,
    grossPaise,
    rounding,
  });
  lines.push(...statResult.lines);

  let totalDeductionPaise = statResult.totalEmployeeDeductionPaise + nonStatDeductionPaise + adjustmentPaise;
  let totalEmployerPaise = statResult.totalEmployerContributionPaise;

  if (toggles.loans) {
    pulls.activeLoans.forEach((loan, idx) => {
      const totalPrincipalPaise = toPaise(loan.amount);
      const emiPaise = loan.emiAmount != null ? toPaise(loan.emiAmount) : 0;
      const paidPaise = emiPaise * loan.paidEmis;
      const outstandingPaise = Math.max(0, totalPrincipalPaise - paidPaise);

      let recoverablePaise = 0;
      const adj = loan.adjustment;

      if (adj?.type === "SKIP_EMI") {
        return;
      } else if (adj?.type === "FORECLOSURE") {
        recoverablePaise = outstandingPaise;
      } else if (adj?.type === "EXTRA_RECOVERY" && adj.amount != null) {
        recoverablePaise = emiPaise + toPaise(adj.amount);
      } else if (adj?.type === "MANUAL_ADJUST" && adj.amount != null) {
        recoverablePaise = toPaise(adj.amount);
      } else {
        recoverablePaise = emiPaise;
      }

      recoverablePaise = Math.min(recoverablePaise, outstandingPaise);

      if (recoverablePaise <= 0) return;

      const loanPaise = applyRounding(recoverablePaise, rounding);
      lines.push({
        code: `LOAN_EMI_${loan.id}`,
        name: `Loan EMI Recovery`,
        category: "DEDUCTION",
        amount: fromPaise(loanPaise),
        calcMethod: "MANUAL",
        taxable: false,
        sortOrder: 850 + idx,
        explain: {
          method: "MANUAL",
          inputs: { emi: emiPaise / 100, outstanding: outstandingPaise / 100, paidEmis: loan.paidEmis },
          steps: [
            `Outstanding = ₹${(totalPrincipalPaise / 100).toFixed(2)} - (${loan.paidEmis} × ₹${(emiPaise / 100).toFixed(2)}) = ₹${(outstandingPaise / 100).toFixed(2)}`,
            `Recovery = ₹${(loanPaise / 100).toFixed(2)}`,
          ],
        },
      });

      totalDeductionPaise += loanPaise;
    });
  }

  if (toggles.tds) {
    let tdsPaise = 0;
    const tdsMode = config.statutory.tdsMode;
    const taxDecl = pulls.taxDeclaration;

    if (workerType === "CONTRACTOR" || workerType === "CONSULTANT") {
      tdsPaise = pctOf(grossPaise, "10.00");
    } else if (tdsMode === "FLAT" && config.statutory.tdsFlatPercent != null) {
      tdsPaise = pctOf(grossPaise, config.statutory.tdsFlatPercent);
    } else if (tdsMode === "DECLARATION") {
      const prevEmpIncomePaise = taxDecl ? Math.round(toPaise(taxDecl.previousEmploymentIncome)) : 0;
      const prevEmpTdsPaise = taxDecl ? Math.round(toPaise(taxDecl.previousEmployerTds)) : 0;
      const annualGrossPaise = grossPaise * 12 + prevEmpIncomePaise;
      const regime = taxRegime ?? "NEW";

      let annualTaxRupees: number;
      if (regime === "NEW") {
        annualTaxRupees = taxSlabNew(annualGrossPaise);
      } else {
        const oldDeductionsPaise = taxDecl
          ? toPaise(taxDecl.section80c) + toPaise(taxDecl.section80d) + toPaise(taxDecl.hra) +
            toPaise(taxDecl.lta) + toPaise(taxDecl.homeLoanInterest) + toPaise(taxDecl.section80g)
          : 0;
        annualTaxRupees = taxSlabOld(annualGrossPaise, oldDeductionsPaise);
      }

      const annualTaxPaise = Math.round(annualTaxRupees * 100);
      const netAnnualTaxPaise = Math.max(0, annualTaxPaise - prevEmpTdsPaise);
      tdsPaise = Math.round(netAnnualTaxPaise / 12);
    }

    if (tdsPaise > 0) {
      const tdsRounded = applyRounding(tdsPaise, rounding);
      lines.push({
        code: "TDS",
        name: "TDS",
        category: "TAX",
        amount: fromPaise(tdsRounded),
        calcMethod: tdsMode === "FLAT" || workerType === "CONTRACTOR" || workerType === "CONSULTANT" ? "PERCENT_OF_GROSS" : "FORMULA",
        taxable: false,
        sortOrder: SORT_BASE_TAX,
        explain: {
          method: tdsMode === "FLAT" || workerType === "CONTRACTOR" || workerType === "CONSULTANT" ? "PERCENT_OF_GROSS" : "FORMULA",
          inputs: { gross: grossPaise / 100, annualGross: (grossPaise * 12) / 100 },
          steps: [
            tdsMode === "DECLARATION"
              ? `TDS (${taxRegime ?? "NEW"} regime) = Annual tax estimate / 12 = ₹${(tdsRounded / 100).toFixed(2)}`
              : `TDS = ₹${(grossPaise / 100).toFixed(2)} × ${config.statutory.tdsFlatPercent ?? "10"}% = ₹${(tdsRounded / 100).toFixed(2)}`,
          ],
        },
      });
      totalDeductionPaise += tdsRounded;
    }
  }

  const netPaise = grossPaise + reimbursementPaise - totalDeductionPaise;

  let computedNetPayoutCurrency: string | null = null;
  if (fxRate != null && payoutCurrency != null && payoutCurrency !== currency) {
    computedNetPayoutCurrency = ((netPaise / 100) * parseFloat(fxRate)).toFixed(2);
  }

  let variance: RunEmployeeVariance | null = null;
  if (previousSnapshot != null) {
    const prevNet = toPaise(previousSnapshot.totals.net);
    const netDelta = netPaise - prevNet;
    const netDeltaPercent = prevNet !== 0 ? (netDelta / prevNet) * 100 : null;

    const changedComponents: RunEmployeeVariance["changedComponents"] = [];
    for (const line of lines) {
      const prevLine = previousSnapshot.lines.find(l => l.code === line.code);
      if (prevLine == null || prevLine.amount !== line.amount) {
        changedComponents.push({
          code: line.code,
          previous: prevLine?.amount ?? null,
          current: line.amount,
        });
      }
    }

    variance = {
      previousRunId: null,
      previousNet: previousSnapshot.totals.net,
      netDelta: fromPaise(netDelta),
      netDeltaPercent,
      changedComponents,
    };
  }

  return {
    policyVersionId,
    computedAt: new Date().toISOString(),
    currency,
    fxRate,
    netPayoutCurrency: computedNetPayoutCurrency,
    scheduledDays: input.inputs.scheduledDays,
    paidDays: input.inputs.paidDays,
    lopDays: input.inputs.lopDays,
    overtimeHours: input.inputs.overtimeHours,
    lines,
    totals: {
      gross: fromPaise(grossPaise),
      deductions: fromPaise(totalDeductionPaise),
      employerContributions: fromPaise(totalEmployerPaise),
      net: fromPaise(netPaise),
    },
    variance,
  };
}

const SORT_BASE_TAX = 950;
