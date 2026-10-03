import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { timesheetPeriods, timesheetSettings, timesheets } from "../../../db/schema";
import type { TimesheetApprovalRoute } from "../../../db/schema/timesheets/periods";
import { forEachOrg } from "../../../common/tenant/for-each-org";
import { logger } from "../../../common/logger/logger.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { APPROVAL_RUNGS, type ApprovalRung } from "../../directory/approval-authority.types";
import { TimesheetApprovalRoutingService } from "./approval-routing.service";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import { membershipUserIds } from "./lib/approval-lifecycle";

export const ESCALATION_PAGE_SIZE = 200;
export const ESCALATION_RUN_BUDGET = 2_000;

export interface EscalationSweepResult {
  orgsScanned: number;
  periodsOverdue: number;
  periodsEscalated: number;
  periodsUnowned: number;
}

function isApprovalRung(value: string | null): value is ApprovalRung {
  return APPROVAL_RUNGS.some((rung) => rung === value);
}

@Injectable()
export class TimesheetApprovalEscalationSweepService {
  private resumeAfterOrgId: string | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly routing: TimesheetApprovalRoutingService,
    private readonly audit: TimesheetsAuditService,
    private readonly notifications: NotificationDispatchService,
  ) {}

  async escalateAllOrgs(now = new Date()): Promise<EscalationSweepResult> {
    const result: EscalationSweepResult = { orgsScanned: 0, periodsOverdue: 0, periodsEscalated: 0, periodsUnowned: 0 };
    const budgetSpent = () => result.periodsOverdue >= ESCALATION_RUN_BUDGET;
    let lastVisitedOrgId: string | null = null;
    await forEachOrg(this.db, "timesheets-approval-escalation", async (tx, orgId) => {
      lastVisitedOrgId = orgId;
      const org = await this.escalateOrg(tx, orgId, now);
      result.orgsScanned += 1;
      result.periodsOverdue += org.periodsOverdue;
      result.periodsEscalated += org.periodsEscalated;
      result.periodsUnowned += org.periodsUnowned;
    }, "write", { startAfterOrgId: this.resumeAfterOrgId, stopWhen: budgetSpent });
    this.resumeAfterOrgId = budgetSpent() ? lastVisitedOrgId : null;
    return result;
  }

  async escalateOrg(tx: TenantTx, orgId: string, now: Date): Promise<Omit<EscalationSweepResult, "orgsScanned">> {
    const outcome = { periodsOverdue: 0, periodsEscalated: 0, periodsUnowned: 0 };
    const [settings] = await tx
      .select({ orgId: timesheetSettings.orgId })
      .from(timesheetSettings)
      .where(eq(timesheetSettings.orgId, orgId))
      .limit(1);
    if (!settings) return outcome;

    const overdue = await tx
      .select({
        id: timesheetPeriods.id,
        userMembershipId: timesheetPeriods.userMembershipId,
        currentApproverMembershipId: timesheetPeriods.currentApproverMembershipId,
        approvalRoute: timesheetPeriods.approvalRoute,
        periodStart: timesheetPeriods.periodStart,
        periodEnd: timesheetPeriods.periodEnd,
        totalHours: timesheetPeriods.totalHours,
      })
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.orgId, orgId),
          eq(timesheetPeriods.status, "SUBMITTED"),
          lte(timesheetPeriods.approvalDueAt, now),
          isNull(timesheetPeriods.approvalEscalatedAt),
        ),
      )
      .orderBy(asc(timesheetPeriods.approvalDueAt), asc(timesheetPeriods.id))
      .limit(ESCALATION_PAGE_SIZE);
    outcome.periodsOverdue = overdue.length;
    if (overdue.length === 0) return outcome;

    const owners = await membershipUserIds(
      tx,
      orgId,
      overdue.map((period) => period.userMembershipId).filter((id): id is number => id !== null),
    );

    for (const period of overdue) {
      const ownerUserId = period.userMembershipId === null ? undefined : owners.get(period.userMembershipId);
      const from = period.approvalRoute?.escalationRung ?? null;
      if (!ownerUserId || !isApprovalRung(from)) {
        outcome.periodsUnowned += 1;
        await this.markEscalated(tx, orgId, period.id, period.currentApproverMembershipId, period.approvalRoute, now);
        continue;
      }
      const entries = await tx
        .select({ projectId: timesheets.projectId })
        .from(timesheets)
        .where(and(eq(timesheets.timesheetPeriodId, period.id), eq(timesheets.orgId, orgId), isNull(timesheets.voidedAt)))
        .limit(500);
      const decision = await this.routing.resolve({
        orgId,
        subjectUserId: ownerUserId,
        entries,
        settings: { approvalMode: "MANAGER", approverSource: "REPORTING_MANAGER" },
        from,
        at: now,
      });
      if (decision.kind !== "routed") {
        outcome.periodsUnowned += 1;
        await this.markEscalated(tx, orgId, period.id, period.currentApproverMembershipId, period.approvalRoute, now);
        continue;
      }
      const route: TimesheetApprovalRoute = {
        ...decision.route,
        escalatedFrom: {
          approverUserId: period.approvalRoute?.approverUserId ?? null,
          rung: period.approvalRoute?.rung ?? null,
          at: now.toISOString(),
        },
      };
      await tx
        .update(timesheetPeriods)
        .set({
          currentApproverMembershipId: decision.approver?.membershipId ?? null,
          approvalRoute: route,
          approvalDueAt: decision.dueAt,
          approvalEscalatedAt: now,
          updatedAt: now,
        })
        .where(and(eq(timesheetPeriods.id, period.id), eq(timesheetPeriods.orgId, orgId)));
      await this.audit.record(tx, {
        orgId,
        actorMembershipId: null,
        entityType: "period",
        entityId: String(period.id),
        action: "period.approval_escalated",
        before: { currentApproverMembershipId: period.currentApproverMembershipId, approvalRoute: period.approvalRoute },
        after: { currentApproverMembershipId: decision.approver?.membershipId ?? null, approvalRoute: route },
      });
      outcome.periodsEscalated += 1;

      const recipients = decision.approver ? [decision.approver.userId] : decision.queueUserIds;
      if (recipients.length === 0) continue;
      await this.notifications.emit({
        orgId,
        eventKey: "timesheets.period.escalated",
        targetUserIds: recipients,
        entityType: "timesheet_period",
        entityId: String(period.id),
        title: `Timesheet approval escalated: ${period.periodStart} to ${period.periodEnd}`,
        message: `A timesheet for ${period.periodStart}–${period.periodEnd} (${period.totalHours}h) waited past its approval deadline. ${route.explanation}`,
        link: `/timesheets/approvals?period=${period.id}`,
        variables: {
          periodId: period.id,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          totalHours: period.totalHours,
        },
      });
    }
    if (outcome.periodsUnowned > 0)
      logger.warn("timesheets: overdue approvals could not be escalated", { orgId, count: outcome.periodsUnowned });
    return outcome;
  }

  private async markEscalated(
    tx: TenantTx,
    orgId: string,
    periodId: number,
    currentApproverMembershipId: number | null,
    previous: TimesheetApprovalRoute | null,
    now: Date,
  ): Promise<void> {
    await tx
      .update(timesheetPeriods)
      .set({ approvalEscalatedAt: now, updatedAt: now })
      .where(and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, orgId)));
    await this.audit.record(tx, {
      orgId,
      actorMembershipId: null,
      entityType: "period",
      entityId: String(periodId),
      action: "period.approval_escalation_failed",
      before: { currentApproverMembershipId, approvalRoute: previous },
      after: { approvalEscalatedAt: now.toISOString() },
    });
  }
}
