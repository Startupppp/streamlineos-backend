import { and, asc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { livePersonOfUser, orgUnitInOrg, primaryEmploymentOfPerson } from "../../directory/employment-query";
import type { Db } from "../../../db/drizzle.module";
import {
  employeeSalaryProfiles,
  hrEmployments,
  hrPeople,
  orgUnits,
  payrollBankBatchItems,
  payrollBankBatches,
  payrollRunEmployees,
  users,
} from "../../../db/schema";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import {
  findRunForMonth,
  type LineItemFilters,
  type RunRow,
} from "./lib/report-builders";
import { buildCursorPage } from "../../../common/pagination/cursor";
import {
  decodePayrollIdCursor,
  decodePayrollNullableTextCursor,
  payrollCursorPosition,
  type PayrollCursorScope,
} from "../payroll-cursor";
import type {
  BankBatchResult,
  BankItem,
  CostCenterRow,
  DeptCostRow,
  PaginationParams,
  VarianceEmployeeRow,
} from "./reports.service";

type Pagination = { limit: number; hasMore: boolean; nextCursor: string | null };

function emptyPagination(limit: number): Pagination {
  return { limit, hasMore: false, nextCursor: null };
}

function reportScope(
  report: string,
  orgId: string,
  month: string,
  runId: number,
  filters: LineItemFilters = {},
): PayrollCursorScope {
  return [
    "report",
    report,
    orgId,
    month,
    runId,
    filters.department ?? null,
    filters.costCenter ?? null,
    filters.workerType ?? null,
  ];
}

function isLocked(status: string): boolean {
  return (PAYROLL_LOCKED_STATUSES as readonly string[]).includes(status);
}

function prevMonth(month: string): string {
  const parts = month.split("-");
  const year = parseInt(parts[0] ?? "2024", 10);
  const mo = parseInt(parts[1] ?? "1", 10);
  if (mo === 1) return `${year - 1}-12`;
  return `${year}-${String(mo - 1).padStart(2, "0")}`;
}

function deltaDec(a: string, b: string): string {
  return (parseFloat(b) - parseFloat(a)).toFixed(2);
}

export async function getDepartmentCost(
  db: Db,
  orgId: string,
  month: string,
  filters: LineItemFilters,
  pagination: PaginationParams = {},
) {
  const limit = Math.min(pagination.limit ?? 100, 100);
  const run = await findRunForMonth(db, orgId, month);
  const provisional = run === null || !isLocked(run.status);
  if (!run) return { provisional, rows: [] as DeptCostRow[], pagination: emptyPagination(limit) };

  const cursorScope = reportScope("department-cost", orgId, month, run.id, filters);
  const position = decodePayrollNullableTextCursor(pagination.cursor, cursorScope);
  const departmentSortId = sql<number>`COALESCE(MIN(${orgUnits.id}), 0)`;
  const cursorHaving: SQL | undefined = position
    ? position.value === null
      ? sql`${orgUnits.name} IS NULL AND ${departmentSortId} > ${position.id}`
      : sql`(${orgUnits.name} > ${position.value} OR ${orgUnits.name} IS NULL OR (${orgUnits.name} = ${position.value} AND ${departmentSortId} > ${position.id}))`
    : undefined;

  const deptConditions = [
    eq(payrollRunEmployees.orgId, orgId),
    eq(payrollRunEmployees.runId, run.id),
  ];
  if (filters.workerType) deptConditions.push(eq(payrollRunEmployees.workerType, filters.workerType as typeof payrollRunEmployees.$inferSelect["workerType"]));
  if (filters.department) deptConditions.push(eq(orgUnits.name, filters.department));

  const aggRows = await db
    .select({
      department: orgUnits.name,
      _count: sql<number>`COUNT(*)::int`,
      grossTotal: sql<string>`COALESCE(SUM(${payrollRunEmployees.gross}::numeric), 0)::text`,
      netTotal: sql<string>`COALESCE(SUM(${payrollRunEmployees.net}::numeric), 0)::text`,
      employerCostTotal: sql<string>`COALESCE(SUM(${payrollRunEmployees.employerContributions}::numeric), 0)::text`,
      _sortId: departmentSortId,
    })
    .from(payrollRunEmployees)
    .innerJoin(users, eq(payrollRunEmployees.userId, users.id))
    .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
    .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
    .leftJoin(orgUnits, and(orgUnitInOrg(orgId, hrEmployments.departmentId), eq(orgUnits.kind, "DEPARTMENT")))
    .where(and(...deptConditions))
    .groupBy(orgUnits.name)
    .having(cursorHaving)
    .orderBy(asc(orgUnits.name), asc(departmentSortId))
    .limit(limit + 1);

  const page = buildCursorPage(aggRows, limit, (row) =>
    payrollCursorPosition(cursorScope, [row.department], row._sortId),
  );
  const rows: DeptCostRow[] = page.data.map((row) => ({
    department: row.department ?? null,
    employeeCount: row._count,
    grossTotal: row.grossTotal,
    netTotal: row.netTotal,
    employerCostTotal: row.employerCostTotal,
  }));
  return { provisional, rows, pagination: page.pagination };
}

export async function getCostCenter(
  db: Db,
  orgId: string,
  month: string,
  filters: LineItemFilters,
  pagination: PaginationParams = {},
) {
  const limit = Math.min(pagination.limit ?? 100, 100);
  const run = await findRunForMonth(db, orgId, month);
  const provisional = run === null || !isLocked(run.status);
  if (!run) return { provisional, rows: [] as CostCenterRow[], pagination: emptyPagination(limit) };

  const cursorScope = reportScope("cost-center", orgId, month, run.id, filters);
  const position = decodePayrollNullableTextCursor(pagination.cursor, cursorScope);
  const costCenterSortId = sql<number>`COALESCE(MIN(${employeeSalaryProfiles.id}), 0)`;
  const cursorHaving: SQL | undefined = position
    ? position.value === null
      ? sql`${employeeSalaryProfiles.costCenter} IS NULL AND ${costCenterSortId} > ${position.id}`
      : sql`(${employeeSalaryProfiles.costCenter} > ${position.value} OR ${employeeSalaryProfiles.costCenter} IS NULL OR (${employeeSalaryProfiles.costCenter} = ${position.value} AND ${costCenterSortId} > ${position.id}))`
    : undefined;

  const ccConditions = [
    eq(payrollRunEmployees.orgId, orgId),
    eq(payrollRunEmployees.runId, run.id),
  ];
  if (filters.workerType) ccConditions.push(eq(payrollRunEmployees.workerType, filters.workerType as typeof payrollRunEmployees.$inferSelect["workerType"]));
  if (filters.costCenter) ccConditions.push(eq(employeeSalaryProfiles.costCenter, filters.costCenter));

  const aggRows = await db
    .select({
      costCenter: employeeSalaryProfiles.costCenter,
      _count: sql<number>`COUNT(*)::int`,
      grossTotal: sql<string>`COALESCE(SUM(${payrollRunEmployees.gross}::numeric), 0)::text`,
      netTotal: sql<string>`COALESCE(SUM(${payrollRunEmployees.net}::numeric), 0)::text`,
      _sortId: costCenterSortId,
    })
    .from(payrollRunEmployees)
    .leftJoin(employeeSalaryProfiles, eq(employeeSalaryProfiles.id, payrollRunEmployees.profileId))
    .where(and(...ccConditions))
    .groupBy(employeeSalaryProfiles.costCenter)
    .having(cursorHaving)
    .orderBy(asc(employeeSalaryProfiles.costCenter), asc(costCenterSortId))
    .limit(limit + 1);

  const page = buildCursorPage(aggRows, limit, (row) =>
    payrollCursorPosition(cursorScope, [row.costCenter], row._sortId),
  );
  const rows: CostCenterRow[] = page.data.map((row) => ({
    costCenter: row.costCenter ?? null,
    employeeCount: row._count,
    grossTotal: row.grossTotal,
    netTotal: row.netTotal,
  }));
  return { provisional, rows, pagination: page.pagination };
}

export async function getBankPayout(
  db: Db,
  orgId: string,
  month: string,
  pagination: PaginationParams = {},
) {
  const limit = Math.min(pagination.limit ?? 100, 100);
  const run = await findRunForMonth(db, orgId, month);
  const provisional = run === null || !isLocked(run.status);
  if (!run) return { provisional, batches: [] as BankBatchResult[], pagination: emptyPagination(limit) };

  const cursorScope = reportScope("bank-payout", orgId, month, run.id);
  const position = decodePayrollIdCursor(pagination.cursor, cursorScope);
  const conditions = [
    eq(payrollBankBatches.orgId, orgId),
    eq(payrollBankBatches.runId, run.id),
  ];
  if (position) conditions.push(gt(payrollBankBatches.id, position.id));

  const batches = await db
    .select({
      id: payrollBankBatches.id,
      batchNumber: payrollBankBatches.batchNumber,
      format: payrollBankBatches.format,
      totalAmount: payrollBankBatches.totalAmount,
      itemCount: payrollBankBatches.itemCount,
      status: payrollBankBatches.status,
      generatedAt: payrollBankBatches.generatedAt,
    })
    .from(payrollBankBatches)
    .where(and(...conditions))
    .orderBy(asc(payrollBankBatches.id))
    .limit(limit + 1);

  const page = buildCursorPage(batches, limit, (row) =>
    payrollCursorPosition(cursorScope, [row.id], row.id),
  );
  if (page.data.length === 0) return { provisional, batches: [] as BankBatchResult[], pagination: page.pagination };

  const batchIds = page.data.map((batch) => batch.id);
  const items = await db
    .select({
      batchId: payrollBankBatchItems.batchId,
      itemAmount: payrollBankBatchItems.amount,
      accountMasked: payrollBankBatchItems.accountMasked,
      ifsc: payrollBankBatchItems.ifsc,
      itemStatus: payrollBankBatchItems.status,
      userName: users.name,
    })
    .from(payrollBankBatchItems)
    .leftJoin(users, eq(payrollBankBatchItems.userId, users.id))
    .where(inArray(payrollBankBatchItems.batchId, batchIds));

  const itemsByBatch = new Map<number, BankItem[]>();
  for (const item of items) {
    if (item.itemAmount === null || item.accountMasked === null || item.itemStatus === null) continue;
    const list = itemsByBatch.get(item.batchId) ?? [];
    list.push({
      userName: item.userName,
      accountMasked: item.accountMasked,
      ifsc: item.ifsc ?? null,
      amount: item.itemAmount,
      status: item.itemStatus,
    });
    itemsByBatch.set(item.batchId, list);
  }

  return {
    provisional,
    batches: page.data.map((batch) => ({
      batchNumber: batch.batchNumber,
      format: batch.format,
      totalAmount: batch.totalAmount,
      itemCount: batch.itemCount,
      status: batch.status,
      generatedAt: batch.generatedAt,
      items: itemsByBatch.get(batch.id) ?? [],
    })),
    pagination: page.pagination,
  };
}

export async function getVariance(
  db: Db,
  orgId: string,
  month: string,
  pagination: PaginationParams = {},
) {
  const limit = Math.min(pagination.limit ?? 100, 100);
  const prevMonthStr = prevMonth(month);
  const [currentRun, previousRun] = await Promise.all([
    findRunForMonth(db, orgId, month),
    findRunForMonth(db, orgId, prevMonthStr),
  ]);

  const provisional = currentRun === null || !isLocked(currentRun.status);
  const toSummary = (run: RunRow | null) =>
    run
      ? { month: run.month, gross: run.grossTotal, net: run.netTotal }
      : { month: "", gross: "0.00", net: "0.00" };
  const current = toSummary(currentRun);
  const previous = toSummary(previousRun);
  const delta = {
    gross: deltaDec(previous.gross, current.gross),
    net: deltaDec(previous.net, current.net),
  };
  if (!currentRun) return { provisional, current, previous, delta, perEmployee: [] as VarianceEmployeeRow[], pagination: emptyPagination(limit) };

  const cursorScope = [
    "report",
    "variance",
    orgId,
    month,
    currentRun.id,
    previousRun?.id ?? null,
  ] as const;
  const position = decodePayrollIdCursor(pagination.cursor, cursorScope);
  const conditions = [
    eq(payrollRunEmployees.orgId, orgId),
    eq(payrollRunEmployees.runId, currentRun.id),
  ];
  if (position) conditions.push(gt(payrollRunEmployees.id, position.id));

  const currEmps = await db
    .select({
      id: payrollRunEmployees.id,
      userId: payrollRunEmployees.userId,
      gross: payrollRunEmployees.gross,
      net: payrollRunEmployees.net,
      userName: users.name,
    })
    .from(payrollRunEmployees)
    .innerJoin(users, eq(payrollRunEmployees.userId, users.id))
    .where(and(...conditions))
    .orderBy(asc(payrollRunEmployees.id))
    .limit(limit + 1);

  const page = buildCursorPage(currEmps, limit, (row) =>
    payrollCursorPosition(cursorScope, [row.id], row.id),
  );
  const currUserIds = page.data
    .filter((employee): employee is typeof employee & { userId: string } => employee.userId !== null)
    .map((employee) => employee.userId);

  const prevMap = new Map<string, { gross: string; net: string }>();
  if (previousRun && currUserIds.length > 0) {
    const prevEmps = await db
      .select({
        userId: payrollRunEmployees.userId,
        gross: payrollRunEmployees.gross,
        net: payrollRunEmployees.net,
      })
      .from(payrollRunEmployees)
      .where(and(eq(payrollRunEmployees.runId, previousRun.id), inArray(payrollRunEmployees.userId, currUserIds)));
    for (const employee of prevEmps) {
      if (employee.userId) prevMap.set(employee.userId, { gross: employee.gross, net: employee.net });
    }
  }

  const perEmployee: VarianceEmployeeRow[] = page.data
    .filter((employee): employee is typeof employee & { userId: string } => employee.userId !== null)
    .map((employee) => {
      const prev = prevMap.get(employee.userId) ?? { gross: "0.00", net: "0.00" };
      return {
        userId: employee.userId,
        name: employee.userName,
        prevGross: prev.gross,
        currGross: employee.gross,
        grossDelta: deltaDec(prev.gross, employee.gross),
        prevNet: prev.net,
        currNet: employee.net,
        netDelta: deltaDec(prev.net, employee.net),
      };
    });

  return { provisional, current, previous, delta, perEmployee, pagination: page.pagination };
}
