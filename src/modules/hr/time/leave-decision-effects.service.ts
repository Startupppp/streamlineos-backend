import { Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CacheService } from "../../../common/cache/cache.service";
import {
  CACHE_KEYS,
  DASHBOARD_LEAVE_BALANCE_NAMESPACE,
  DASHBOARD_PENDING_APPROVALS_NAMESPACE,
} from "../../../common/cache/cache-keys";
import { logger } from "../../../common/logger/logger.service";
import { AutomationService } from "../../automation/automation.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
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
    private readonly dispatch: NotificationDispatchService,
    private readonly automation: AutomationService,
    private readonly webhooksDispatch: WebhooksDispatchService,
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

    await this.dispatch.emit({
      orgId: currentUser.orgId,
      eventKey: "hr.leave.approved",
      actorUserId: currentUser.userId,
      targetUserIds: [leaveDecision.userId],
      title: "Leave Approved",
      message: `Your leave request has been approved.${lopNote}${commentNote}`,
      link: "/hr/leaves",
    });

    this.webhooksDispatch.dispatch(currentUser.orgId, "leave.approved", {
      leaveId: leaveRequestId,
      userId: leaveDecision.userId,
      startDate: leaveDecision.startDate,
      endDate: leaveDecision.endDate,
      leaveTypeId: leaveDecision.leaveTypeId,
    });
    this.triggerLeaveAutomation(currentUser, leaveRequestId, leaveDecision, "APPROVED", null);
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
    await this.dispatch.emit({
      orgId: currentUser.orgId,
      eventKey: "hr.leave.rejected",
      actorUserId: currentUser.userId,
      targetUserIds: [leaveDecision.userId],
      title: "Leave Rejected",
      message: `Your leave request has been rejected. Reason: ${rejectionReason}${managerComment ? ` — "${managerComment}"` : ""}`,
      link: "/hr/leaves",
    });

    this.triggerLeaveAutomation(currentUser, leaveRequestId, leaveDecision, "REJECTED", rejectionReason);
    this.rebuildPayrollInputsForLeaveRange(currentUser.orgId, currentUser.userId, leaveDecision);
    await this.invalidateLeaveAnalytics(currentUser.orgId);
  }

  private async invalidateLeaveAnalytics(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.leaveAnalyticsNamespace(orgId)),
      this.cache.invalidateNamespaceForOrg(orgId, DASHBOARD_PENDING_APPROVALS_NAMESPACE),
      this.cache.invalidateNamespaceForOrg(orgId, DASHBOARD_LEAVE_BALANCE_NAMESPACE),
    ]);
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

  private triggerLeaveAutomation(
    currentUser: CurrentUserContext,
    leaveRequestId: number,
    leaveDecision: LeaveDecisionRecord,
    decision: "APPROVED" | "REJECTED",
    rejectionReason: string | null,
  ): void {
    void this.automation
      .runAutomationsForEvent(
        currentUser.orgId,
        decision === "APPROVED" ? "leave.approved" : "leave.rejected",
        {
          leaveRequestId,
          userId: leaveDecision.userId,
          startDate: leaveDecision.startDate,
          endDate: leaveDecision.endDate,
          decision,
          approverId: currentUser.userId,
          rejectionReason: decision === "REJECTED" ? rejectionReason : null,
          decidedAt: new Date().toISOString(),
        },
      )
      .catch((error: unknown) => {
        logger.warn("automation trigger after leave decision failed", {
          orgId: currentUser.orgId,
          leaveRequestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}
