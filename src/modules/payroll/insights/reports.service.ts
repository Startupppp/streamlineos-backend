import { Injectable, Inject } from "@nestjs/common";
import { eq, and, asc, inArray, sql } from "drizzle-orm";
import { livePersonOfUser, primaryEmploymentOfPerson, orgUnitInOrg } from "../../directory/employment-query";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrEmployments, hrPeople } from "../../../db/schema/hr/core-people";
import {
  payrollRunEmployees,
  payrollLineItems,
  employeeSalaryProfiles,
  payrollBankBatches,
  payrollBankBatchItems,
  orgUnits,
  users,
} from "../../../db/schema";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { findRunForMonth, getLineItemsForRun, getRunEmployeeIds, type LineItemFilters, type RunRow } from "./lib/report-builders";

type SalaryComponentCategory = typeof payrollLineItems.$inferSelect["category"];

export interface EmployeeRegisterRow {
  employeeId: string;
  name: string | null;
  department: string | null;
  workerType: string;
  paidDays: string;
  gross: string;
  totalDeductions: string;
  net: string;
  components: Record<string, string>;
}

export interface DeptCostRow {
  department: string | null;
  employeeCount: number;
  grossTotal: string;
  netTotal: string;
  employerCostTotal: string;
}

export interface CostCenterRow {
  costCenter: string | null;
  employeeCount: number;
  grossTotal: string;
  netTotal: string;
}

export interface BankItem {
  userName: string | null;
  accountMasked: string;
  ifsc: string | null;
  amount: string;
  status: string;
}

export interface BankBatchResult {
  batchNumber: string;
  format: string;
  totalAmount: string;
  itemCount: number;
  status: string;
  generatedAt: Date;
  items: BankItem[];
}

export interface VarianceEmployeeRow {
  userId: string;
  name: string | null;
  prevGross: string;
  currGross: string;
  grossDelta: string;
  prevNet: string;
  currNet: string;
  netDelta: string;
}

export interface PaginationParams {
  limit?: number;
  offset?: number;
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

function pivotByEmployee(
  items: Awaited<ReturnType<typeof getLineItemsForRun>>,
  categoryFilter: (cat: SalaryComponentCategory) => boolean,
): { columns: string[]; rows: EmployeeRegisterRow[] } {
  const empMap = new Map<string, EmployeeRegisterRow>();

  for (const { lineItem, runEmployee, userName, userDept } of items) {
    if (!categoryFilter(lineItem.category)) continue;
    const uid = runEmployee.userId;
    if (!uid) continue;
    if (!empMap.has(uid)) {
      empMap.set(uid, {
        employeeId: uid,
        name: userName,
        department: userDept,
        workerType: runEmployee.workerType,
        paidDays: runEmployee.paidDays,
        gross: runEmployee.gross,
        totalDeductions: runEmployee.totalDeductions,
        net: runEmployee.net,
        components: {},
      });
    }
    const row = empMap.get(uid)!;
    const existing = row.components[lineItem.code] ?? "0";
    row.components[lineItem.code] = (parseFloat(existing) + parseFloat(lineItem.amount)).toFixed(2);
  }

  const rows = [...empMap.values()];
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r.components)))].sort();
  return { columns, rows };
}

@Injectable()
export class ReportsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getSummary(orgId: string, month: string) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, run: null };
    return {
      provisional,
      run: {
        month: run.month,
        status: run.status,
        employeeCount: run.employeeCount,
        grossTotal: run.grossTotal,
        deductionTotal: run.deductionTotal,
        netTotal: run.netTotal,
        employerCostTotal: run.employerCostTotal,
        exceptionCount: run.exceptionCount,
      },
    };
  }

  async getRegister(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const limit = Math.min(pagination.limit ?? 100, 100);
    const offset = pagination.offset ?? 0;
    const runEmployeeIds = await getRunEmployeeIds(this.db, orgId, run.id, filters, limit, offset);

    if (runEmployeeIds.length === 0) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, orgId, run.id, undefined, runEmployeeIds);
    const empMap = new Map<string, EmployeeRegisterRow>();

    for (const { lineItem, runEmployee, userName, userDept } of items) {
      const uid = runEmployee.userId;
      if (!uid) continue;
      if (!empMap.has(uid)) {
        empMap.set(uid, {
          employeeId: uid,
          name: userName,
          department: userDept,
          workerType: runEmployee.workerType,
          paidDays: runEmployee.paidDays,
          gross: runEmployee.gross,
          totalDeductions: runEmployee.totalDeductions,
          net: runEmployee.net,
          components: {},
        });
      }
      const row = empMap.get(uid)!;
      const existing = row.components[lineItem.code] ?? "0";
      row.components[lineItem.code] = (parseFloat(existing) + parseFloat(lineItem.amount)).toFixed(2);
    }

    const rows = [...empMap.values()];
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r.components)))].sort();
    return { provisional, columns, rows };
  }

  async getDepartmentCost(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, rows: [] as DeptCostRow[] };

    const limit = Math.min(pagination.limit ?? 100, 100);
    const offset = pagination.offset ?? 0;

    const deptConditions = [eq(payrollRunEmployees.runId, run.id)];
    if (filters.workerType) deptConditions.push(eq(payrollRunEmployees.workerType, filters.workerType as typeof payrollRunEmployees.$inferSelect["workerType"]));
    if (filters.department) deptConditions.push(eq(orgUnits.name, filters.department));

    const aggRows = await this.db
      .select({
        department: orgUnits.name,
        _count: sql<number>`COUNT(*)::int`,
        grossTotal: sql<string>`COALESCE(SUM(${payrollRunEmployees.gross}::numeric), 0)::text`,
        netTotal: sql<string>`COALESCE(SUM(${payrollRunEmployees.net}::numeric), 0)::text`,
        employerCostTotal: sql<string>`COALESCE(SUM(${payrollRunEmployees.employerContributions}::numeric), 0)::text`,
      })
      .from(payrollRunEmployees)
      .innerJoin(users, eq(payrollRunEmployees.userId, users.id))
      .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
      .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
      .leftJoin(orgUnits, and(orgUnitInOrg(orgId, hrEmployments.departmentId), eq(orgUnits.kind, "DEPARTMENT")))
      .where(and(...deptConditions))
      .groupBy(orgUnits.name)
      .orderBy(asc(orgUnits.name), sql<number>`MIN(${orgUnits.id})`)
      .limit(limit)
      .offset(offset);

    const rows: DeptCostRow[] = aggRows.map((r) => ({
      department: r.department ?? null,
      employeeCount: r._count,
      grossTotal: r.grossTotal,
      netTotal: r.netTotal,
      employerCostTotal: r.employerCostTotal,
    }));

    return { provisional, rows };
  }

  async getCostCenter(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, rows: [] as CostCenterRow[] };

    const limit = Math.min(pagination.limit ?? 100, 100);
    const offset = pagination.offset ?? 0;

    const ccConditions = [eq(payrollRunEmployees.runId, run.id)];
    if (filters.workerType) ccConditions.push(eq(payrollRunEmployees.workerType, filters.workerType as typeof payrollRunEmployees.$inferSelect["workerType"]));
    if (filters.costCenter) ccConditions.push(eq(employeeSalaryProfiles.costCenter, filters.costCenter));

    const aggRows = await this.db
      .select({
        costCenter: employeeSalaryProfiles.costCenter,
        _count: sql<number>`COUNT(*)::int`,
        grossTotal: sql<string>`COALESCE(SUM(${payrollRunEmployees.gross}::numeric), 0)::text`,
        netTotal: sql<string>`COALESCE(SUM(${payrollRunEmployees.net}::numeric), 0)::text`,
      })
      .from(payrollRunEmployees)
      .leftJoin(employeeSalaryProfiles, eq(employeeSalaryProfiles.id, payrollRunEmployees.profileId))
      .where(and(...ccConditions))
      .groupBy(employeeSalaryProfiles.costCenter)
      .orderBy(asc(employeeSalaryProfiles.costCenter), sql<number>`MIN(${employeeSalaryProfiles.id})`)
      .limit(limit)
      .offset(offset);

    const rows: CostCenterRow[] = aggRows.map((r) => ({
      costCenter: r.costCenter ?? null,
      employeeCount: r._count,
      grossTotal: r.grossTotal,
      netTotal: r.netTotal,
    }));

    return { provisional, rows };
  }

  async getEarnings(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const limit = Math.min(pagination.limit ?? 100, 100);
    const offset = pagination.offset ?? 0;
    const runEmployeeIds = await getRunEmployeeIds(this.db, orgId, run.id, filters, limit, offset);

    if (runEmployeeIds.length === 0) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, orgId, run.id, undefined, runEmployeeIds);
    const { columns, rows } = pivotByEmployee(items, (cat) => cat === "EARNING" || cat === "REIMBURSEMENT");
    return { provisional, columns, rows };
  }

  async getDeductions(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const limit = Math.min(pagination.limit ?? 100, 100);
    const offset = pagination.offset ?? 0;
    const runEmployeeIds = await getRunEmployeeIds(this.db, orgId, run.id, filters, limit, offset);

    if (runEmployeeIds.length === 0) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, orgId, run.id, undefined, runEmployeeIds);
    const { columns, rows } = pivotByEmployee(items, (cat) => cat === "DEDUCTION" || cat === "TAX" || cat === "ADJUSTMENT");
    return { provisional, columns, rows };
  }

  async getReimbursements(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const limit = Math.min(pagination.limit ?? 100, 100);
    const offset = pagination.offset ?? 0;
    const runEmployeeIds = await getRunEmployeeIds(this.db, orgId, run.id, filters, limit, offset);

    if (runEmployeeIds.length === 0) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, orgId, run.id, undefined, runEmployeeIds);
    const { columns, rows } = pivotByEmployee(items, (cat) => cat === "REIMBURSEMENT");
    return { provisional, columns, rows };
  }

  async getTax(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const limit = Math.min(pagination.limit ?? 100, 100);
    const offset = pagination.offset ?? 0;
    const runEmployeeIds = await getRunEmployeeIds(this.db, orgId, run.id, filters, limit, offset);

    if (runEmployeeIds.length === 0) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, orgId, run.id, undefined, runEmployeeIds);
    const { columns, rows } = pivotByEmployee(items, (cat) => cat === "TAX" || cat === "EMPLOYER_CONTRIBUTION");
    return { provisional, columns, rows };
  }

  async getBankPayout(orgId: string, month: string, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, batches: [] as BankBatchResult[] };

    const limit = Math.min(pagination.limit ?? 100, 100);
    const offset = pagination.offset ?? 0;

    const batches = await this.db
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
      .where(and(eq(payrollBankBatches.orgId, orgId), eq(payrollBankBatches.runId, run.id)))
      .orderBy(asc(payrollBankBatches.id))
      .limit(limit)
      .offset(offset);

    if (batches.length === 0) return { provisional, batches: [] as BankBatchResult[] };

    const batchIds = batches.map((b) => b.id);
    const items = await this.db
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
      batches: batches.map((b) => ({
        batchNumber: b.batchNumber,
        format: b.format,
        totalAmount: b.totalAmount,
        itemCount: b.itemCount,
        status: b.status,
        generatedAt: b.generatedAt,
        items: itemsByBatch.get(b.id) ?? [],
      })),
    };
  }

  async getVariance(orgId: string, month: string, pagination: PaginationParams = {}) {
    const prevMonthStr = prevMonth(month);
    const [currentRun, previousRun] = await Promise.all([
      findRunForMonth(this.db, orgId, month),
      findRunForMonth(this.db, orgId, prevMonthStr),
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

    if (!currentRun) return { provisional, current, previous, delta, perEmployee: [] as VarianceEmployeeRow[] };

    const limit = Math.min(pagination.limit ?? 100, 100);
    const offset = pagination.offset ?? 0;

    const currEmps = await this.db
      .select({
        userId: payrollRunEmployees.userId,
        gross: payrollRunEmployees.gross,
        net: payrollRunEmployees.net,
        userName: users.name,
      })
      .from(payrollRunEmployees)
      .innerJoin(users, eq(payrollRunEmployees.userId, users.id))
      .where(eq(payrollRunEmployees.runId, currentRun.id))
      .orderBy(asc(payrollRunEmployees.id))
      .limit(limit)
      .offset(offset);

    const currUserIds = currEmps
      .filter((e): e is typeof e & { userId: string } => e.userId !== null)
      .map((e) => e.userId);

    const prevMap = new Map<string, { gross: string; net: string }>();
    if (previousRun && currUserIds.length > 0) {
      const prevEmps = await this.db
        .select({
          userId: payrollRunEmployees.userId,
          gross: payrollRunEmployees.gross,
          net: payrollRunEmployees.net,
        })
        .from(payrollRunEmployees)
        .where(and(eq(payrollRunEmployees.runId, previousRun.id), inArray(payrollRunEmployees.userId, currUserIds)));
      for (const e of prevEmps) {
        if (e.userId) prevMap.set(e.userId, { gross: e.gross, net: e.net });
      }
    }

    const perEmployee: VarianceEmployeeRow[] = currEmps
      .filter((e): e is typeof e & { userId: string } => e.userId !== null)
      .map((e) => {
        const prev = prevMap.get(e.userId) ?? { gross: "0.00", net: "0.00" };
        return {
          userId: e.userId,
          name: e.userName,
          prevGross: prev.gross,
          currGross: e.gross,
          grossDelta: deltaDec(prev.gross, e.gross),
          prevNet: prev.net,
          currNet: e.net,
          netDelta: deltaDec(prev.net, e.net),
        };
      });

    return { provisional, current, previous, delta, perEmployee };
  }
}
