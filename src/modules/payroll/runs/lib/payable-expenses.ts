import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { expenses, payrollRunAllocations } from "../../../../db/schema";
import { daysInMonth } from "./money";

export const PAYROLL_EXPENSE_CURRENCY = "INR";

export function payableExpenseClaims(orgId: string, userIds: string[], throughDate: string) {
  return and(
    eq(expenses.orgId, orgId),
    inArray(expenses.userId, userIds),
    inArray(expenses.status, ["APPROVED", "REIMBURSEMENT_PENDING"]),
    isNull(expenses.paidAt),
    isNull(expenses.reimbursementBatchId),
    lte(expenses.expenseDate, throughDate),
  );
}

export function loadRunPayableExpenses(
  db: Db,
  orgId: string,
  runId: number,
  userIds: string[],
  month: string,
  limit: number,
) {
  const monthEnd = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  return db
    .select({
      id: expenses.id,
      userId: expenses.userId,
      amount: expenses.amount,
      category: expenses.category,
      expenseDate: expenses.expenseDate,
    })
    .from(expenses)
    .where(
      and(
        payableExpenseClaims(orgId, userIds, monthEnd),
        eq(expenses.currency, PAYROLL_EXPENSE_CURRENCY),
        sql`not exists (select 1 from ${payrollRunAllocations} where ${payrollRunAllocations.orgId} = ${orgId} and ${payrollRunAllocations.sourceType} = 'EXPENSE' and ${payrollRunAllocations.sourceId} = ${expenses.id}::text and ${payrollRunAllocations.runId} <> ${runId})`,
      ),
    )
    .limit(limit);
}

export async function findExpensePayrollRunId(db: Db, orgId: string, expenseId: number): Promise<number | null> {
  const [row] = await db
    .select({ runId: payrollRunAllocations.runId })
    .from(payrollRunAllocations)
    .where(
      and(
        eq(payrollRunAllocations.orgId, orgId),
        eq(payrollRunAllocations.sourceType, "EXPENSE"),
        eq(payrollRunAllocations.sourceId, String(expenseId)),
      ),
    )
    .limit(1);
  return row?.runId ?? null;
}
