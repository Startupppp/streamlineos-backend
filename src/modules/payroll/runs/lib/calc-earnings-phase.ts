import type { CalculationSnapshotLine, PayrollPolicyConfig, FormulaScope } from "../../payroll.types";
import { toPaise, fromPaise, pctOf, applyRounding } from "./money";
import { evalFormula } from "./formula-engine";
import type { ResolvedComponent } from "./calc-engine-types";

export interface EarningsPhaseParams {
  earningComps: ResolvedComponent[];
  monthlyCtcPaise: number;
  rounding: PayrollPolicyConfig["rounding"];
  totalDaysInMonth: number;
  paidDays: number;
  scheduledDays: number;
  lopDays: number;
  overtimeHours: number;
  billableHours: number;
  totalIncentivePaise: number;
  prorationFactor: number;
}

export interface EarningsPhaseResult {
  earningLines: CalculationSnapshotLine[];
  basicPaise: number;
  grossPaise: number;
}

export function calcEarningsPhase(params: EarningsPhaseParams): EarningsPhaseResult {
  const {
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
  } = params;

  const lines: CalculationSnapshotLine[] = [];
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
          ...(comp.formula ? { formula: comp.formula } : {}),
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

  return { earningLines: lines, basicPaise, grossPaise };
}
