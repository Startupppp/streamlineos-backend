import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeValue } from "../../../common/pagination/keyset";
import { logger } from "../../../common/logger/logger.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrPayrollInputPeriods, hrPayrollInputSnapshots } from "../../../db/schema/payroll/input-capture";
import { HrAuditService } from "../core/hr-audit.service";
import { HrAutomationEngineService } from "../automations/hr-automation-engine.service";
import { PayrollInputsBuildService } from "./payroll-inputs-build.service";
import { PayrollInputSnapshotsService } from "./payroll-input-snapshots.service";
import {
  approveAdjustment as runApproveAdjustment,
  insertAdjustment as runInsertAdjustment,
  listAdjustments as runListAdjustments,
  rejectAdjustment as runRejectAdjustment,
  type PayrollAdjustmentDeps,
} from "./payroll-adjustments";
import {
  freezePeriodSourceRecords,
  releasePeriodSourceRecords,
} from "./payroll-input-freeze";
import { nextMonthKey } from "./payroll-period-key";
import type {
  CreatePeriodInput,
  ListPeriodsInput,
  SectionQueryInput,
  CreateAdjustmentInput,
} from "./dto/payroll-inputs.schemas";
import { isUniqueViolation } from "../../../common/db/postgres-error";

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

      await freezePeriodSourceRecords(tx, orgId, period.periodKey);

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

    const [unlocked] = await this.db.transaction(async (tx) => {
      const result = await tx
        .update(hrPayrollInputPeriods)
        .set({ status: "built", lockedAt: null, lockedBy: null, updatedAt: new Date() })
        .where(and(eq(hrPayrollInputPeriods.id, periodId), eq(hrPayrollInputPeriods.orgId, orgId)))
        .returning();

      await releasePeriodSourceRecords(tx, orgId, period.periodKey);

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
    return runListAdjustments(this.adjustmentDeps(), orgId, periodId, input);
  }

  async createAdjustment(orgId: string, actorId: string, input: CreateAdjustmentInput) {
    if (input.periodId) {
      const period = await this.getPeriod(orgId, input.periodId);
      if (period.status === "locked") {
        const nextPeriod = await this.db.query.hrPayrollInputPeriods.findFirst({
          where: and(
            eq(hrPayrollInputPeriods.orgId, orgId),
            eq(hrPayrollInputPeriods.periodKey, nextMonthKey(period.periodKey)),
          ),
        });
        const targetPeriodId = nextPeriod?.id ?? null;
        return runInsertAdjustment(this.adjustmentDeps(), orgId, actorId, {
          ...input,
          periodId: targetPeriodId ?? undefined,
        });
      }
    }

    return runInsertAdjustment(this.adjustmentDeps(), orgId, actorId, input);
  }

  async approveAdjustment(orgId: string, actorId: string, adjustmentId: number) {
    return runApproveAdjustment(this.adjustmentDeps(), orgId, actorId, adjustmentId);
  }

  async rejectAdjustment(orgId: string, actorId: string, adjustmentId: number, reason: string) {
    return runRejectAdjustment(this.adjustmentDeps(), orgId, actorId, adjustmentId, reason);
  }

  private adjustmentDeps(): PayrollAdjustmentDeps {
    return { db: this.db, audit: this.audit };
  }
}
