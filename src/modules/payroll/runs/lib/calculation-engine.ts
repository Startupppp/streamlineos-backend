import type {
  CalculationSnapshot,
  CalculationSnapshotLine,
  PayrollPolicyConfig,
  PayrollToggles,
  PayrollWorkerType,
  FormulaScope,
  TaxRegimeType,
  RunEmployeeVariance,
} from "../../payroll.types";
import { toPaise, fromPaise, pctOf, applyRounding, daysInMonth } from "./money";
import { evalFormula } from "./formula-engine";
import { calcStatutory } from "./statutory";
import { getIndiaBundleForMonth } from "./statutory-registry";
import { taxSlabNew, taxSlabOld } from "./calc-tds-helpers";
import { calcEarningsPhase } from "./calc-earnings-phase";
import { buildVariablePayLines } from "./calc-variable-pay-phase";
import type { ResolvedComponent, CalcInputPulls, CalcEngineInput } from "./calc-engine-types";
import { SORT_BASE_TAX } from "./calc-engine-types";

export type { ResolvedComponent, CalcInputPulls, CalcEngineInput };
export { surchargeRate } from "./calc-tds-helpers";

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

  const earningComps = components.filter(c => c.type === "EARNING" && !c.isStatutory).sort((a, b) => a.sortOrder - b.sortOrder);
  const deductionComps = components.filter(c => c.type === "DEDUCTION" && !c.isStatutory).sort((a, b) => a.sortOrder - b.sortOrder);
  const adjustmentComps = components.filter(c => c.type === "ADJUSTMENT" && !c.isStatutory).sort((a, b) => a.sortOrder - b.sortOrder);

  const earningResult = calcEarningsPhase({
    earningComps,
    monthlyCtcPaise,
    rounding,
    totalDaysInMonth,
    paidDays,
    scheduledDays,
    lopDays,
    overtimeHours,
    billableHours,
    totalIncentivePaise,
    prorationFactor,
  });

  const lines: CalculationSnapshotLine[] = [...earningResult.earningLines];
  const basicPaise = earningResult.basicPaise;
  let grossPaise = earningResult.grossPaise;

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
            inputs: buildDeductionScope(),
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
          inputs: buildDeductionScope(),
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
            inputs: buildDeductionScope(),
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

  const variableLines = buildVariablePayLines({
    toggles,
    pulls,
    basicPaise,
    grossPaise,
    scheduledDays,
    overtimeHours,
    overtime: config.overtime,
  });
  lines.push(...variableLines);

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
    month,
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
    const isContractor = workerType === "CONTRACTOR" || workerType === "CONSULTANT";
    const contractorRate = pulls.panAvailable === false ? "20.00" : "10.00";
    const noPanUplift = isContractor && pulls.panAvailable === false;

    if (isContractor) {
      tdsPaise = pctOf(grossPaise, contractorRate);
    } else if (tdsMode === "FLAT" && config.statutory.tdsFlatPercent != null) {
      tdsPaise = pctOf(grossPaise, config.statutory.tdsFlatPercent);
    } else if (tdsMode === "DECLARATION") {
      const prevEmpIncomePaise = taxDecl ? Math.round(toPaise(taxDecl.previousEmploymentIncome)) : 0;
      const prevEmpTdsPaise = taxDecl ? Math.round(toPaise(taxDecl.previousEmployerTds)) : 0;
      const annualGrossPaise = grossPaise * 12 + prevEmpIncomePaise;
      const regime = taxRegime ?? "NEW";
      const tdsRule = getIndiaBundleForMonth(month).tds;

      let annualTaxRupees: number;
      if (regime === "NEW") {
        annualTaxRupees = taxSlabNew(annualGrossPaise, tdsRule);
      } else {
        const oldDeductionsPaise = taxDecl
          ? toPaise(taxDecl.section80c) + toPaise(taxDecl.section80d) + toPaise(taxDecl.hra) +
            toPaise(taxDecl.lta) + toPaise(taxDecl.homeLoanInterest) + toPaise(taxDecl.section80g)
          : 0;
        annualTaxRupees = taxSlabOld(annualGrossPaise, oldDeductionsPaise, tdsRule);
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
        calcMethod: tdsMode === "FLAT" || isContractor ? "PERCENT_OF_GROSS" : "FORMULA",
        taxable: false,
        sortOrder: SORT_BASE_TAX,
        explain: {
          method: tdsMode === "FLAT" || isContractor ? "PERCENT_OF_GROSS" : "FORMULA",
          inputs: { gross: grossPaise / 100, annualGross: (grossPaise * 12) / 100 },
          steps: [
            tdsMode === "DECLARATION" && !isContractor
              ? `TDS (${taxRegime ?? "NEW"} regime, ${getIndiaBundleForMonth(month).tds.ruleYearLabel}, incl. surcharge + 4% cess) = Annual tax estimate / 12 = ₹${(tdsRounded / 100).toFixed(2)}`
              : isContractor
                ? `TDS = ₹${(grossPaise / 100).toFixed(2)} × ${contractorRate}%${noPanUplift ? " (§206AA: no PAN on record)" : " (§194J)"} = ₹${(tdsRounded / 100).toFixed(2)}`
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
      baselineSource: "PREVIOUS_RUN",
      inputBaseline: null,
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
    wageDefinitionWarning: statResult.wageDefinitionWarning ?? null,
  };
}
