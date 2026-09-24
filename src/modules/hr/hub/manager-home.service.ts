import { Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { DirectReportsService, type DirectReport } from "../../directory/direct-reports.service";
import { ApprovalsService } from "../../timesheets/core/approvals.service";
import { PeriodsReadService } from "../../timesheets/core/periods-read.service";
import { LeavesService } from "../time/leaves.service";
import { WfhService } from "../time/wfh.service";
import { HrWorkflowInstancesService } from "../workflows/hr-workflow-instances.service";
import type { ManagerHome, ManagerHomeApproval } from "./dto/manager-home-response.schemas";

export const MANAGER_HOME_APPROVAL_CAP = 20;
export const MANAGER_HOME_LOOKAHEAD_DAYS = 14;
export const MANAGER_HOME_PROBATION_WINDOW_DAYS = 30;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function displayName(parts: { name: string | null; firstName?: string | null; lastName?: string | null; email?: string | null }): string {
  const composed = [parts.firstName, parts.lastName].filter((part): part is string => !!part && part.trim() !== "").join(" ");
  return parts.name?.trim() || composed || parts.email || "Unknown";
}

@Injectable()
export class ManagerHomeService {
  constructor(
    private readonly directReports: DirectReportsService,
    private readonly leaves: LeavesService,
    private readonly wfh: WfhService,
    private readonly timesheetApprovals: ApprovalsService,
    private readonly periods: PeriodsReadService,
    private readonly workflows: HrWorkflowInstancesService,
  ) {}

  async getHome(u: CurrentUserContext, now = new Date()): Promise<ManagerHome> {
    const membershipId = actingMembershipId(u.principal);
    const today = isoDate(now);
    const horizon = isoDate(new Date(now.getTime() + MANAGER_HOME_LOOKAHEAD_DAYS * 86_400_000));
    const reports = await this.directReports.list(u.orgId, u.userId);
    const reportMembershipIds = reports.map((report) => report.membershipId).filter((id): id is number => id !== null);

    const [leave, wfh, timesheets, workflows, unsettled, availability] = await Promise.all([
      membershipId === null ? Promise.resolve([]) : this.leaves.pendingRoutedTo(u.orgId, membershipId, MANAGER_HOME_APPROVAL_CAP),
      membershipId === null ? Promise.resolve([]) : this.wfh.pendingRoutedTo(u.orgId, membershipId, MANAGER_HOME_APPROVAL_CAP),
      membershipId === null ? Promise.resolve([]) : this.timesheetApprovals.pendingRoutedTo(u.orgId, membershipId, MANAGER_HOME_APPROVAL_CAP),
      membershipId === null ? Promise.resolve({ data: [], total: 0 }) : this.workflows.getInbox(u, 1, MANAGER_HOME_APPROVAL_CAP),
      this.periods.unsettledForMembers(u.orgId, reportMembershipIds, today, 100),
      reports.length === 0 ? Promise.resolve([]) : this.leaves.teamAvailability(u.orgId, today, horizon),
    ]);

    const reportIds = new Set(reports.map((report) => report.userId));
    const reportByMembership = new Map(reports.filter((report) => report.membershipId !== null).map((report) => [report.membershipId, report]));
    const upcomingLeave = availability
      .filter((row) => reportIds.has(row.userId))
      .map((row) => ({ userId: row.userId, name: row.displayName, startDate: row.startDate, endDate: row.endDate, leaveTypeId: row.leaveTypeId }));
    const onLeaveToday = new Set(upcomingLeave.filter((row) => row.startDate <= today && row.endDate >= today).map((row) => row.userId));
    const unsettledByMembership = new Map<number, number>();
    for (const period of unsettled)
      if (period.userMembershipId !== null) unsettledByMembership.set(period.userMembershipId, (unsettledByMembership.get(period.userMembershipId) ?? 0) + 1);

    const items: ManagerHomeApproval[] = [
      ...leave.map((request) => ({
        kind: "leave" as const,
        id: request.id,
        subjectUserId: request.userId,
        subjectName: displayName(request.user ?? { name: null, email: null }),
        summary: `${request.leaveType?.name ?? "Leave"} · ${request.startDate}${request.endDate !== request.startDate ? ` to ${request.endDate}` : ""}${request.isHalfDay ? " (half day)" : ""}`,
        requestedAt: request.createdAt,
        dueAt: null,
        href: "/hr/leaves",
      })),
      ...wfh.map((request) => ({
        kind: "wfh" as const,
        id: request.id,
        subjectUserId: request.userId,
        subjectName: displayName({ name: request.userName, firstName: request.userFirstName, lastName: request.userLastName, email: request.userEmail }),
        summary: `Work from home · ${request.date}`,
        requestedAt: request.createdAt,
        dueAt: null,
        href: "/hr/leaves",
      })),
      ...timesheets.map((period) => ({
        kind: "timesheet" as const,
        id: period.id,
        subjectUserId: period.userMembershipId === null ? null : (reportByMembership.get(period.userMembershipId)?.userId ?? null),
        subjectName: period.userName ?? period.userEmail,
        summary: `Timesheet · ${period.periodStart} to ${period.periodEnd} · ${Number(period.totalHours).toFixed(1)}h`,
        requestedAt: period.submittedAt ?? now,
        dueAt: period.approvalDueAt,
        href: `/timesheets/approvals?period=${period.id}`,
      })),
      ...workflows.data.map((instance) => ({
        kind: "workflow" as const,
        id: instance.id,
        subjectUserId: instance.subjectEmployeeId,
        subjectName: null,
        summary: `${instance.objectType.replaceAll("_", " ")} · step ${instance.currentStepOrder}`,
        requestedAt: instance.createdAt,
        dueAt: instance.dueAt,
        href: "/hr/approvals",
      })),
    ].sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());

    return {
      isManager: reports.length > 0,
      generatedAt: now.toISOString(),
      reports: reports.map((report) => this.reportRow(report, onLeaveToday, unsettledByMembership)),
      approvals: { leave: leave.length, wfh: wfh.length, timesheets: timesheets.length, workflows: workflows.total, items },
      missingTimesheets: unsettled.map((period) => ({
        periodId: period.id,
        userId: period.userMembershipId === null ? null : (reportByMembership.get(period.userMembershipId)?.userId ?? null),
        name: period.userMembershipId === null ? null : (reportByMembership.get(period.userMembershipId)?.name ?? null),
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        status: period.status,
      })),
      upcomingLeave,
      probationDue: reports
        .flatMap((report) => {
          if (report.probationEndDate === null || report.lifecycleStatus !== "PROBATION") return [];
          const daysLeft = daysBetween(today, report.probationEndDate);
          if (daysLeft > MANAGER_HOME_PROBATION_WINDOW_DAYS) return [];
          return [{ userId: report.userId, name: report.name, probationEndDate: report.probationEndDate, daysLeft }];
        })
        .sort((a, b) => a.daysLeft - b.daysLeft),
    };
  }

  private reportRow(report: DirectReport, onLeaveToday: ReadonlySet<string>, unsettledByMembership: ReadonlyMap<number, number>) {
    return {
      userId: report.userId,
      membershipId: report.membershipId,
      name: report.name,
      email: report.email,
      designation: report.designation,
      joiningDate: report.joiningDate,
      lifecycleStatus: report.lifecycleStatus,
      onLeaveToday: onLeaveToday.has(report.userId),
      probationEndsOn: report.probationEndDate,
      unsettledTimesheets: report.membershipId === null ? 0 : (unsettledByMembership.get(report.membershipId) ?? 0),
    };
  }
}
