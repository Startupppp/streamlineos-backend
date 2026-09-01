import { Injectable, Inject } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollLineItems } from "../../../db/schema";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { findRunForMonth, getLineItemsForRun, getRunEmployeeIds, type LineItemFilters } from "./lib/report-builders";
import { buildCursorPage, type CursorPage } from "../../../common/pagination/cursor";
import {
  decodePayrollIdCursor,
  payrollCursorPosition,
  type PayrollCursorScope,
} from "../payroll-cursor";
import {
  getBankPayout,
  getCostCenter,
  getDepartmentCost,
  getVariance,
} from "./reports-read.service";

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
  cursor?: string;
}

type Pagination = CursorPage<unknown>["pagination"];

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

async function getRunEmployeePage(
  db: Db,
  report: string,
  orgId: string,
  month: string,
  runId: number,
  filters: LineItemFilters,
  pagination: PaginationParams,
): Promise<CursorPage<number>> {
  const limit = Math.min(pagination.limit ?? 100, 100);
  const cursorScope = reportScope(report, orgId, month, runId, filters);
  const position = decodePayrollIdCursor(pagination.cursor, cursorScope);
  const ids = await getRunEmployeeIds(
    db,
    orgId,
    runId,
    filters,
    limit + 1,
    position?.id ?? null,
  );
  return buildCursorPage(ids, limit, (id) =>
    payrollCursorPosition(cursorScope, [id], id),
  );
}

function isLocked(status: string): boolean {
  return (PAYROLL_LOCKED_STATUSES as readonly string[]).includes(status);
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
    const limit = Math.min(pagination.limit ?? 100, 100);
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[], pagination: emptyPagination(limit) };

    const idPage = await getRunEmployeePage(
      this.db,
      "register",
      orgId,
      month,
      run.id,
      filters,
      pagination,
    );

    if (idPage.data.length === 0) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[], pagination: idPage.pagination };

    const items = await getLineItemsForRun(this.db, orgId, run.id, undefined, idPage.data);
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
    return { provisional, columns, rows, pagination: idPage.pagination };
  }

  getDepartmentCost(
    orgId: string,
    month: string,
    filters: LineItemFilters,
    pagination: PaginationParams = {},
  ) {
    return getDepartmentCost(this.db, orgId, month, filters, pagination);
  }

  getCostCenter(
    orgId: string,
    month: string,
    filters: LineItemFilters,
    pagination: PaginationParams = {},
  ) {
    return getCostCenter(this.db, orgId, month, filters, pagination);
  }

  async getEarnings(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const limit = Math.min(pagination.limit ?? 100, 100);
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[], pagination: emptyPagination(limit) };

    const idPage = await getRunEmployeePage(this.db, "earnings", orgId, month, run.id, filters, pagination);

    if (idPage.data.length === 0) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[], pagination: idPage.pagination };

    const items = await getLineItemsForRun(this.db, orgId, run.id, undefined, idPage.data);
    const { columns, rows } = pivotByEmployee(items, (cat) => cat === "EARNING" || cat === "REIMBURSEMENT");
    return { provisional, columns, rows, pagination: idPage.pagination };
  }

  async getDeductions(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const limit = Math.min(pagination.limit ?? 100, 100);
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[], pagination: emptyPagination(limit) };

    const idPage = await getRunEmployeePage(this.db, "deductions", orgId, month, run.id, filters, pagination);

    if (idPage.data.length === 0) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[], pagination: idPage.pagination };

    const items = await getLineItemsForRun(this.db, orgId, run.id, undefined, idPage.data);
    const { columns, rows } = pivotByEmployee(items, (cat) => cat === "DEDUCTION" || cat === "TAX" || cat === "ADJUSTMENT");
    return { provisional, columns, rows, pagination: idPage.pagination };
  }

  async getReimbursements(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const limit = Math.min(pagination.limit ?? 100, 100);
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[], pagination: emptyPagination(limit) };

    const idPage = await getRunEmployeePage(this.db, "reimbursements", orgId, month, run.id, filters, pagination);

    if (idPage.data.length === 0) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[], pagination: idPage.pagination };

    const items = await getLineItemsForRun(this.db, orgId, run.id, undefined, idPage.data);
    const { columns, rows } = pivotByEmployee(items, (cat) => cat === "REIMBURSEMENT");
    return { provisional, columns, rows, pagination: idPage.pagination };
  }

  async getTax(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const limit = Math.min(pagination.limit ?? 100, 100);
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[], pagination: emptyPagination(limit) };

    const idPage = await getRunEmployeePage(this.db, "tax", orgId, month, run.id, filters, pagination);

    if (idPage.data.length === 0) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[], pagination: idPage.pagination };

    const items = await getLineItemsForRun(this.db, orgId, run.id, undefined, idPage.data);
    const { columns, rows } = pivotByEmployee(items, (cat) => cat === "TAX" || cat === "EMPLOYER_CONTRIBUTION");
    return { provisional, columns, rows, pagination: idPage.pagination };
  }

  getBankPayout(orgId: string, month: string, pagination: PaginationParams = {}) {
    return getBankPayout(this.db, orgId, month, pagination);
  }

  getVariance(orgId: string, month: string, pagination: PaginationParams = {}) {
    return getVariance(this.db, orgId, month, pagination);
  }
}
