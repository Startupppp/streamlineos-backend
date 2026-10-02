import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { compOffBalances, hrLeaveLedger, leaveTypes, overtimeRequests } from "../../../db/schema";
import { eq, and, desc, gte, lt, sql } from "drizzle-orm";
import { HrPolicyEvaluationService } from "../policies/hr-policy-evaluation.service";
import { HrWorkflowEngineService } from "../workflows/hr-workflow-engine.service";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { requireOrganizationMembershipId } from "./organization-membership";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { logSideEffectFailure } from "../../../common/logger/side-effect";

const DEFAULT_STANDARD_DAY_HOURS = 8;

@Injectable()
export class OvertimeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() private readonly policyEval: HrPolicyEvaluationService,
    @Optional() private readonly workflowEngine: HrWorkflowEngineService,
  ) {}

  async listRequests(
    orgId: string,
    params: { cursor?: string; pageSize?: number; month?: string } = {},
  ) {
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const position = decodeCursor(params.cursor);
    const conditions = [eq(overtimeRequests.orgId, orgId)];
    if (position) {
      conditions.push(keysetBeforeId(overtimeRequests.createdAt, overtimeRequests.id, position));
    }
    if (params.month) {
      const [year, month] = params.month.split("-").map(Number);
      const nextMonth = month === 12
        ? `${year + 1}-01`
        : `${year}-${String(month + 1).padStart(2, "0")}`;
      conditions.push(
        gte(overtimeRequests.date, `${params.month}-01`),
        lt(overtimeRequests.date, `${nextMonth}-01`),
      );
    }
    const where = and(...conditions);
    const rows = await this.db
      .select()
      .from(overtimeRequests)
      .where(where)
      .orderBy(desc(overtimeRequests.createdAt), desc(overtimeRequests.id))
      .limit(pageSize + 1);
    const page = buildCursorPage(rows, pageSize, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
    return {
      items: page.data,
      pagination: page.pagination,
    };
  }

  async createRequest(
    orgId: string,
    userId: string,
    data: { date: string; hours: string; reason?: string; convertToCompOff?: boolean },
  ) {
    const userMembershipId = await requireOrganizationMembershipId(this.db, orgId, userId);
    const duplicate = await this.db.query.overtimeRequests.findFirst({
      where: and(
        eq(overtimeRequests.orgId, orgId),
        eq(overtimeRequests.userMembershipId, userMembershipId),
        eq(overtimeRequests.date, data.date),
        sql`${overtimeRequests.status} != 'REJECTED'`,
      ),
      columns: { id: true },
    });
    if (duplicate) {
      throw new ConflictException("An overtime request already exists for this date.");
    }

    const [req] = await this.db
      .insert(overtimeRequests)
      .values({ orgId, userId, userMembershipId, ...data })
      .returning();

    this.scheduleOvertimeWorkflow(orgId, userId, req?.id);

    return req;
  }

  async approveRequest(orgId: string, id: number, approverId: string) {
    const approverMembershipId = await requireOrganizationMembershipId(this.db, orgId, approverId);
    const existing = await this.db.query.overtimeRequests.findFirst({
      where: and(eq(overtimeRequests.id, id), eq(overtimeRequests.orgId, orgId)),
      columns: { userMembershipId: true },
    });
    if (!existing) throw new NotFoundException("Request not found");
    if (existing.userMembershipId === approverMembershipId) {
      throw new ForbiddenException("You cannot approve your own overtime request.");
    }

    const [req] = await this.db
      .update(overtimeRequests)
      .set({ status: "APPROVED", approverId, approverMembershipId, updatedAt: new Date() })
      .where(and(eq(overtimeRequests.id, id), eq(overtimeRequests.orgId, orgId)))
      .returning();

    if (!req) throw new NotFoundException("Request not found");

    if (req.convertToCompOff) {
      const standardDayHours = await this.resolveStandardDayHours(orgId, req.userId);
      const earnedDays = (parseFloat(req.hours) / standardDayHours).toFixed(2);

      await this.db.transaction(async (tx) => {
        await tx
          .insert(compOffBalances)
          .values({ orgId, userId: req.userId, userMembershipId: req.userMembershipId, earnedDays })
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
    const approverMembershipId = await requireOrganizationMembershipId(this.db, orgId, approverId);
    const [req] = await this.db
      .update(overtimeRequests)
      .set({ status: "REJECTED", approverId, approverMembershipId, updatedAt: new Date() })
      .where(and(eq(overtimeRequests.id, id), eq(overtimeRequests.orgId, orgId)))
      .returning();

    if (!req) throw new NotFoundException("Request not found");
    return req;
  }

  async getCompOffBalance(orgId: string, userId: string) {
    const userMembershipId = await requireOrganizationMembershipId(this.db, orgId, userId);
    return this.db
      .select()
      .from(compOffBalances)
      .where(and(eq(compOffBalances.orgId, orgId), eq(compOffBalances.userMembershipId, userMembershipId)))
      .limit(100);
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

  private scheduleOvertimeWorkflow(orgId: string, userId: string, overtimeRequestId?: number): void {
    if (!this.workflowEngine || !overtimeRequestId) return;
    const start = () =>
      runInNewTenantTransaction(this.db, orgId, () =>
        this.workflowEngine.startWorkflow({
          orgId,
          objectType: "overtime_request",
          objectId: String(overtimeRequestId),
          requestedByUserId: userId,
          subjectEmployeeId: userId,
          context: { overtimeRequestId },
        }),
      ).catch(
        logSideEffectFailure("overtime approval workflow start", { orgId, overtimeRequestId }),
      );
    if (!registerAfterCommit(start)) void start();
  }
}
