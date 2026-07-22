import { Injectable, Inject } from "@nestjs/common";
import { and, eq, desc, ilike, or, count, lt, sql, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  payrollRuns,
  payrollRunEmployees,
  payrollLineItems,
  payrollPolicies,
  payrollPolicyVersions,
  payrollBankBatches,
  payrollBankBatchItems,
} from "../../../db/schema";
import { users } from "../../../db/schema";
import type { DataScope } from "../../access/access.types";
import { applyScope } from "../../access/apply-scope";
import { buildRunChecklist } from "./lib/checklist";
import type { ListRunsQuery, ListRunEmployeesQuery, AddRunAdjustmentInput } from "./dto/runs.schemas";
import type { PayrollChecklistItem, PayrollToggles, PayrollPolicyConfig, VarianceSummary } from "../payroll.types";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { toPaise, fromPaise } from "./lib/money";
import { AuditService } from "../../../common/audit/audit.service";

@Injectable()
export class RunsService {
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

  async createRun(
    orgId: string,
    userId: string,
    month: string,
    opts?: {
      runType?: string;
      sourcePeriodKey?: string | null;
      sourceRunId?: number | null;
      entityId?: number | null;
    },
  ): Promise<{ ok: false; reason: "exists" } | { ok: true; runId: number }> {
    const runType = opts?.runType ?? "REGULAR";

    const existing = await this.db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.orgId, orgId),
          eq(payrollRuns.month, month),
          eq(payrollRuns.runType, runType),
        ),
      )
      .limit(1);

    if (existing.length > 0) return { ok: false, reason: "exists" };

    const policyVersion = await this.db
      .select({ id: payrollPolicyVersions.id })
      .from(payrollPolicies)
      .innerJoin(
        payrollPolicyVersions,
        and(
          eq(payrollPolicyVersions.policyId, payrollPolicies.id),
          eq(payrollPolicyVersions.status, "ACTIVE"),
        ),
      )
      .where(eq(payrollPolicies.orgId, orgId))
      .limit(1);

    const policyVersionId = policyVersion[0]?.id ?? null;

    const inserted = await this.db
      .insert(payrollRuns)
      .values({
        orgId,
        month,
        runType,
        sourcePeriodKey: opts?.sourcePeriodKey ?? null,
        sourceRunId: opts?.sourceRunId ?? null,
        entityId: opts?.entityId ?? null,
        calculationVersion: "1.0.0",
        status: "PREPARING",
        policyVersionId,
        createdBy: userId,
      })
      .returning({ id: payrollRuns.id });

    const runId = inserted[0]?.id;
    if (!runId) return { ok: false, reason: "exists" };

    return { ok: true, runId };
  }

  async listRuns(orgId: string, query: ListRunsQuery) {
    const offset = (query.page - 1) * query.limit;

    const [rows, [totRow]] = await Promise.all([
      this.db
        .select({
          id: payrollRuns.id,
          month: payrollRuns.month,
          status: payrollRuns.status,
          grossTotal: payrollRuns.grossTotal,
          netTotal: payrollRuns.netTotal,
          employeeCount: payrollRuns.employeeCount,
          exceptionCount: payrollRuns.exceptionCount,
          createdAt: payrollRuns.createdAt,
        })
        .from(payrollRuns)
        .where(eq(payrollRuns.orgId, orgId))
        .orderBy(desc(payrollRuns.month))
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(payrollRuns)
        .where(eq(payrollRuns.orgId, orgId)),
    ]);

    return { data: rows, total: totRow?.total ?? 0, page: query.page, limit: query.limit };
  }

  async getRunById(
    orgId: string,
    runId: number,
  ): Promise<{
    run: typeof payrollRuns.$inferSelect;
    checklist: PayrollChecklistItem[];
    varianceSummary: VarianceSummary | null;
    payoutHealth: { failedCount: number; heldCount: number } | null;
  } | null> {
    const run = await this.db
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!run[0]) return null;

    const [toggles, varianceSummary, payoutHealth] = await Promise.all([
      this.getTogglesForRun(orgId, run[0].policyVersionId),
      this.buildVarianceSummary(orgId, run[0].id, run[0].month, run[0].netTotal),
      this.getPayoutHealth(orgId, run[0].id, run[0].status),
    ]);

    const checklist = await buildRunChecklist(this.db, orgId, run[0], toggles);

    return { run: run[0], checklist, varianceSummary, payoutHealth };
  }

  /**
   * A run auto-flips to PAID once every batch item reaches a terminal state (paid, failed, or
   * held) — so "run is PAID" does not mean everyone was actually paid. Surfaces the failed/held
   * count so the UI can warn rather than let a misleadingly-green PAID badge hide the gap.
   */
  private async getPayoutHealth(
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

  async getCurrentRun(orgId: string) {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    // "Current run" is the month's canonical REGULAR run; off-cycle/bonus/
    // correction runs share the month and must not be returned here.
    const rows = await this.db
      .select()
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.orgId, orgId),
          eq(payrollRuns.month, currentMonth),
          eq(payrollRuns.runType, "REGULAR"),
        ),
      )
      .limit(1);

    if (rows[0]) return rows[0];

    const recent = await this.db
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.orgId, orgId), eq(payrollRuns.runType, "REGULAR")))
      .orderBy(desc(payrollRuns.month))
      .limit(1);

    return recent[0] ?? null;
  }

  async listRunEmployees(
    orgId: string,
    runId: number,
    query: ListRunEmployeesQuery,
    scope: DataScope,
    userId: string,
  ) {
    const runCheck = await this.db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!runCheck[0]) return null;

    const offset = (query.page - 1) * query.limit;
    const scopeCondition = applyScope(scope, userId, { ownerColumn: payrollRunEmployees.userId });

    const conditions = [
      eq(payrollRunEmployees.orgId, orgId),
      eq(payrollRunEmployees.runId, runId),
      scopeCondition,
    ];

    if (query.status) conditions.push(eq(payrollRunEmployees.status, query.status));
    if (query.workerType) conditions.push(eq(payrollRunEmployees.workerType, query.workerType as "EMPLOYEE" | "CONTRACTOR" | "CONSULTANT" | "INTERN" | "EOR"));

    const searchConditions = query.search
      ? or(
          ilike(users.name, `%${query.search}%`),
          ilike(users.email, `%${query.search}%`),
        )
      : undefined;

    const finalConditions = searchConditions ? [...conditions, searchConditions] : conditions;

    const [rows, [totRow]] = await Promise.all([
      this.db
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
        .where(and(...finalConditions))
        .orderBy(users.name)
        .limit(query.limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(payrollRunEmployees)
        .innerJoin(users, eq(users.id, payrollRunEmployees.userId))
        .where(and(...finalConditions)),
    ]);

    return { data: rows, total: totRow?.total ?? 0, page: query.page, limit: query.limit };
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

  async getVariance(orgId: string, runId: number) {
    const run = await this.db
      .select({ id: payrollRuns.id, month: payrollRuns.month, grossTotal: payrollRuns.grossTotal, netTotal: payrollRuns.netTotal })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.orgId, orgId)))
      .limit(1);

    if (!run[0]) return null;

    const prevRun = await this.db
      .select({ id: payrollRuns.id, month: payrollRuns.month, grossTotal: payrollRuns.grossTotal, netTotal: payrollRuns.netTotal })
      .from(payrollRuns)
      .where(and(
        eq(payrollRuns.orgId, orgId),
        sql`${payrollRuns.month} < ${run[0].month}`,
        inArray(payrollRuns.status, [...PAYROLL_LOCKED_STATUSES]),
      ))
      .orderBy(desc(payrollRuns.month))
      .limit(1);

    const topMovers = await this.db
      .select({
        userId: payrollRunEmployees.userId,
        net: payrollRunEmployees.net,
        userName: users.name,
      })
      .from(payrollRunEmployees)
      .innerJoin(users, eq(users.id, payrollRunEmployees.userId))
      .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId)))
      .orderBy(desc(payrollRunEmployees.net))
      .limit(10);

    return {
      currentRun: run[0],
      previousRun: prevRun[0] ?? null,
      topMovers,
    };
  }

  async buildVarianceSummary(
    orgId: string,
    runId: number,
    currentMonth: string,
    currentNetTotal: string | null,
  ): Promise<VarianceSummary | null> {
    const [[prevRun], currentEmps] = await Promise.all([
      this.db
        .select({ id: payrollRuns.id, month: payrollRuns.month, netTotal: payrollRuns.netTotal })
        .from(payrollRuns)
        .where(and(
          eq(payrollRuns.orgId, orgId),
          lt(payrollRuns.month, currentMonth),
          inArray(payrollRuns.status, [...PAYROLL_LOCKED_STATUSES]),
        ))
        .orderBy(desc(payrollRuns.month))
        .limit(1),
      this.db
        .select({ userId: payrollRunEmployees.userId, net: payrollRunEmployees.net })
        .from(payrollRunEmployees)
        .where(and(eq(payrollRunEmployees.runId, runId), eq(payrollRunEmployees.orgId, orgId))),
    ]);

    if (!prevRun) return null;

    const prevEmps = await this.db
      .select({ userId: payrollRunEmployees.userId, net: payrollRunEmployees.net })
      .from(payrollRunEmployees)
      .where(and(eq(payrollRunEmployees.runId, prevRun.id), eq(payrollRunEmployees.orgId, orgId)));

    const currentUserIds = new Set(currentEmps.map(e => e.userId));
    const prevNetMap = new Map(prevEmps.map(e => [e.userId, e.net]));

    const newJoiners = currentEmps.filter(e => !prevNetMap.has(e.userId)).length;
    const exited = prevEmps.filter(e => !currentUserIds.has(e.userId)).length;
    const changedEmployees = currentEmps.filter(e => {
      const prevNet = prevNetMap.get(e.userId);
      return prevNet != null && prevNet !== e.net;
    }).length;

    const currentNetPaise = toPaise(currentNetTotal ?? "0");
    const prevNetPaise = toPaise(prevRun.netTotal ?? "0");
    const netDeltaPaise = currentNetPaise - prevNetPaise;
    const netDeltaPercent = prevNetPaise !== 0 ? (netDeltaPaise / prevNetPaise) * 100 : 0;

    return {
      previousMonth: prevRun.month,
      currentNet: (currentNetPaise / 100).toFixed(2),
      previousNet: (prevNetPaise / 100).toFixed(2),
      netDelta: fromPaise(netDeltaPaise),
      netDeltaPercent: Math.round(netDeltaPercent * 100) / 100,
      newJoiners,
      exited,
      changedEmployees,
    };
  }

  private async getTogglesForRun(orgId: string, policyVersionId: number | null): Promise<PayrollToggles | null> {
    if (!policyVersionId) return null;

    const version = await this.db
      .select({ toggles: payrollPolicyVersions.toggles, config: payrollPolicyVersions.config })
      .from(payrollPolicyVersions)
      .where(and(eq(payrollPolicyVersions.id, policyVersionId), eq(payrollPolicyVersions.orgId, orgId)))
      .limit(1);

    return (version[0]?.toggles as PayrollToggles) ?? null;
  }
}
