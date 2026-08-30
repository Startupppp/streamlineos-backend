import { Injectable, Inject } from "@nestjs/common";
import { eq, and, sql } from "drizzle-orm";
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
import { findRunForMonth, getLineItemsForRun, type LineItemFilters, type RunRow } from "./lib/report-builders";

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

function applyPage<T>(rows: T[], pagination: PaginationParams): T[] {
  const limit = Math.min(pagination.limit ?? 100, 100);
  const offset = pagination.offset ?? 0;
  return rows.slice(offset, offset + limit);
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

    const items = await getLineItemsForRun(this.db, orgId, run.id, filters);
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

    const allRows = [...empMap.values()];
    const columns = [...new Set(allRows.flatMap((r) => Object.keys(r.components)))].sort();
    const rows = applyPage(allRows, pagination);
    return { provisional, columns, rows };
  }

  async getDepartmentCost(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, rows: [] as DeptCostRow[] };

    const whereClause = filters.workerType
      ? and(eq(payrollRunEmployees.runId, run.id), eq(payrollRunEmployees.workerType, filters.workerType as typeof payrollRunEmployees.$inferSelect["workerType"]))
      : eq(payrollRunEmployees.runId, run.id);

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
      .where(whereClause)
      .groupBy(orgUnits.name);

    const allRows: DeptCostRow[] = aggRows
      .filter((r) => !filters.department || r.department === filters.department)
      .map((r) => ({
        department: r.department ?? null,
        employeeCount: r._count,
        grossTotal: r.grossTotal,
        netTotal: r.netTotal,
        employerCostTotal: r.employerCostTotal,
      }));

    return { provisional, rows: applyPage(allRows, pagination) };
  }

  async getCostCenter(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, rows: [] as CostCenterRow[] };

    const whereClause = filters.workerType
      ? and(eq(payrollRunEmployees.runId, run.id), eq(payrollRunEmployees.workerType, filters.workerType as typeof payrollRunEmployees.$inferSelect["workerType"]))
      : eq(payrollRunEmployees.runId, run.id);

    const aggRows = await this.db
      .select({
        costCenter: employeeSalaryProfiles.costCenter,
        _count: sql<number>`COUNT(*)::int`,
        grossTotal: sql<string>`COALESCE(SUM(${payrollRunEmployees.gross}::numeric), 0)::text`,
        netTotal: sql<string>`COALESCE(SUM(${payrollRunEmployees.net}::numeric), 0)::text`,
      })
      .from(payrollRunEmployees)
      .leftJoin(employeeSalaryProfiles, eq(employeeSalaryProfiles.id, payrollRunEmployees.profileId))
      .where(whereClause)
      .groupBy(employeeSalaryProfiles.costCenter);

    const allRows: CostCenterRow[] = aggRows
      .filter((r) => !filters.costCenter || (r.costCenter ?? null) === filters.costCenter)
      .map((r) => ({
        costCenter: r.costCenter ?? null,
        employeeCount: r._count,
        grossTotal: r.grossTotal,
        netTotal: r.netTotal,
      }));

    return { provisional, rows: applyPage(allRows, pagination) };
  }

  async getEarnings(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, orgId, run.id, filters);
    const { columns, rows: allRows } = pivotByEmployee(items, (cat) => cat === "EARNING" || cat === "REIMBURSEMENT");
    return { provisional, columns, rows: applyPage(allRows, pagination) };
  }

  async getDeductions(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, orgId, run.id, filters);
    const { columns, rows: allRows } = pivotByEmployee(items, (cat) => cat === "DEDUCTION" || cat === "TAX" || cat === "ADJUSTMENT");
    return { provisional, columns, rows: applyPage(allRows, pagination) };
  }

  async getReimbursements(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, orgId, run.id, filters);
    const { columns, rows: allRows } = pivotByEmployee(items, (cat) => cat === "REIMBURSEMENT");
    return { provisional, columns, rows: applyPage(allRows, pagination) };
  }

  async getTax(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, orgId, run.id, filters);
    const { columns, rows: allRows } = pivotByEmployee(items, (cat) => cat === "TAX" || cat === "EMPLOYER_CONTRIBUTION");
    return { provisional, columns, rows: applyPage(allRows, pagination) };
  }

  async getBankPayout(orgId: string, month: string, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, batches: [] as BankBatchResult[] };

    const joined = await this.db
      .select({
        batchId: payrollBankBatches.id,
        batchNumber: payrollBankBatches.batchNumber,
        batchFormat: payrollBankBatches.format,
        totalAmount: payrollBankBatches.totalAmount,
        itemCount: payrollBankBatches.itemCount,
        batchStatus: payrollBankBatches.status,
        generatedAt: payrollBankBatches.generatedAt,
        itemAmount: payrollBankBatchItems.amount,
        accountMasked: payrollBankBatchItems.accountMasked,
        ifsc: payrollBankBatchItems.ifsc,
        itemStatus: payrollBankBatchItems.status,
        userName: users.name,
      })
      .from(payrollBankBatches)
      .leftJoin(payrollBankBatchItems, eq(payrollBankBatchItems.batchId, payrollBankBatches.id))
      .leftJoin(users, eq(payrollBankBatchItems.userId, users.id))
      .where(and(eq(payrollBankBatches.orgId, orgId), eq(payrollBankBatches.runId, run.id)));

    const batchMap = new Map<
      number,
      {
        batchNumber: string;
        format: string;
        totalAmount: string;
        itemCount: number;
        status: string;
        generatedAt: Date;
        items: BankItem[];
      }
    >();

    for (const row of joined) {
      if (!batchMap.has(row.batchId)) {
        batchMap.set(row.batchId, {
          batchNumber: row.batchNumber,
          format: row.batchFormat,
          totalAmount: row.totalAmount,
          itemCount: row.itemCount,
          status: row.batchStatus,
          generatedAt: row.generatedAt,
          items: [],
        });
      }
      if (row.itemAmount !== null && row.accountMasked !== null && row.itemStatus !== null) {
        batchMap.get(row.batchId)!.items.push({
          userName: row.userName,
          accountMasked: row.accountMasked,
          ifsc: row.ifsc ?? null,
          amount: row.itemAmount,
          status: row.itemStatus,
        });
      }
    }

    const allBatches = [...batchMap.values()];
    return { provisional, batches: applyPage(allBatches, pagination) };
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

    const currEmps = await this.db
      .select({
        userId: payrollRunEmployees.userId,
        gross: payrollRunEmployees.gross,
        net: payrollRunEmployees.net,
        userName: users.name,
      })
      .from(payrollRunEmployees)
      .innerJoin(users, eq(payrollRunEmployees.userId, users.id))
      .where(eq(payrollRunEmployees.runId, currentRun.id));

    const prevMap = new Map<string, { gross: string; net: string }>();
    if (previousRun) {
      const prevEmps = await this.db
        .select({
          userId: payrollRunEmployees.userId,
          gross: payrollRunEmployees.gross,
          net: payrollRunEmployees.net,
        })
        .from(payrollRunEmployees)
        .where(eq(payrollRunEmployees.runId, previousRun.id));
      for (const e of prevEmps) {
        if (e.userId) prevMap.set(e.userId, { gross: e.gross, net: e.net });
      }
    }

    const allPerEmployee: VarianceEmployeeRow[] = currEmps
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

    return { provisional, current, previous, delta, perEmployee: applyPage(allPerEmployee, pagination) };
  }
}
