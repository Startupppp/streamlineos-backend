import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { and, eq, gte, inArray, lte, or } from "drizzle-orm";
import {
  leaveBalances,
  leaveBlackoutDates,
  leaveRequests,
  leaveTypes,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AuditService } from "../../../common/audit/audit.service";
import { EmailService } from "../../email/email.service";
import { AutomationService } from "../../automation/automation.service";
import { formatDateOnly } from "../../../common/date";
import { HrWorkflowEngineService } from "../workflows/hr-workflow-engine.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AccessService } from "../../access/access.service";
import type { CreateLeaveInput } from "./dto/leaves.schemas";

interface LeaveRow {
  userId: string;
  leaveTypeId: number;
  startDate: string;
  endDate: string;
}

@Injectable()
export class LeavesWriteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly workflowEngine: HrWorkflowEngineService,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  private async invalidateLeaveAnalytics(orgId: string): Promise<void> {
    await this.cache.invalidatePattern(`hr:leave-analytics:${orgId}:*`);
  }

  async create(u: CurrentUserContext, body: CreateLeaveInput) {
    const requestedDays = body.isHalfDay
      ? 0.5
      : Math.round(
          Math.abs(new Date(body.endDate).getTime() - new Date(body.startDate).getTime()) /
            (1000 * 60 * 60 * 24),
        ) + 1;

    const startStr = formatDateOnly(new Date(body.startDate));
    const endStr = formatDateOnly(new Date(body.endDate));

    const teamConflicts = await this.detectTeamConflicts(u.orgId, u.userId, startStr, endStr);

    const { leaveRequest, leaveTypeName } = await this.db.transaction(async (tx) => {
      const balanceRows = await tx
        .select()
        .from(leaveBalances)
        .where(
          and(
            eq(leaveBalances.userId, u.userId),
            eq(leaveBalances.orgId, u.orgId),
            eq(leaveBalances.leaveTypeId, body.leaveTypeId),
            eq(leaveBalances.year, new Date().getFullYear()),
          ),
        )
        .for("update")
        .limit(1);
      const balance = balanceRows[0];

      const leaveTypeRow = await tx.query.leaveTypes.findFirst({
        where: and(eq(leaveTypes.id, body.leaveTypeId), eq(leaveTypes.orgId, u.orgId)),
        columns: { name: true, daysPerYear: true },
      });

      const isUnpaid = (leaveTypeRow?.daysPerYear ?? 1) === 0;
      if (!isUnpaid && balance && Number(balance.balance) < requestedDays) {
        throw new BadRequestException(
          `Insufficient leave balance. Available: ${balance.balance}, Required: ${requestedDays}`,
        );
      }

      const [overlapping, blackout] = await Promise.all([
        tx.query.leaveRequests.findFirst({
          where: and(
            eq(leaveRequests.userId, u.userId),
            eq(leaveRequests.orgId, u.orgId),
            lte(leaveRequests.startDate, endStr),
            gte(leaveRequests.endDate, startStr),
          ),
        }),
        tx.query.leaveBlackoutDates.findFirst({
          where: and(
            eq(leaveBlackoutDates.orgId, u.orgId),
            lte(leaveBlackoutDates.startDate, endStr),
            gte(leaveBlackoutDates.endDate, startStr),
            or(
              eq(leaveBlackoutDates.appliesTo, "ALL"),
              eq(leaveBlackoutDates.appliesTo, u.userId),
            ),
          ),
        }),
      ]);

      if (overlapping && overlapping.status !== "REJECTED" && overlapping.status !== "CANCELLED") {
        throw new BadRequestException("You already have a leave request for overlapping dates.");
      }

      if (blackout) {
        throw new BadRequestException(
          `Leave cannot be requested during blackout period: ${blackout.reason}`,
        );
      }

      const [inserted] = await tx
        .insert(leaveRequests)
        .values({
          orgId: u.orgId,
          userId: u.userId,
          leaveTypeId: body.leaveTypeId,
          startDate: startStr,
          endDate: endStr,
          reason: body.reason,
          priority: body.priority,
          approverId: body.approverId ?? null,
          attachmentUrl: body.attachmentUrl ?? null,
          isHalfDay: body.isHalfDay,
          halfDayPeriod: body.halfDayPeriod ?? null,
          status: "PENDING",
        })
        .returning();

      if (!inserted) {
        throw new InternalServerErrorException("Failed to create leave request.");
      }

      return { leaveRequest: inserted, leaveTypeName: leaveTypeRow?.name ?? "Leave" };
    });

    void this.startLeaveWorkflow(u, leaveRequest.id, body.approverId);
    void this.dispatchLeaveRequested(
      u,
      leaveRequest.id,
      body,
      leaveTypeName,
      requestedDays,
    );

    await this.invalidateLeaveAnalytics(u.orgId);

    return {
      success: true,
      conflictWarning:
        teamConflicts.length > 0
          ? `${teamConflicts.length} team member(s) are also on leave during this period.`
          : undefined,
    };
  }

  async cancel(u: CurrentUserContext, leaveId: number) {
    const existing = await this.db.query.leaveRequests.findFirst({
      where: and(eq(leaveRequests.id, leaveId), eq(leaveRequests.orgId, u.orgId)),
    });

    if (!existing) return { ok: false as const, reason: "not_found" as const };
    if (existing.userId !== u.userId) {
      throw new ForbiddenException("You can only cancel your own leave requests.");
    }
    if (existing.status !== "PENDING") {
      throw new BadRequestException("Only pending leave requests can be cancelled.");
    }

    await this.db
      .update(leaveRequests)
      .set({ status: "CANCELLED" })
      .where(eq(leaveRequests.id, leaveId));

    this.audit.log({
      action: "hr.leave_cancelled",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(leaveId),
      targetType: "leave_request",
    });

    void this.dispatchLeaveCancellation(u, existing);

    await this.invalidateLeaveAnalytics(u.orgId);

    return { ok: true as const };
  }

  private async detectTeamConflicts(
    orgId: string,
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<string[]> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { reportingTo: true },
    });

    const sameMgrUsers = user?.reportingTo
      ? await this.db.query.users.findMany({
          where: eq(users.reportingTo, user.reportingTo),
          columns: { id: true },
        })
      : [];

    const peerIds = sameMgrUsers.map((u) => u.id).filter((id) => id !== userId);
    if (peerIds.length === 0) return [];

    const conflicts = await this.db.query.leaveRequests.findMany({
      where: and(
        eq(leaveRequests.orgId, orgId),
        eq(leaveRequests.status, "APPROVED"),
        inArray(leaveRequests.userId, peerIds),
        lte(leaveRequests.startDate, endDate),
        gte(leaveRequests.endDate, startDate),
      ),
      columns: { userId: true },
      limit: 10,
    });

    return [...new Set(conflicts.map((c) => c.userId))];
  }

  private async startLeaveWorkflow(
    u: CurrentUserContext,
    leaveRequestId: number,
    approverId?: string | null,
  ): Promise<void> {
    try {
      await this.workflowEngine.startWorkflow({
        orgId: u.orgId,
        objectType: "leave_request",
        objectId: String(leaveRequestId),
        requestedByUserId: u.userId,
        subjectEmployeeId: u.userId,
        context: { leaveRequestId, approverId },
      });
    } catch {
      return;
    }
  }

  private async dispatchLeaveRequested(
    u: CurrentUserContext,
    leaveRequestId: number,
    body: CreateLeaveInput,
    leaveTypeName: string,
    requestedDays: number,
  ): Promise<void> {
    try {
      const actor = await this.db.query.users.findFirst({
        where: eq(users.id, u.userId),
        columns: { name: true },
      });
      const actorName = actor?.name ?? null;

      await this.automation.runAutomationsForEvent(u.orgId, "leave.requested", {
        leaveRequestId,
        userId: u.userId,
        employeeName: actorName ?? "",
        leaveType: leaveTypeName,
        startDate: body.startDate,
        endDate: body.endDate,
        totalDays: requestedDays,
        reason: body.reason ?? null,
        priority: body.priority,
      });

      const recipients = await this.hrRecipients(u.orgId);
      await Promise.all(
        recipients.map((hr) =>
          this.email.sendLeaveRequestEmail(
            hr.email,
            hr.name ?? "HR",
            actorName ?? "Employee",
            leaveTypeName,
            formatDateOnly(new Date(body.startDate)),
            formatDateOnly(new Date(body.endDate)),
            body.reason ?? "No reason provided",
          ),
        ),
      );
    } catch {
      return;
    }
  }

  private async dispatchLeaveCancellation(u: CurrentUserContext, existing: LeaveRow): Promise<void> {
    try {
      const [leaveTypeRow, actor] = await Promise.all([
        existing.leaveTypeId
          ? this.db.query.leaveTypes.findFirst({
              where: eq(leaveTypes.id, existing.leaveTypeId),
              columns: { name: true },
            })
          : Promise.resolve(null),
        this.db.query.users.findFirst({
          where: eq(users.id, u.userId),
          columns: { name: true },
        }),
      ]);

      const leaveTypeName = leaveTypeRow?.name ?? "Leave";
      const employeeName = actor?.name ?? "Employee";

      const recipients = await this.hrRecipients(u.orgId);
      await Promise.all(
        recipients.map((hr) =>
          this.email.sendLeaveCancellationEmail(
            hr.email,
            hr.name ?? "HR",
            employeeName,
            leaveTypeName,
            existing.startDate,
            existing.endDate,
          ),
        ),
      );
    } catch {
      return;
    }
  }

  private async hrRecipients(orgId: string): Promise<{ email: string; name: string | null }[]> {
    const approvers = await this.access.membersWithPermission(orgId, "hr:leaves:approve");
    if (approvers.length === 0) return [];

    const hrUsers = await this.db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, approvers.map((m) => m.userId)));

    return hrUsers.filter((hr) => hr.email);
  }
}
