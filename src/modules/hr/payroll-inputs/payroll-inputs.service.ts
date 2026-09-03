import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import {
  keysetBeforeId,
  keysetBeforeValue,
} from "../../../common/pagination/keyset";
import { logger } from "../../../common/logger/logger.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrPayrollInputPeriods, hrPayrollInputSnapshots, hrPayrollAdjustments } from "../../../db/schema/payroll/input-capture";
import { hrLeaveLedger } from "../../../db/schema/hr/leave-ledger";
import { hrLoanRepayments } from "../../../db/schema/hr/benefits";
import { users } from "../../../db/schema/common/auth";
import { HrAuditService } from "../core/hr-audit.service";
import { HrAutomationEngineService } from "../automations/hr-automation-engine.service";
import { PayrollInputsBuildService } from "./payroll-inputs-build.service";
import { PayrollInputSnapshotsService } from "./payroll-input-snapshots.service";
import type {
  CreatePeriodInput,
  ListPeriodsInput,
  SectionQueryInput,
  CreateAdjustmentInput,
} from "./dto/payroll-inputs.schemas";
import { isUniqueViolation } from "../../../common/db/postgres-error";

function periodBoundsFrom(periodKey: string): { start: string; end: string } {
  const [year, month] = periodKey.split("-");
  const lastDay = new Date(Number(year), Number(month), 0).getDate();
  return {
    start: `${periodKey}-01`,
    end: `${periodKey}-${String(lastDay).padStart(2, "0")}`,
  };
}

@Injectable()
export class PayrollInputsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly buildService: PayrollInputsBuildService,
    private readonly snapshots: PayrollInputSnapshotsService,
  ) {}

  async listPeriods(orgId: string, input: ListPeriodsInput) {
    const { cursor, limit, status } = input;
    const position = decodeCursor(cursor);
    if (cursor !== undefined && !position) {
      throw new BadRequestException("Invalid pagination cursor");
    }

    const conditions = [eq(hrPayrollInputPeriods.orgId, orgId)];
    if (status) conditions.push(eq(hrPayrollInputPeriods.status, status));
    if (position) {
      conditions.push(
        keysetBeforeValue(
          hrPayrollInputPeriods.periodKey,
          hrPayrollInputPeriods.id,
          position,
        ),
      );
    }

    const rows = await this.db
      .select()
      .from(hrPayrollInputPeriods)
      .where(and(...conditions))
      .orderBy(desc(hrPayrollInputPeriods.periodKey), desc(hrPayrollInputPeriods.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (period) => ({
      sortValue: period.periodKey,
      id: String(period.id),
    }));
  }

  async createPeriod(orgId: string, actorId: string, input: CreatePeriodInput) {
    try {
      const [period] = await this.db
        .insert(hrPayrollInputPeriods)
        .values({
          orgId,
          periodKey: input.periodKey,
          cutoffDate: input.cutoffDate ?? null,
          createdBy: actorId,
        })
        .returning();

      await this.audit.log({
        orgId,
        actorId,
        entityType: "hr_payroll_input_period",
        entityId: String(period!.id),
        action: "period.created",
        after: { periodKey: input.periodKey },
      });

      return period;
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Period ${input.periodKey} already exists for this organisation`);
      }
      throw err;
    }
  }

  async getPeriod(orgId: string, periodId: number) {
    const period = await this.db.query.hrPayrollInputPeriods.findFirst({
      where: and(
        eq(hrPayrollInputPeriods.id, periodId),
        eq(hrPayrollInputPeriods.orgId, orgId),
      ),
    });
    if (!period) throw new NotFoundException("Period not found");
    return period;
  }

  async buildPeriod(orgId: string, actorId: string, periodId: number) {
    const period = await this.getPeriod(orgId, periodId);
    if (period.status === "locked") {
      throw new ForbiddenException("Cannot rebuild a locked period");
    }

    await this.db
      .update(hrPayrollInputPeriods)
      .set({ status: "building", updatedAt: new Date() })
      .where(and(eq(hrPayrollInputPeriods.id, periodId), eq(hrPayrollInputPeriods.orgId, orgId)));

    try {
      const updatedPeriod = { ...period, status: "building" as const };
      await this.buildService.buildSnapshots(orgId, updatedPeriod);

      const [built] = await this.db
        .update(hrPayrollInputPeriods)
        .set({ status: "built", builtAt: new Date(), updatedAt: new Date() })
        .where(and(eq(hrPayrollInputPeriods.id, periodId), eq(hrPayrollInputPeriods.orgId, orgId)))
        .returning();

      await this.audit.log({
        orgId,
        actorId,
        entityType: "hr_payroll_input_period",
        entityId: String(periodId),
        action: "period.built",
        after: { status: "built" },
      });

      return built;
    } catch (err) {
      try {
        await this.db
          .update(hrPayrollInputPeriods)
          .set({ status: "open", updatedAt: new Date() })
          .where(and(eq(hrPayrollInputPeriods.id, periodId), eq(hrPayrollInputPeriods.orgId, orgId)));
      } catch (compensation) {
        logger.error("Could not reopen a payroll input period after a failed build", {
          orgId,
          periodId,
          error: compensation instanceof Error ? compensation.message : String(compensation),
        });
      }
      throw err;
    }
  }

  async lockPeriod(orgId: string, actorId: string, periodId: number) {
    const period = await this.getPeriod(orgId, periodId);
    if (period.status !== "built") {
      throw new BadRequestException("Period must be in 'built' status before locking");
    }

    const freezeSummary = await this.snapshots.buildFreezeSummary(orgId, periodId);

    const [locked] = await this.db.transaction(async (tx) => {
      const result = await tx
        .update(hrPayrollInputPeriods)
        .set({ status: "locked", lockedAt: new Date(), lockedBy: actorId, updatedAt: new Date() })
        .where(and(eq(hrPayrollInputPeriods.id, periodId), eq(hrPayrollInputPeriods.orgId, orgId)))
        .returning();

      const { start, end } = periodBoundsFrom(period.periodKey);
      await tx
        .update(hrLeaveLedger)
        .set({ payrollStatus: "locked" })
        .where(
          and(
            eq(hrLeaveLedger.orgId, orgId),
            eq(hrLeaveLedger.payrollStatus, "pending"),
            gte(hrLeaveLedger.effectiveDate, start),
            lte(hrLeaveLedger.effectiveDate, end),
          ),
        )
        .catch(() => undefined);

      const dueRepaymentIds = await tx
        .select({ id: hrLoanRepayments.id })
        .from(hrLoanRepayments)
        .where(
          and(
            eq(hrLoanRepayments.orgId, orgId),
            eq(hrLoanRepayments.status, "pending"),
            gte(hrLoanRepayments.dueDate, start),
            lte(hrLoanRepayments.dueDate, end),
          ),
        )
        .limit(1000);

      if (dueRepaymentIds.length > 0) {
        await tx
          .update(hrLoanRepayments)
          .set({ status: "deducted", payrollPeriodKey: period.periodKey, updatedAt: new Date() })
          .where(inArray(hrLoanRepayments.id, dueRepaymentIds.map((r) => r.id)))
          .catch(() => undefined);
      }

      return result;
    });

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_payroll_input_period",
      entityId: String(periodId),
      action: "period.locked",
      after: { status: "locked", freeze: freezeSummary },
    });

    void this.hrAutomation.emit(orgId, "payroll.inputs_locked", {
      periodKey: period.periodKey,
      periodId,
      lockedBy: actorId,
      freeze: freezeSummary,
    });

    return {
      ...locked,
      freeze: freezeSummary,
      immutable: true,
      contract: "attendance_leave_overtime_compensation_snapshots_frozen",
    };
  }

  /**
   * Rebuild any non-locked period that covers the given calendar month (YYYY-MM).
   * Used when attendance/leave source data changes after build.
   */
  async rebuildOpenPeriodForMonth(
    orgId: string,
    actorId: string,
    monthKey: string,
  ): Promise<{ rebuilt: boolean; periodId: number | null; status: string | null }> {
    const period = await this.db.query.hrPayrollInputPeriods.findFirst({
      where: and(
        eq(hrPayrollInputPeriods.orgId, orgId),
        eq(hrPayrollInputPeriods.periodKey, monthKey),
      ),
    });

    if (!period) {
      return { rebuilt: false, periodId: null, status: null };
    }
    if (period.status === "locked") {
      return { rebuilt: false, periodId: period.id, status: "locked" };
    }
    if (period.status === "building") {
      return { rebuilt: false, periodId: period.id, status: "building" };
    }

    await this.buildPeriod(orgId, actorId, period.id);
    return { rebuilt: true, periodId: period.id, status: "built" };
  }

  async unlockPeriod(orgId: string, actorId: string, periodId: number) {
    const period = await this.getPeriod(orgId, periodId);
    if (period.status !== "locked") {
      throw new BadRequestException("Period is not locked");
    }

    const { start, end } = periodBoundsFrom(period.periodKey);

    const [unlocked] = await this.db.transaction(async (tx) => {
      const result = await tx
        .update(hrPayrollInputPeriods)
        .set({ status: "built", lockedAt: null, lockedBy: null, updatedAt: new Date() })
        .where(and(eq(hrPayrollInputPeriods.id, periodId), eq(hrPayrollInputPeriods.orgId, orgId)))
        .returning();

      await tx
        .update(hrLeaveLedger)
        .set({ payrollStatus: "pending" })
        .where(
          and(
            eq(hrLeaveLedger.orgId, orgId),
            eq(hrLeaveLedger.payrollStatus, "locked"),
            gte(hrLeaveLedger.effectiveDate, start),
            lte(hrLeaveLedger.effectiveDate, end),
          ),
        )
        .catch(() => undefined);

      return result;
    });

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_payroll_input_period",
      entityId: String(periodId),
      action: "period.unlocked",
      before: { status: "locked" },
      after: { status: "built" },
    });

    return unlocked;
  }

  async getSectionSnapshot(
    orgId: string,
    periodId: number,
    section: typeof hrPayrollInputSnapshots.$inferSelect["section"],
    input: SectionQueryInput,
  ) {
    await this.getPeriod(orgId, periodId);
    return this.snapshots.listSectionSnapshot(orgId, periodId, section, input);
  }

  async listAdjustments(orgId: string, periodId: number, input: SectionQueryInput) {
    await this.getPeriod(orgId, periodId);
    const { cursor, limit } = input;
    const position = decodeCursor(cursor);
    if (cursor !== undefined && !position) {
      throw new BadRequestException("Invalid pagination cursor");
    }

    const conditions = [
      eq(hrPayrollAdjustments.orgId, orgId),
      eq(hrPayrollAdjustments.periodId, periodId),
    ];
    if (position) {
      conditions.push(
        keysetBeforeId(
          hrPayrollAdjustments.createdAt,
          hrPayrollAdjustments.id,
          position,
        ),
      );
    }

    const rows = await this.db
      .select({
        id: hrPayrollAdjustments.id,
        userId: hrPayrollAdjustments.userId,
        adjustmentType: hrPayrollAdjustments.adjustmentType,
        section: hrPayrollAdjustments.section,
        amountCents: hrPayrollAdjustments.amountCents,
        days: hrPayrollAdjustments.days,
        reason: hrPayrollAdjustments.reason,
        status: hrPayrollAdjustments.status,
        createdAt: hrPayrollAdjustments.createdAt,
        userName: users.name,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userEmail: users.email,
      })
      .from(hrPayrollAdjustments)
      .innerJoin(users, eq(users.id, hrPayrollAdjustments.userId))
      .where(and(...conditions))
      .orderBy(desc(hrPayrollAdjustments.createdAt), desc(hrPayrollAdjustments.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (adjustment) => ({
      sortValue: adjustment.createdAt.toISOString(),
      id: String(adjustment.id),
    }));
  }

  async createAdjustment(orgId: string, actorId: string, input: CreateAdjustmentInput) {
    if (input.periodId) {
      const period = await this.getPeriod(orgId, input.periodId);
      if (period.status === "locked") {
        const nextPeriodKey = this.nextMonthKey(period.periodKey);
        const nextPeriod = await this.db.query.hrPayrollInputPeriods.findFirst({
          where: and(
            eq(hrPayrollInputPeriods.orgId, orgId),
            eq(hrPayrollInputPeriods.periodKey, nextPeriodKey),
          ),
        });
        const targetPeriodId = nextPeriod?.id ?? null;
        return this.insertAdjustment(orgId, actorId, { ...input, periodId: targetPeriodId ?? undefined });
      }
    }

    return this.insertAdjustment(orgId, actorId, input);
  }

  private async insertAdjustment(orgId: string, actorId: string, input: CreateAdjustmentInput) {
    const [adj] = await this.db
      .insert(hrPayrollAdjustments)
      .values({
        orgId,
        periodId: input.periodId ?? null,
        userId: input.userId,
        adjustmentType: input.adjustmentType,
        section: input.section,
        amountCents: input.amountCents ?? null,
        days: input.days ? String(input.days) : null,
        reason: input.reason,
        sourceChangeRef: (input.sourceChangeRef ?? null) as Record<string, unknown> | null,
        createdBy: actorId,
        status: "pending",
      })
      .returning();

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_payroll_adjustment",
      entityId: String(adj!.id),
      action: "adjustment.created",
      after: input,
    });

    return adj;
  }

  async approveAdjustment(orgId: string, actorId: string, adjustmentId: number) {
    const adj = await this.db.query.hrPayrollAdjustments.findFirst({
      where: and(
        eq(hrPayrollAdjustments.id, adjustmentId),
        eq(hrPayrollAdjustments.orgId, orgId),
      ),
    });

    if (!adj) throw new NotFoundException("Adjustment not found");
    if (adj.status !== "pending") throw new BadRequestException("Adjustment is not in pending status");

    const [updated] = await this.db
      .update(hrPayrollAdjustments)
      .set({ status: "approved", approvedBy: actorId, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(hrPayrollAdjustments.id, adjustmentId), eq(hrPayrollAdjustments.orgId, orgId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_payroll_adjustment",
      entityId: String(adjustmentId),
      action: "adjustment.approved",
      before: { status: "pending" },
      after: { status: "approved" },
    });

    return updated;
  }

  async rejectAdjustment(orgId: string, actorId: string, adjustmentId: number, reason: string) {
    const adj = await this.db.query.hrPayrollAdjustments.findFirst({
      where: and(
        eq(hrPayrollAdjustments.id, adjustmentId),
        eq(hrPayrollAdjustments.orgId, orgId),
      ),
    });

    if (!adj) throw new NotFoundException("Adjustment not found");
    if (adj.status !== "pending") throw new BadRequestException("Adjustment is not in pending status");

    const [updated] = await this.db
      .update(hrPayrollAdjustments)
      .set({
        status: "rejected",
        rejectedBy: actorId,
        rejectedAt: new Date(),
        rejectionReason: reason,
        updatedAt: new Date(),
      })
      .where(and(eq(hrPayrollAdjustments.id, adjustmentId), eq(hrPayrollAdjustments.orgId, orgId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_payroll_adjustment",
      entityId: String(adjustmentId),
      action: "adjustment.rejected",
      before: { status: "pending" },
      after: { status: "rejected", reason },
    });

    return updated;
  }

  private nextMonthKey(periodKey: string): string {
    const [year, month] = periodKey.split("-").map(Number);
    const next = new Date(year!, (month ?? 1), 1);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  }
}
