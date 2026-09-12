import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrPayrollInputPeriods } from "../../../db/schema/payroll/input-capture";
import { HrAuditService } from "../core/hr-audit.service";
import {
  approveAdjustment as runApproveAdjustment,
  insertAdjustment as runInsertAdjustment,
  listAdjustments as runListAdjustments,
  rejectAdjustment as runRejectAdjustment,
  type PayrollAdjustmentDeps,
} from "./payroll-adjustments";
import { nextMonthKey } from "./payroll-period-key";
import { getPeriodById } from "./payroll-input-period-query";
import type { CreateAdjustmentInput, SectionQueryInput } from "./dto/payroll-inputs.schemas";

@Injectable()
export class PayrollInputAdjustmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async listAdjustments(orgId: string, periodId: number, input: SectionQueryInput) {
    await getPeriodById(this.db, orgId, periodId);
    return runListAdjustments(this.adjustmentDeps(), orgId, periodId, input);
  }

  async createAdjustment(orgId: string, actorId: string, input: CreateAdjustmentInput) {
    if (input.periodId) {
      const period = await getPeriodById(this.db, orgId, input.periodId);
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
