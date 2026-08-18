import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CacheService } from "../../../common/cache/cache.service";
import { logger } from "../../../common/logger/logger.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { leaveTypes, users } from "../../../db/schema";
import { AutomationService } from "../../automation/automation.service";
import { EmailService } from "../../email/email.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { WebhooksDispatchService } from "../../webhooks/webhooks-dispatch.service";
import { PayrollInputsService } from "../payroll-inputs/payroll-inputs.service";

export interface LeaveDecisionRecord {
  userId: string;
  leaveTypeId: number;
  startDate: string;
  endDate: string;
}

@Injectable()
export class LeaveDecisionEffectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly webhooksDispatch: WebhooksDispatchService,
    private readonly notifications: NotificationsService,
    private readonly payrollInputs: PayrollInputsService,
    private readonly cache: CacheService,
  ) {}

  async afterRevertedToPending(
    orgId: string,
    actorId: string,
    leaveDecision: LeaveDecisionRecord,
  ): Promise<void> {
    this.rebuildPayrollInputsForLeaveRange(orgId, actorId, leaveDecision);
    await this.invalidateLeaveAnalytics(orgId);
  }

  async afterApproved(
    currentUser: CurrentUserContext,
    leaveRequestId: number,
    leaveDecision: LeaveDecisionRecord,
    managerComment: string | undefined,
    lopDaysApplied: number,
  ): Promise<void> {
    const lopNote =
      lopDaysApplied > 0
        ? ` Note: ${lopDaysApplied} day(s) will be Loss of Pay (LOP) due to insufficient balance.`
        : "";
    const commentNote = managerComment ? ` Manager note: "${managerComment}"` : "";

    await this.notifications.create({
      orgId: currentUser.orgId,
      userId: leaveDecision.userId,
      type: "SUCCESS",
      title: "Leave Approved",
      message: `Your leave request has been approved.${lopNote}${commentNote}`,
      link: "/hr/leaves",
    });

    void this.dispatchLeaveDecision(
      currentUser,
      leaveRequestId,
      leaveDecision,
      "APPROVED",
      null,
    );
    this.webhooksDispatch.dispatch(currentUser.orgId, "leave.approved", {
      leaveId: leaveRequestId,
      userId: leaveDecision.userId,
      startDate: leaveDecision.startDate,
      endDate: leaveDecision.endDate,
      leaveTypeId: leaveDecision.leaveTypeId,
    });
    this.rebuildPayrollInputsForLeaveRange(currentUser.orgId, currentUser.userId, leaveDecision);
    await this.invalidateLeaveAnalytics(currentUser.orgId);
  }

  async afterRejected(
    currentUser: CurrentUserContext,
    leaveRequestId: number,
    leaveDecision: LeaveDecisionRecord,
    rejectionReason: string,
    managerComment: string | undefined,
  ): Promise<void> {
    await this.notifications.create({
      orgId: currentUser.orgId,
      userId: leaveDecision.userId,
      type: "ERROR",
      title: "Leave Rejected",
      message: `Your leave request has been rejected. Reason: ${rejectionReason}${managerComment ? ` — "${managerComment}"` : ""}`,
      link: "/hr/leaves",
    });

    this.rebuildPayrollInputsForLeaveRange(currentUser.orgId, currentUser.userId, leaveDecision);
    void this.dispatchLeaveDecision(
      currentUser,
      leaveRequestId,
      leaveDecision,
      "REJECTED",
      rejectionReason,
    );
    await this.invalidateLeaveAnalytics(currentUser.orgId);
  }

  private async invalidateLeaveAnalytics(orgId: string): Promise<void> {
    await this.cache.invalidateNamespace(`hr:leave-analytics:${orgId}`);
  }

  private rebuildPayrollInputsForLeaveRange(
    orgId: string,
    actorId: string,
    leaveDecision: LeaveDecisionRecord,
  ): void {
    const monthKeys = new Set<string>([
      leaveDecision.startDate.slice(0, 7),
      leaveDecision.endDate.slice(0, 7),
    ]);
    for (const monthKey of monthKeys) {
      void this.payrollInputs
        .rebuildOpenPeriodForMonth(orgId, actorId, monthKey)
        .catch((error: unknown) => {
          logger.warn("payroll input rebuild after leave decision failed", {
            orgId,
            monthKey,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  private async dispatchLeaveDecision(
    currentUser: CurrentUserContext,
    leaveRequestId: number,
    leaveDecision: LeaveDecisionRecord,
    decision: "APPROVED" | "REJECTED",
    rejectionReason: string | null,
  ): Promise<void> {
    try {
      const [employee, leaveType, approver] = await Promise.all([
        this.db.query.users.findFirst({
          where: eq(users.id, leaveDecision.userId),
          columns: { email: true, name: true },
        }),
        leaveDecision.leaveTypeId
          ? this.db.query.leaveTypes.findFirst({
              where: eq(leaveTypes.id, leaveDecision.leaveTypeId),
              columns: { name: true },
            })
          : Promise.resolve(null),
        this.db.query.users.findFirst({
          where: eq(users.id, currentUser.userId),
          columns: { name: true },
        }),
      ]);

      const leaveTypeName = leaveType?.name ?? "Leave";
      const approverName = approver?.name ?? "HR";
      if (employee?.email) {
        await this.email.sendLeaveStatusUpdateEmail(
          employee.email,
          employee.name ?? "Employee",
          leaveTypeName,
          leaveDecision.startDate,
          leaveDecision.endDate,
          decision,
          approverName,
          decision === "REJECTED" ? (rejectionReason ?? undefined) : undefined,
        );
      }

      await this.automation.runAutomationsForEvent(
        currentUser.orgId,
        decision === "APPROVED" ? "leave.approved" : "leave.rejected",
        {
          leaveRequestId,
          userId: leaveDecision.userId,
          employeeName: employee?.name ?? "",
          employeeEmail: employee?.email ?? "",
          leaveType: leaveTypeName,
          startDate: leaveDecision.startDate,
          endDate: leaveDecision.endDate,
          decision,
          approverId: currentUser.userId,
          rejectionReason: decision === "REJECTED" ? rejectionReason : null,
          decidedAt: new Date().toISOString(),
        },
      );
    } catch {
      return;
    }
  }
}
