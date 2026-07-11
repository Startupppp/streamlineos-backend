import { Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { compOffBalances, hrLeaveLedger, leaveTypes, overtimeRequests } from "../../db/schema";
import { eq, and, desc } from "drizzle-orm";
import { HrPolicyEvaluationService } from "../hr-policies/hr-policy-evaluation.service";
import { HrWorkflowEngineService } from "../hr-workflows/hr-workflow-engine.service";

const DEFAULT_STANDARD_DAY_HOURS = 8;

@Injectable()
export class OvertimeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() private readonly policyEval: HrPolicyEvaluationService,
    @Optional() private readonly workflowEngine: HrWorkflowEngineService,
  ) {}

  async listRequests(orgId: string) {
    return this.db
      .select()
      .from(overtimeRequests)
      .where(eq(overtimeRequests.orgId, orgId))
      .orderBy(desc(overtimeRequests.createdAt))
      .limit(100);
  }

  async createRequest(
    orgId: string,
    userId: string,
    data: { date: string; hours: string; reason?: string; convertToCompOff?: boolean },
  ) {
    const [req] = await this.db
      .insert(overtimeRequests)
      .values({ orgId, userId, ...data })
      .returning();

    void this.startOvertimeWorkflow(orgId, userId, req?.id);

    return req;
  }

  async approveRequest(orgId: string, id: number, approverId: string) {
    const [req] = await this.db
      .update(overtimeRequests)
      .set({ status: "APPROVED", approverId, updatedAt: new Date() })
      .where(and(eq(overtimeRequests.id, id), eq(overtimeRequests.orgId, orgId)))
      .returning();

    if (!req) throw new NotFoundException("Request not found");

    if (req.convertToCompOff) {
      const standardDayHours = await this.resolveStandardDayHours(orgId, req.userId);
      const earnedDays = (parseFloat(req.hours) / standardDayHours).toFixed(2);

      await this.db.transaction(async (tx) => {
        await tx
          .insert(compOffBalances)
          .values({ orgId, userId: req.userId, earnedDays })
          .onConflictDoNothing();

        const compOffType = await tx.query.leaveTypes.findFirst({
          where: and(eq(leaveTypes.orgId, orgId), eq(leaveTypes.name, "Compensatory Off")),
          columns: { id: true },
        });

        if (compOffType) {
          await tx.insert(hrLeaveLedger).values({
            orgId,
            userId: req.userId,
            leaveTypeId: compOffType.id,
            txnType: "comp_off_earn",
            days: earnedDays,
            effectiveDate: req.date,
            source: "request",
            sourceId: String(id),
            note: `OT approved: ${req.hours}h / ${standardDayHours}h = ${earnedDays} days`,
            payrollStatus: "pending",
            createdBy: approverId,
          });
        }
      });
    }

    return req;
  }

  async rejectRequest(orgId: string, id: number, approverId: string) {
    const [req] = await this.db
      .update(overtimeRequests)
      .set({ status: "REJECTED", approverId, updatedAt: new Date() })
      .where(and(eq(overtimeRequests.id, id), eq(overtimeRequests.orgId, orgId)))
      .returning();

    if (!req) throw new NotFoundException("Request not found");
    return req;
  }

  async getCompOffBalance(orgId: string, userId: string) {
    return this.db
      .select()
      .from(compOffBalances)
      .where(and(eq(compOffBalances.orgId, orgId), eq(compOffBalances.userId, userId)));
  }

  private async resolveStandardDayHours(orgId: string, userId: string): Promise<number> {
    if (!this.policyEval) return DEFAULT_STANDARD_DAY_HOURS;
    try {
      const result = await this.policyEval.evaluatePolicy(
        orgId,
        userId,
        "comp_off",
        new Date().toISOString().slice(0, 10),
      );
      if (!result) return DEFAULT_STANDARD_DAY_HOURS;
      const rules = result.rules as Record<string, unknown>;
      const hours = typeof rules["standardDayHours"] === "number" ? rules["standardDayHours"] : null;
      return hours ?? DEFAULT_STANDARD_DAY_HOURS;
    } catch {
      return DEFAULT_STANDARD_DAY_HOURS;
    }
  }

  private async startOvertimeWorkflow(
    orgId: string,
    userId: string,
    overtimeRequestId?: number,
  ): Promise<void> {
    if (!this.workflowEngine || !overtimeRequestId) return;
    try {
      await this.workflowEngine.startWorkflow({
        orgId,
        objectType: "overtime_request",
        objectId: String(overtimeRequestId),
        requestedByUserId: userId,
        subjectEmployeeId: userId,
        context: { overtimeRequestId },
      });
    } catch {
      return;
    }
  }
}
