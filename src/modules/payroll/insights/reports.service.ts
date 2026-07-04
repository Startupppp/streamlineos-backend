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

  async getRegister(orgId: string, month: string, filters: LineItemFilters) {
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

    const rows = [...empMap.values()];
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r.components)))].sort();
    return { provisional, columns, rows };
  }

  async getDepartmentCost(orgId: string, month: string, filters: LineItemFilters) {
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

    return { provisional, rows: [...grouped.values()] };
  }

  async getCostCenter(orgId: string, month: string, filters: LineItemFilters) {
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
      for (const p of profiles) ccMap.set(p.id, p.costCenter);
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

    return { provisional, rows: [...grouped.values()] };
  }

  async getEarnings(orgId: string, month: string, filters: LineItemFilters) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, run.id, filters);
    const { columns, rows } = pivotByEmployee(items, (cat) => cat === "EARNING" || cat === "REIMBURSEMENT");
    return { provisional, columns, rows };
  }

  async getDeductions(orgId: string, month: string, filters: LineItemFilters) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, run.id, filters);
    const { columns, rows } = pivotByEmployee(items, (cat) => cat === "DEDUCTION" || cat === "TAX" || cat === "ADJUSTMENT");
    return { provisional, columns, rows };
  }

  async getReimbursements(orgId: string, month: string, filters: LineItemFilters) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, run.id, filters);
    const { columns, rows } = pivotByEmployee(items, (cat) => cat === "REIMBURSEMENT");
    return { provisional, columns, rows };
  }

  async getTax(orgId: string, month: string, filters: LineItemFilters) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, columns: [] as string[], rows: [] as EmployeeRegisterRow[] };

    const items = await getLineItemsForRun(this.db, run.id, filters);
    const { columns, rows } = pivotByEmployee(items, (cat) => cat === "TAX" || cat === "EMPLOYER_CONTRIBUTION");
    return { provisional, columns, rows };
  }

  async getBankPayout(orgId: string, month: string) {
    const run = await findRunForMonth(this.db, orgId, month);
    const provisional = run === null || !isLocked(run.status);
    if (!run) return { provisional, batches: [] as BankBatchResult[] };

    const batches = await this.db
      .select()
      .from(payrollBankBatches)
      .where(and(eq(payrollBankBatches.orgId, orgId), eq(payrollBankBatches.runId, run.id)));

    const results: BankBatchResult[] = [];
    for (const batch of batches) {
      const batchItems = await this.db
        .select({
          amount: payrollBankBatchItems.amount,
          accountMasked: payrollBankBatchItems.accountMasked,
          ifsc: payrollBankBatchItems.ifsc,
          status: payrollBankBatchItems.status,
          userName: users.name,
        })
        .from(payrollBankBatchItems)
        .innerJoin(users, eq(payrollBankBatchItems.userId, users.id))
        .where(eq(payrollBankBatchItems.batchId, batch.id));

      results.push({
        batchNumber: batch.batchNumber,
        format: batch.format,
        totalAmount: batch.totalAmount,
        itemCount: batch.itemCount,
        status: batch.status,
        generatedAt: batch.generatedAt,
        items: batchItems.map((item) => ({
          userName: item.userName,
          accountMasked: item.accountMasked,
          ifsc: item.ifsc,
          amount: item.amount,
          status: item.status,
        })),
      });
    }

    return { provisional, batches: results };
  }

  async getVariance(orgId: string, month: string) {
    const currentRun = await findRunForMonth(this.db, orgId, month);
    const prevMonthStr = prevMonth(month);
    const previousRun = await findRunForMonth(this.db, orgId, prevMonthStr);

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

    const perEmployee: VarianceEmployeeRow[] = currEmps.map((e) => {
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
