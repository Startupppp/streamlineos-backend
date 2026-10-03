/**
 * Unit normalisation for the payroll-input reimbursement snapshot.
 *
 * Two source tables feed one payload and they do NOT share a unit:
 *   - `reimbursements.amount`          numeric(15,2) — MAJOR units (rupees),
 *                                      returned by the driver as a decimal string.
 *   - `hr_insurance_claims.amount_cents` integer     — MINOR units (paise).
 *
 * The consumer fixes the output unit. `buildCalcPullsFromSections`
 * (payroll/runs/lib/input-puller.ts) reads `items[].amount` into
 * `CalcInputPulls.approvedReimbursements[].amount`, typed `MoneyString`, and
 * `calc-variable-pay-phase.ts` runs it through `toPaise()` = `parseFloat(s) * 100`.
 * The live (unsnapshotted) path feeds that same field straight from
 * `reimbursements.amount`. So every `items[].amount` MUST be a rupee MoneyString;
 * a minor-unit value there is paid out at 100x on a real payslip.
 */

// The very helpers the payslip reader uses (calc-variable-pay-phase.ts runs
// items[].amount through toPaise), so writer and reader cannot drift apart.
// money.ts is a zero-import leaf, so this adds no cycle; src/modules/hr already
// imports payroll/runs/lib and payroll/payout/lib in production code.
import { fromPaise, toPaise } from "../../payroll/runs/lib/money";
import { PAYROLL_EXPENSE_CURRENCY } from "../../payroll/runs/lib/payable-expenses";

/** A `reimbursements` row as projected by the payroll-input build. */
export interface ReimbursementInput {
  id: number;
  category: string;
  /** MAJOR units (rupees) — numeric(15,2) rendered as a decimal string. */
  amount: string;
  description: string | null;
  payrollMonth: string | null;
  approvedAt: Date | null;
}

/** An `hr_insurance_claims` row as projected by the payroll-input build. */
export interface BenefitClaimInput {
  id: number;
  claimNumber: string;
  /** MINOR units (paise). */
  amountCents: number;
  decidedAt: Date | null;
}

export interface ExpenseClaimInput {
  id: number;
  category: string;
  amount: string;
  currency: string;
  description: string | null;
  approvedAt: Date | null;
  expenseDate: string;
}

// Declared as type aliases, not interfaces, so the payload stays assignable to
// the `Record<string, unknown>` snapshot payload the consumers read it back as
// without anyone needing a type assertion to bridge the two.
export type ReimbursementSnapshotItem = {
  id: number;
  category: string;
  /** MAJOR units (rupees) for every source — see the file header. */
  amount: string;
  description: string | null;
  payrollMonth: string | null;
  approvedAt: Date | null;
  source: "reimbursement" | "benefits_claim" | "expense";
  date?: string;
};

export type ExcludedExpenseItem = {
  id: number;
  category: string;
  amount: string;
  currency: string;
  reason: string;
};

export type ReimbursementSnapshotPayload = {
  userId: string;
  items: ReimbursementSnapshotItem[];
  /** MAJOR units (rupees), summing every entry in `items`. */
  totalAmount: number;
  excludedItems: ExcludedExpenseItem[];
};

/**
 * Builds the `reimbursement` section payload with a single unit across both
 * sources. Rupee strings are parsed to minor units before any addition, so the
 * two legs never meet as floats, and the total is converted back once.
 */
export function buildReimbursementPayload(
  userId: string,
  reimbursements: ReimbursementInput[],
  benefitClaims: BenefitClaimInput[],
  expenseClaims: ExpenseClaimInput[] = [],
): ReimbursementSnapshotPayload {
  const payableExpenses = expenseClaims.filter((e) => e.currency.toUpperCase() === PAYROLL_EXPENSE_CURRENCY);
  const excludedItems: ExcludedExpenseItem[] = expenseClaims
    .filter((e) => e.currency.toUpperCase() !== PAYROLL_EXPENSE_CURRENCY)
    .map((e) => ({
      id: e.id,
      category: e.category,
      amount: e.amount,
      currency: e.currency,
      reason: `Expense claim #${e.id} is in ${e.currency}; payroll only pays ${PAYROLL_EXPENSE_CURRENCY} claims`,
    }));
  const items: ReimbursementSnapshotItem[] = [
    ...reimbursements.map((r) => ({
      id: r.id,
      category: r.category,
      // Already MAJOR units (rupees) in the column — passed through unchanged.
      amount: r.amount ?? "0",
      description: r.description,
      payrollMonth: r.payrollMonth,
      approvedAt: r.approvedAt,
      source: "reimbursement" as const,
    })),
    ...benefitClaims.map((c) => ({
      id: c.id,
      category: "benefits_claim" as const,
      // MINOR units (paise) in the column -> the rupee MoneyString the payroll
      // calc engine's toPaise() expects. Emitting the raw minor-unit integer
      // here pays the claim out at 100x.
      amount: fromPaise(c.amountCents),
      description: `Insurance claim #${c.claimNumber}`,
      payrollMonth: null,
      approvedAt: c.decidedAt,
      source: "benefits_claim" as const,
    })),
    ...payableExpenses.map((e) => ({
      id: e.id,
      category: e.category,
      amount: e.amount,
      description: e.description,
      payrollMonth: null,
      approvedAt: e.approvedAt,
      source: "expense" as const,
      date: e.expenseDate,
    })),
  ];

  // Summed in MINOR units so the two sources never meet as floats, then
  // converted back to MAJOR units once. Every items[].amount is rupees by the
  // time it gets here, so one toPaise per entry is the whole conversion.
  const totalMinorUnits = items.reduce((sum, item) => sum + toPaise(item.amount), 0);

  return { userId, items, totalAmount: totalMinorUnits / 100, excludedItems };
}
