import type { CalculationSnapshotLine, PayrollToggles, PayrollPolicyConfig } from "../../payroll.types";
import { toPaise, fromPaise } from "./money";
import type { CalcInputPulls } from "./calc-engine-types";

export interface VariablePayParams {
  toggles: PayrollToggles;
  pulls: CalcInputPulls;
  basicPaise: number;
  grossPaise: number;
  scheduledDays: number;
  overtimeHours: number;
  overtime: PayrollPolicyConfig["overtime"];
}

export function buildVariablePayLines(params: VariablePayParams): CalculationSnapshotLine[] {
  const { toggles, pulls, basicPaise, grossPaise, scheduledDays, overtimeHours, overtime } = params;
  const lines: CalculationSnapshotLine[] = [];

  if (toggles.overtime && overtimeHours > 0 && scheduledDays > 0) {
    const otBasisPaise = overtime.basis === "BASIC" ? basicPaise : grossPaise;
    const ratePerHour = otBasisPaise / (scheduledDays * 8);
    const otPaise = Math.round(parseFloat(overtime.multiplier) * ratePerHour * overtimeHours);
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
        inputs: { basisPaise: otBasisPaise / 100, multiplier: parseFloat(overtime.multiplier), overtimeHours },
        steps: [
          `OT basis (${overtime.basis}) = ₹${(otBasisPaise / 100).toFixed(2)}`,
          `Rate/hr = ₹${(otBasisPaise / 100).toFixed(2)} / (${scheduledDays} days × 8h) = ₹${(ratePerHour / 100).toFixed(4)}`,
          `OT = ₹${(ratePerHour / 100).toFixed(4)}/hr × ${overtime.multiplier}x × ${overtimeHours}h = ₹${(otPaise / 100).toFixed(2)}`,
        ],
        ...(pulls.overtimeSources?.length ? { sources: pulls.overtimeSources } : {}),
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
        name: r.expenseId === undefined ? `Reimbursement (${r.category})` : `Expense claim (${r.category})`,
        category: "REIMBURSEMENT",
        amount: fromPaise(rPaise),
        calcMethod: "MANUAL",
        taxable: false,
        sortOrder: 830 + idx,
        explain: {
          method: "MANUAL",
          inputs: { amount: rPaise / 100 },
          steps: [`Reimbursement ${r.category} = ₹${(rPaise / 100).toFixed(2)}`],
          ...(r.source ? { sources: [r.source] } : {}),
        },
      });
    });
  }

  return lines;
}
