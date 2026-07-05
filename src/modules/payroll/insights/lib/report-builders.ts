import { eq, and, inArray } from "drizzle-orm";
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
export type LineItemRow = typeof payrollLineItems.$inferSelect;

export type RunEmployeeRow = Pick<
  typeof payrollRunEmployees.$inferSelect,
  "id" | "userId" | "workerType" | "gross" | "net" | "paidDays" | "totalDeductions" | "employerContributions" | "profileId"
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
  const rows = await db
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.orgId, orgId), eq(payrollRuns.month, month)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getLineItemsForRun(
  db: Db,
  runId: number,
  filters?: LineItemFilters,
): Promise<EnrichedLineItem[]> {
  const rows = await db
    .select({
      lineItem: payrollLineItems,
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
      departmentId: users.departmentId,
      profileId: payrollRunEmployees.profileId,
    })
    .from(payrollLineItems)
    .innerJoin(payrollRunEmployees, eq(payrollLineItems.runEmployeeId, payrollRunEmployees.id))
    .innerJoin(users, eq(payrollRunEmployees.userId, users.id))
    .where(
      filters?.workerType
        ? and(eq(payrollLineItems.runId, runId), eq(payrollRunEmployees.workerType, filters.workerType as typeof payrollRunEmployees.$inferSelect["workerType"]))
        : eq(payrollLineItems.runId, runId),
    );

  const deptIds = [
    ...new Set(
      rows
        .map((r) => r.departmentId)
        .filter((d): d is number => d !== null),
    ),
  ];

  const deptMap = new Map<number, string>();
  if (deptIds.length > 0) {
    const deptRows = await db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(inArray(departments.id, deptIds));
    for (const d of deptRows) deptMap.set(d.id, d.name);
  }

  const profileIds = [
    ...new Set(rows.map((r) => r.profileId).filter((p): p is number => p !== null)),
  ];

  const ccMap = new Map<number, string | null>();
  if (profileIds.length > 0) {
    const profiles = await db
      .select({ id: employeeSalaryProfiles.id, costCenter: employeeSalaryProfiles.costCenter })
      .from(employeeSalaryProfiles)
      .where(inArray(employeeSalaryProfiles.id, profileIds));
    for (const p of profiles) ccMap.set(p.id, p.costCenter ?? null);
  }

  const enriched: EnrichedLineItem[] = rows.map((r) => ({
    lineItem: r.lineItem,
    runEmployee: r.runEmployee,
    userName: r.userName,
    userDept: r.departmentId !== null ? (deptMap.get(r.departmentId) ?? null) : null,
    costCenter: r.profileId !== null ? (ccMap.get(r.profileId) ?? null) : null,
  }));

  if (filters?.department && filters.costCenter) {
    return enriched.filter(
      (e) => e.userDept === filters.department && e.costCenter === filters.costCenter,
    );
  }

  if (filters?.department) {
    return enriched.filter((e) => e.userDept === filters.department);
  }

  if (filters?.costCenter) {
    return enriched.filter((e) => e.costCenter === filters.costCenter);
  }

  return enriched;
}
