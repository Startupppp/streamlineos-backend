import { BadRequestException, ConflictException, Injectable, Inject } from "@nestjs/common";
import { and, eq, desc, asc, gt, ilike, lt, or, isNull, type SQL } from "drizzle-orm";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../common/pagination/cursor";
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
import type { PayrollChecklistItem, PayrollToggles, VarianceSummary } from "../payroll.types";
import { PAYROLL_LOCKED_STATUSES } from "../payroll.types";
import { toPaise, fromPaise } from "./lib/money";
import { AuditService } from "../../../common/audit/audit.service";
import { PayrollEntitiesService } from "../entities/entities.service";
import { describeCountryPack } from "../../hr/global/lib/country-pack-registry";
import { getIndiaBundleForMonth } from "./lib/statutory-registry";
import { PayrollRunVarianceService } from "./payroll-run-variance.service";

@Injectable()
export class RunsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly entities: PayrollEntitiesService,
    private readonly variance: PayrollRunVarianceService,
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
    const entityId = opts?.entityId ?? null;

    // Resolve legal entity → period + statutory pack (org-scoped ownership).
    let periodId: number | null = null;
    let statutoryRuleVersion: string | null = null;
    if (entityId != null) {
      const entity = await this.entities.getEntity(orgId, entityId);
      const period = await this.entities.ensurePeriod(orgId, month, { entityId });
      periodId = period.id;
      const pack = describeCountryPack(entity.countryCode);
      statutoryRuleVersion =
        entity.countryCode === "IN"
          ? getIndiaBundleForMonth(month).bundleVersion
          : (pack?.payrollStatutoryBundle ?? null);
      // Isolation: statutory bundle country must match entity country when present.
      if (statutoryRuleVersion) {
        const ruleCountry = statutoryRuleVersion.split("-")[0] ?? "";
        if (ruleCountry.length === 2) {
          this.entities.assertNoCountryContamination(entity.countryCode, ruleCountry);
        }
      }
    }

    // Source run must be same org and same entity scope (when both sides are entity-bound).
    if (opts?.sourceRunId != null) {
      const source = await this.db
        .select({
          id: payrollRuns.id,
          entityId: payrollRuns.entityId,
        })
        .from(payrollRuns)
        .where(and(eq(payrollRuns.id, opts.sourceRunId), eq(payrollRuns.orgId, orgId)))
        .limit(1);
      if (!source[0]) {
        throw new BadRequestException("Source payroll run not found in this organization");
      }
      if (
        entityId != null &&
        source[0].entityId != null &&
        source[0].entityId !== entityId
      ) {
        throw new BadRequestException(
          `Source run belongs to entity ${source[0].entityId}, not entity ${entityId}`,
        );
      }
    }

    // Uniqueness: (org, month, runType, entity) — NULL entity is org-level bucket (migration 0298).
    const existingWhere =
      entityId != null
        ? and(
            eq(payrollRuns.orgId, orgId),
            eq(payrollRuns.month, month),
            eq(payrollRuns.runType, runType),
            eq(payrollRuns.entityId, entityId),
          )
        : and(
            eq(payrollRuns.orgId, orgId),
            eq(payrollRuns.month, month),
            eq(payrollRuns.runType, runType),
            isNull(payrollRuns.entityId),
          );

    const existing = await this.db
      .select({ id: payrollRuns.id, entityId: payrollRuns.entityId })
      .from(payrollRuns)
      .where(existingWhere)
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
        entityId,
        periodId,
        statutoryRuleVersion,
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

  async listRuns(orgId: string, query: ListRunsQuery): Promise<CursorPage<{
    id: number; month: string; status: string; runType: string; entityId: number | null;
    statutoryRuleVersion: string | null; grossTotal: string | null; netTotal: string | null;
    employeeCount: number | null; exceptionCount: number | null; createdAt: Date;
  }>> {
    const pageLimit = Math.min(query.limit, 100);
    const pos = decodeCursor(query.cursor);
    const conditions: SQL[] = [eq(payrollRuns.orgId, orgId)];
    if (query.entityId != null) conditions.push(eq(payrollRuns.entityId, query.entityId));
    const cursorCondition = pos
      ? or(
          lt(payrollRuns.month, pos.sortValue),
          and(eq(payrollRuns.month, pos.sortValue), lt(payrollRuns.id, Number(pos.id))),
        )
      : undefined;
    if (cursorCondition) conditions.push(cursorCondition);
    const rows = await this.db
      .select({
        id: payrollRuns.id,
        month: payrollRuns.month,
        status: payrollRuns.status,
        runType: payrollRuns.runType,
        entityId: payrollRuns.entityId,
        statutoryRuleVersion: payrollRuns.statutoryRuleVersion,
        grossTotal: payrollRuns.grossTotal,
        netTotal: payrollRuns.netTotal,
        employeeCount: payrollRuns.employeeCount,
        exceptionCount: payrollRuns.exceptionCount,
        createdAt: payrollRuns.createdAt,
      })
      .from(payrollRuns)
      .where(and(...conditions))
      .orderBy(desc(payrollRuns.month), desc(payrollRuns.id))
      .limit(pageLimit + 1);
    return buildCursorPage(rows, pageLimit, (row) => ({ sortValue: row.month, id: String(row.id) }));
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
      this.variance.buildSummary(orgId, run[0].id, run[0].month, run[0].netTotal),
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

  async listRunEmployees(
    orgId: string,
    runId: number,
    query: ListRunEmployeesQuery,
    scope: DataScope,
    userId: string,
  ): Promise<CursorPage<{
    id: number; userId: string; workerType: string; currency: string;
    gross: string; totalDeductions: string; net: string; status: string;
    holdReason: string | null; userName: string | null; userEmail: string | null;
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

  async getVariance(orgId: string, runId: number) {
    return this.variance.getVariance(orgId, runId);
  }

  async buildVarianceSummary(
    orgId: string,
    runId: number,
    currentMonth: string,
    currentNetTotal: string | null,
  ): Promise<VarianceSummary | null> {
    return this.variance.buildSummary(orgId, runId, currentMonth, currentNetTotal);
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
