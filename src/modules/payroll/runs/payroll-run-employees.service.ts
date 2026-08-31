import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, asc, count, eq, gt, ilike, or, type SQL } from "drizzle-orm";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../common/pagination/cursor";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRuns,
  payrollRunEmployees,
  payrollLineItems,
  payrollBankBatches,
  payrollBankBatchItems,
} from "../../../db/schema";
import { users } from "../../../db/schema";
import type { DataScope } from "../../access/access.types";
import { applyScope } from "../../access/apply-scope";
import type { ListRunEmployeesQuery, AddRunAdjustmentInput } from "./dto/runs.schemas";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { toPaise, fromPaise } from "./lib/money";
import { AuditService } from "../../../common/audit/audit.service";

@Injectable()
export class PayrollRunEmployeesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async setEmployeeHold(
    orgId: string,
    runId: number,
    runEmployeeId: number,
    hold: boolean,
    reason: string | null,
    actorId: string,
  ): Promise<{ ok: boolean }> {
    const runCheck = await this.db
      .select({ id: payrollRuns.id, status: payrollRuns.status })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!runCheck[0]) return { ok: false };
    if (PAYROLL_LOCKED_STATUSES.includes(runCheck[0].status)) {
      throw new ConflictException(
        `Cannot modify employee hold on a ${runCheck[0].status} payroll run`,
      );
    }

    const existing = await this.db
      .select({ id: payrollRunEmployees.id })
      .from(payrollRunEmployees)
      .where(and(
        eq(payrollRunEmployees.id, runEmployeeId),
        eq(payrollRunEmployees.runId, runId),
        eq(payrollRunEmployees.orgId, orgId),
      ))
      .limit(1);

    if (!existing[0]) return { ok: false };

    await this.db
      .update(payrollRunEmployees)
      .set({ holdReason: hold ? (reason ?? "On hold") : null })
      .where(and(eq(payrollRunEmployees.id, runEmployeeId), eq(payrollRunEmployees.orgId, orgId)));

    this.audit.log({
      action: hold ? "payroll.employee_held" : "payroll.employee_unheld",
      userId: actorId,
      orgId,
      targetId: String(runEmployeeId),
      targetType: "payroll_run_employee",
      metadata: { runId, reason: reason ?? null },
    });

    return { ok: true };
  }

  async addRunAdjustment(
    orgId: string,
    runId: number,
    runEmployeeId: number,
    body: AddRunAdjustmentInput,
    actorId: string,
  ): Promise<{ ok: true } | { ok: false; reason: "not_found" | "locked" }> {
    const runCheck = await this.db
      .select({ id: payrollRuns.id, status: payrollRuns.status })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!runCheck[0]) return { ok: false, reason: "not_found" };
    if (PAYROLL_LOCKED_STATUSES.includes(runCheck[0].status)) return { ok: false, reason: "locked" };

    const empCheck = await this.db
      .select({ id: payrollRunEmployees.id, gross: payrollRunEmployees.gross, totalDeductions: payrollRunEmployees.totalDeductions, net: payrollRunEmployees.net })
      .from(payrollRunEmployees)
      .where(and(
        eq(payrollRunEmployees.id, runEmployeeId),
        eq(payrollRunEmployees.runId, runId),
        eq(payrollRunEmployees.orgId, orgId),
      ))
      .limit(1);

    const emp = empCheck[0];
    if (!emp) return { ok: false, reason: "not_found" };

    const amountPaise = toPaise(body.amount);
    const amountStr = fromPaise(amountPaise);
    const isEarning = body.type === "EARNING";

    await this.db.transaction(async (tx) => {
      await tx.insert(payrollLineItems).values({
        orgId,
        runId,
        runEmployeeId,
        code: `ADJ-${body.type}`,
        name: body.name,
        category: body.type,
        amount: amountStr,
        calcMethod: "MANUAL",
        calcExplain: { note: body.note },
        taxable: false,
        sortOrder: 999,
      });

      const currentGrossPaise = toPaise(emp.gross);
      const currentDeductionsPaise = toPaise(emp.totalDeductions);
      const currentNetPaise = toPaise(emp.net);

      const newGrossPaise = isEarning ? currentGrossPaise + amountPaise : currentGrossPaise;
      const newDeductionsPaise = isEarning ? currentDeductionsPaise : currentDeductionsPaise + amountPaise;
      const newNetPaise = isEarning ? currentNetPaise + amountPaise : currentNetPaise - amountPaise;

      await tx
        .update(payrollRunEmployees)
        .set({
          gross: fromPaise(newGrossPaise),
          totalDeductions: fromPaise(newDeductionsPaise),
          net: fromPaise(newNetPaise),
        })
        .where(and(eq(payrollRunEmployees.id, runEmployeeId), eq(payrollRunEmployees.orgId, orgId)));
    });

    this.audit.log({
      action: "payroll.adjustment_added",
      userId: actorId,
      orgId,
      targetId: String(runEmployeeId),
      targetType: "payroll_run_employee",
      metadata: { runId, type: body.type, name: body.name, amount: amountStr, note: body.note },
    });

    return { ok: true };
  }

  async listRunEmployees(
    orgId: string,
    runId: number,
    query: ListRunEmployeesQuery,
    scope: DataScope,
    userId: string,
  ): Promise<CursorPage<{
    id: number; userId: string | null; workerType: string; currency: string;
    gross: string; totalDeductions: string; net: string; status: string;
    holdReason: string | null; userName: string | null; userEmail: string;
  }> | null> {
    const runCheck = await this.db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!runCheck[0]) return null;

    const pageLimit = Math.min(query.limit, 100);
    const pos = decodeCursor(query.cursor);
    const scopeCondition = applyScope(scope, orgId, userId, { ownerColumn: payrollRunEmployees.userId });

    const conditions: SQL[] = [
      eq(payrollRunEmployees.orgId, orgId),
      eq(payrollRunEmployees.runId, runId),
      scopeCondition,
    ];

    if (query.status) conditions.push(eq(payrollRunEmployees.status, query.status));
    if (query.workerType) {
      conditions.push(eq(payrollRunEmployees.workerType, query.workerType as "EMPLOYEE" | "CONTRACTOR" | "CONSULTANT" | "INTERN" | "EOR"));
    }

    const searchCondition = query.search
      ? or(ilike(users.name, `%${query.search}%`), ilike(users.email, `%${query.search}%`))
      : undefined;

    if (searchCondition) conditions.push(searchCondition);

    const cursorCondition = pos
      ? or(
          gt(users.name, pos.sortValue),
          and(eq(users.name, pos.sortValue), gt(payrollRunEmployees.id, Number(pos.id))),
        )
      : undefined;

    if (cursorCondition) conditions.push(cursorCondition);

    const rows = await this.db
      .select({
        id: payrollRunEmployees.id,
        userId: payrollRunEmployees.userId,
        workerType: payrollRunEmployees.workerType,
        currency: payrollRunEmployees.currency,
        gross: payrollRunEmployees.gross,
        totalDeductions: payrollRunEmployees.totalDeductions,
        net: payrollRunEmployees.net,
        status: payrollRunEmployees.status,
        holdReason: payrollRunEmployees.holdReason,
        userName: users.name,
        userEmail: users.email,
      })
      .from(payrollRunEmployees)
      .innerJoin(users, eq(users.id, payrollRunEmployees.userId))
      .where(and(...conditions))
      .orderBy(asc(users.name), asc(payrollRunEmployees.id))
      .limit(pageLimit + 1);

    return buildCursorPage(rows, pageLimit, (row) => ({ sortValue: row.userName ?? "", id: String(row.id) }));
  }

  async getRunEmployee(orgId: string, runId: number, runEmployeeId: number) {
    const [emp] = await this.db
      .select({
        id: payrollRunEmployees.id,
        userId: payrollRunEmployees.userId,
        workerType: payrollRunEmployees.workerType,
        currency: payrollRunEmployees.currency,
        gross: payrollRunEmployees.gross,
        totalDeductions: payrollRunEmployees.totalDeductions,
        net: payrollRunEmployees.net,
        status: payrollRunEmployees.status,
        holdReason: payrollRunEmployees.holdReason,
        calculationSnapshot: payrollRunEmployees.calculationSnapshot,
        userName: users.name,
        userEmail: users.email,
      })
      .from(payrollRunEmployees)
      .innerJoin(users, eq(users.id, payrollRunEmployees.userId))
      .where(
        and(
          eq(payrollRunEmployees.id, runEmployeeId),
          eq(payrollRunEmployees.runId, runId),
          eq(payrollRunEmployees.orgId, orgId),
        ),
      )
      .limit(1);

    if (!emp) return null;

    return emp;
  }

  async getPayoutHealth(
    orgId: string,
    runId: number,
    runStatus: string,
  ): Promise<{ failedCount: number; heldCount: number } | null> {
    if (runStatus !== "PAID" && runStatus !== "PAYSLIPS_PUBLISHED" && runStatus !== "CLOSED") return null;

    const rows = await this.db
      .select({ status: payrollBankBatchItems.status, total: count() })
      .from(payrollBankBatchItems)
      .innerJoin(payrollBankBatches, eq(payrollBankBatchItems.batchId, payrollBankBatches.id))
      .where(and(eq(payrollBankBatches.orgId, orgId), eq(payrollBankBatches.runId, runId)))
      .groupBy(payrollBankBatchItems.status);

    const failedCount = rows.find((r) => r.status === "FAILED")?.total ?? 0;
    const heldCount = rows.find((r) => r.status === "HELD")?.total ?? 0;
    if (failedCount === 0 && heldCount === 0) return null;
    return { failedCount, heldCount };
  }
}
