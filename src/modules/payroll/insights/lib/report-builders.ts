import { eq, and } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import {
  payrollRuns,
  payrollLineItems,
  payrollRunEmployees,
  users,
  departments,
  employeeSalaryProfiles,
} from "../../../../db/schema";

export type RunRow = typeof payrollRuns.$inferSelect;
export type LineItemRow = Pick<
  typeof payrollLineItems.$inferSelect,
  "code" | "category" | "amount"
>;

export type RunEmployeeRow = Pick<
  typeof payrollRunEmployees.$inferSelect,
  | "id"
  | "userId"
  | "workerType"
  | "gross"
  | "net"
  | "paidDays"
  | "totalDeductions"
  | "employerContributions"
  | "profileId"
>;

export interface EnrichedLineItem {
  lineItem: LineItemRow;
  runEmployee: RunEmployeeRow;
  userName: string | null;
  userDept: string | null;
  costCenter: string | null;
}

export interface LineItemFilters {
  department?: string;
  costCenter?: string;
  workerType?: string;
}

export async function findRunForMonth(
  db: Db,
  orgId: string,
  month: string,
): Promise<RunRow | null> {
  // Reports reconcile the month's canonical REGULAR run only. Off-cycle/bonus/
  // correction runs now share a month (unique index is org+month+runType), so an
  // unfiltered limit(1) would non-deterministically pick a non-regular run.
  const rows = await db
    .select()
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.orgId, orgId),
        eq(payrollRuns.month, month),
        eq(payrollRuns.runType, "REGULAR"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getLineItemsForRun(
  db: Db,
  runId: number,
  filters?: LineItemFilters,
): Promise<EnrichedLineItem[]> {
  const conditions = [eq(payrollLineItems.runId, runId)];
  if (filters?.workerType)
    conditions.push(
      eq(
        payrollRunEmployees.workerType,
        filters.workerType as (typeof payrollRunEmployees.$inferSelect)["workerType"],
      ),
    );

  if (filters?.department)
    conditions.push(eq(departments.name, filters.department));

  if (filters?.costCenter)
    conditions.push(eq(employeeSalaryProfiles.costCenter, filters.costCenter));

  const rows = await db
    .select({
      lineItem: {
        code: payrollLineItems.code,
        category: payrollLineItems.category,
        amount: payrollLineItems.amount,
      },
      runEmployee: {
        id: payrollRunEmployees.id,
        userId: payrollRunEmployees.userId,
        workerType: payrollRunEmployees.workerType,
        gross: payrollRunEmployees.gross,
        net: payrollRunEmployees.net,
        paidDays: payrollRunEmployees.paidDays,
        totalDeductions: payrollRunEmployees.totalDeductions,
        employerContributions: payrollRunEmployees.employerContributions,
        profileId: payrollRunEmployees.profileId,
      },
      userName: users.name,
      departmentName: departments.name,
      costCenter: employeeSalaryProfiles.costCenter,
    })
    .from(payrollLineItems)
    .innerJoin(
      payrollRunEmployees,
      eq(payrollLineItems.runEmployeeId, payrollRunEmployees.id),
    )
    .innerJoin(users, eq(payrollRunEmployees.userId, users.id))
    .leftJoin(departments, eq(departments.id, users.departmentId))
    .leftJoin(
      employeeSalaryProfiles,
      eq(employeeSalaryProfiles.id, payrollRunEmployees.profileId),
    )
    .where(and(...conditions));

  return rows.map((r) => ({
    lineItem: r.lineItem,
    runEmployee: r.runEmployee,
    userName: r.userName,
    userDept: r.departmentName ?? null,
    costCenter: r.costCenter ?? null,
  }));
}
