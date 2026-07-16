import { Injectable, Inject } from "@nestjs/common";
import { eq, and, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRuns,
  payrollRunEmployees,
  payrollLineItems,
  employeeSalaryProfiles,
  payrollBankBatches,
  payrollBankBatchItems,
  users,
  departments,
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

    const items = await getLineItemsForRun(this.db, run.id, filters);
    const empMap = new Map<string, EmployeeRegisterRow>();

    for (const { lineItem, runEmployee, userName, userDept } of items) {
      const uid = runEmployee.userId;
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

    const empRows = await this.db
      .select({
        userId: payrollRunEmployees.userId,
        gross: payrollRunEmployees.gross,
        net: payrollRunEmployees.net,
        employerContributions: payrollRunEmployees.employerContributions,
        workerType: payrollRunEmployees.workerType,
        departmentId: users.departmentId,
      })
      .from(payrollRunEmployees)
      .innerJoin(users, eq(payrollRunEmployees.userId, users.id))
      .where(
        filters.workerType
          ? and(eq(payrollRunEmployees.runId, run.id), eq(payrollRunEmployees.workerType, filters.workerType as typeof payrollRunEmployees.$inferSelect["workerType"]))
          : eq(payrollRunEmployees.runId, run.id),
      );

    const deptIds = [
      ...new Set(empRows.map((r) => r.departmentId).filter((d): d is number => d !== null)),
    ];
    const deptMap = new Map<number, string>();
    if (deptIds.length > 0) {
      const deptRows = await this.db
        .select({ id: departments.id, name: departments.name })
        .from(departments)
        .where(inArray(departments.id, deptIds));
      for (const d of deptRows) deptMap.set(d.id, d.name);
    }

    const grouped = new Map<string | null, DeptCostRow>();
    for (const r of empRows) {
      const dept = r.departmentId !== null ? (deptMap.get(r.departmentId) ?? null) : null;
      if (filters.department && dept !== filters.department) continue;
      const key = dept ?? "__null__";
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          department: dept,
          employeeCount: 1,
          grossTotal: r.gross,
          netTotal: r.net,
          employerCostTotal: r.employerContributions,
        });
      } else {
        existing.employeeCount += 1;
        existing.grossTotal = (parseFloat(existing.grossTotal) + parseFloat(r.gross)).toFixed(2);
        existing.netTotal = (parseFloat(existing.netTotal) + parseFloat(r.net)).toFixed(2);
        existing.employerCostTotal = (parseFloat(existing.employerCostTotal) + parseFloat(r.employerContributions)).toFixed(2);
      }
    }

    return { provisional, rows: applyPage([...grouped.values()], pagination) };
  }

  async getCostCenter(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, rows: [] as CostCenterRow[] };

    const empRows = await this.db
      .select({
        userId: payrollRunEmployees.userId,
        gross: payrollRunEmployees.gross,
        net: payrollRunEmployees.net,
        workerType: payrollRunEmployees.workerType,
        profileId: payrollRunEmployees.profileId,
      })
      .from(payrollRunEmployees)
      .where(
        filters.workerType
          ? and(eq(payrollRunEmployees.runId, run.id), eq(payrollRunEmployees.workerType, filters.workerType as typeof payrollRunEmployees.$inferSelect["workerType"]))
          : eq(payrollRunEmployees.runId, run.id),
      );

    const profileIds = [
      ...new Set(empRows.map((r) => r.profileId).filter((p): p is number => p !== null)),
    ];

    const ccMap = new Map<number, string | null>();
    if (profileIds.length > 0) {
      const profiles = await this.db
        .select({ id: employeeSalaryProfiles.id, costCenter: employeeSalaryProfiles.costCenter })
        .from(employeeSalaryProfiles)
        .where(inArray(employeeSalaryProfiles.id, profileIds));
      for (const p of profiles) ccMap.set(p.id, p.costCenter ?? null);
    }

    const grouped = new Map<string | null, CostCenterRow>();
    for (const r of empRows) {
      const cc = r.profileId !== null ? (ccMap.get(r.profileId) ?? null) : null;
      if (filters.costCenter && cc !== filters.costCenter) continue;
      const key = cc ?? "__null__";
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, { costCenter: cc, employeeCount: 1, grossTotal: r.gross, netTotal: r.net });
      } else {
        existing.employeeCount += 1;
        existing.grossTotal = (parseFloat(existing.grossTotal) + parseFloat(r.gross)).toFixed(2);
        existing.netTotal = (parseFloat(existing.netTotal) + parseFloat(r.net)).toFixed(2);
      }
    }

    return { provisional, rows: applyPage([...grouped.values()], pagination) };
  }

  async getEarnings(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, run.id, filters);
    const { columns, rows: allRows } = pivotByEmployee(items, (cat) => cat === "EARNING" || cat === "REIMBURSEMENT");
    return { provisional, columns, rows: applyPage(allRows, pagination) };
  }

  async getDeductions(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, run.id, filters);
    const { columns, rows: allRows } = pivotByEmployee(items, (cat) => cat === "DEDUCTION" || cat === "TAX" || cat === "ADJUSTMENT");
    return { provisional, columns, rows: applyPage(allRows, pagination) };
  }

  async getReimbursements(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, run.id, filters);
    const { columns, rows: allRows } = pivotByEmployee(items, (cat) => cat === "REIMBURSEMENT");
    return { provisional, columns, rows: applyPage(allRows, pagination) };
  }

  async getTax(orgId: string, month: string, filters: LineItemFilters, pagination: PaginationParams = {}) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, run.id, filters);
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
      for (const e of prevEmps) prevMap.set(e.userId, { gross: e.gross, net: e.net });
    }

    const allPerEmployee: VarianceEmployeeRow[] = currEmps.map((e) => {
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
