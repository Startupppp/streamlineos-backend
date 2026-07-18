import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, gte, inArray, lte, or } from "drizzle-orm";
import {
  leaveBalances,
  leaveBlackoutDates,
  leaveRequests,
  leaveTypes,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { resolveLeavesViewScope } from "./leaves-scope";
import { AuditService } from "../../common/audit/audit.service";
import { EmailService } from "../email/email.service";
import { AutomationService } from "../automation/automation.service";
import { WebhooksDispatchService } from "../webhooks/webhooks-dispatch.service";
import { NotificationsService } from "../notifications/notifications.service";
import { formatDateOnly } from "./date.helpers";
import { LeaveLedgerService } from "./leave-ledger.service";
import { HrWorkflowEngineService } from "../hr-workflows/hr-workflow-engine.service";
import type {
  ApproveLeaveInput,
  CreateLeaveInput,
  RejectLeaveInput,
  UpdateLeaveInput,
} from "./dto/leaves.schemas";

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
    private readonly webhooksDispatch: WebhooksDispatchService,
    private readonly notifications: NotificationsService,
    private readonly access: AccessService,
    private readonly ledger: LeaveLedgerService,
    private readonly workflowEngine: HrWorkflowEngineService,
  ) {}

  async create(u: CurrentUserContext, body: CreateLeaveInput) {
    const requestedDays = body.isHalfDay
      ? 0.5
      : Math.round(
          Math.abs(new Date(body.endDate).getTime() - new Date(body.startDate).getTime()) /
            (1000 * 60 * 60 * 24),
        ) + 1;

    const [balance, leaveType] = await Promise.all([
      this.db.query.leaveBalances.findFirst({
        where: and(
          eq(leaveBalances.userId, u.userId),
          eq(leaveBalances.orgId, u.orgId),
          eq(leaveBalances.leaveTypeId, body.leaveTypeId),
          eq(leaveBalances.year, new Date().getFullYear()),
        ),
      }),
      this.db.query.leaveTypes.findFirst({
        where: and(eq(leaveTypes.id, body.leaveTypeId), eq(leaveTypes.orgId, u.orgId)),
        columns: { name: true, daysPerYear: true },
      }),
    ]);

    const isUnpaid = (leaveType?.daysPerYear ?? 1) === 0;
    if (!isUnpaid && balance && Number(balance.balance) < requestedDays) {
      throw new BadRequestException(
        `Insufficient leave balance. Available: ${balance.balance}, Required: ${requestedDays}`,
      );
    }

    const startStr = formatDateOnly(new Date(body.startDate));
    const endStr = formatDateOnly(new Date(body.endDate));

    const [overlapping, blackout] = await Promise.all([
      this.db.query.leaveRequests.findFirst({
        where: and(
          eq(leaveRequests.userId, u.userId),
          eq(leaveRequests.orgId, u.orgId),
          lte(leaveRequests.startDate, endStr),
          gte(leaveRequests.endDate, startStr),
        ),
      }),
      this.db.query.leaveBlackoutDates.findFirst({
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

    const teamConflicts = await this.detectTeamConflicts(u.orgId, u.userId, startStr, endStr);

    const [leaveRequest] = await this.db
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

    if (!leaveRequest) {
      throw new InternalServerErrorException("Failed to create leave request.");
    }

    void this.startLeaveWorkflow(u, leaveRequest.id, body.approverId);
    void this.dispatchLeaveRequested(
      u,
      leaveRequest.id,
      body,
      leaveType?.name ?? "Leave",
      requestedDays,
    );

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

    return { ok: true as const };
  }

  async updateStatus(u: CurrentUserContext, leaveId: number, body: UpdateLeaveInput) {
    const scope = await resolveLeavesViewScope(this.access, u);
    if (scope === "none") {
      throw new ForbiddenException("Only admins can approve or reject leave requests.");
    }

    const existing = await this.db.query.leaveRequests.findFirst({
      where: and(eq(leaveRequests.id, leaveId), eq(leaveRequests.orgId, u.orgId)),
    });

    if (existing && scope === "own" && existing.approverId !== u.userId) {
      throw new ForbiddenException("You can only update leave requests assigned to you.");
    }

    if (!existing) return { ok: false as const, reason: "not_found" as const };
    if (existing.userId === u.userId) {
      throw new ForbiddenException("You cannot approve or reject your own leave request.");
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(leaveRequests)
        .set({
          status: body.status,
          approverId: body.status !== "PENDING" ? u.userId : existing.approverId,
          rejectionReason: body.status === "REJECTED" ? (body.rejectionReason ?? null) : null,
        })
        .where(eq(leaveRequests.id, leaveId));

      if (body.status === "PENDING" && existing.status === "APPROVED" && existing.leaveTypeId) {
        const leaveTypeRow = await tx.query.leaveTypes.findFirst({
          where: eq(leaveTypes.id, existing.leaveTypeId),
          columns: { daysPerYear: true },
        });

        if ((leaveTypeRow?.daysPerYear ?? 1) !== 0) {
          const diffDays = existing.isHalfDay ? 0.5 : this.countWorkdays(existing.startDate, existing.endDate);

          const balanceRecord = await tx.query.leaveBalances.findFirst({
            where: and(
              eq(leaveBalances.userId, existing.userId),
              eq(leaveBalances.leaveTypeId, existing.leaveTypeId),
              eq(leaveBalances.orgId, u.orgId),
              eq(leaveBalances.year, new Date().getFullYear()),
            ),
          });

          if (balanceRecord) {
            const prevLopDays = Number(existing.lopDays ?? 0);
            const paidDays = diffDays - prevLopDays;
            const restored = Number(balanceRecord.balance) + paidDays;
            await tx
              .update(leaveBalances)
              .set({ balance: restored.toString() })
              .where(eq(leaveBalances.id, balanceRecord.id));
            await tx
              .update(leaveRequests)
              .set({ lopDays: "0" })
              .where(eq(leaveRequests.id, leaveId));

            await this.ledger.write(
              {
                orgId: u.orgId,
                userId: existing.userId,
                leaveTypeId: existing.leaveTypeId,
                txnType: "reversal",
                days: paidDays,
                effectiveDate: existing.startDate,
                source: "request",
                sourceId: String(leaveId),
                note: "Status reverted to pending — balance restored",
                createdBy: u.userId,
              },
              tx,
            );
          }
        }
      }
    });

    if (existing.status === "PENDING" && (body.status === "APPROVED" || body.status === "REJECTED")) {
      void this.dispatchLeaveDecision(u, leaveId, existing, body.status, body.rejectionReason ?? null);
    }

    if (existing.status === "PENDING" && body.status === "APPROVED") {
      this.webhooksDispatch.dispatch(u.orgId, "leave.approved", {
        leaveId,
        userId: existing.userId,
        startDate: existing.startDate,
        endDate: existing.endDate,
        leaveTypeId: existing.leaveTypeId,
      });
    }

    return { ok: true as const };
  }

  async approve(u: CurrentUserContext, leaveId: number, body: ApproveLeaveInput) {
    const existing = await this.db.query.leaveRequests.findFirst({
      where: and(eq(leaveRequests.id, leaveId), eq(leaveRequests.orgId, u.orgId)),
    });

    if (!existing) throw new NotFoundException("Leave request not found.");
    if (existing.status !== "PENDING") {
      throw new BadRequestException(`Cannot approve a request with status: ${existing.status}.`);
    }
    if (existing.userId === u.userId) {
      throw new ForbiddenException("You cannot approve your own leave request.");
    }

    const comment = body.comment;
    let lopDaysApplied = 0;

    await this.db.transaction(async (tx) => {
      await tx
        .update(leaveRequests)
        .set({ status: "APPROVED", approverId: u.userId, managerComment: comment ?? null })
        .where(eq(leaveRequests.id, leaveId));

      if (!existing.leaveTypeId) return;

      const leaveTypeRow = await tx.query.leaveTypes.findFirst({
        where: eq(leaveTypes.id, existing.leaveTypeId),
        columns: { daysPerYear: true },
      });

      const isUnpaid = (leaveTypeRow?.daysPerYear ?? 1) === 0;
      if (isUnpaid) return;

      const diffDays = this.countLeaveDays(existing.startDate, existing.endDate, existing.isHalfDay);

      const balanceRecord = await tx.query.leaveBalances.findFirst({
        where: and(
          eq(leaveBalances.userId, existing.userId),
          eq(leaveBalances.leaveTypeId, existing.leaveTypeId),
          eq(leaveBalances.orgId, u.orgId),
          eq(leaveBalances.year, new Date().getFullYear()),
        ),
      });
      if (!balanceRecord) return;

      const available = Number(balanceRecord.balance);
      const lopDays = available <= 0 ? diffDays : Math.max(0, diffDays - available);
      const paidDays = diffDays - lopDays;
      const newBal = Math.max(0, available - paidDays);
      lopDaysApplied = lopDays;

      await tx
        .update(leaveRequests)
        .set({ lopDays: lopDays.toString() })
        .where(eq(leaveRequests.id, leaveId));
      await tx
        .update(leaveBalances)
        .set({ balance: newBal.toString() })
        .where(eq(leaveBalances.id, balanceRecord.id));

      if (paidDays > 0) {
        await this.ledger.write(
          {
            orgId: u.orgId,
            userId: existing.userId,
            leaveTypeId: existing.leaveTypeId,
            txnType: "consumption",
            days: paidDays,
            effectiveDate: existing.startDate,
            source: "request",
            sourceId: String(leaveId),
            note: comment ?? undefined,
            createdBy: u.userId,
          },
          tx,
        );
      }
    });

    const lopNote =
      lopDaysApplied > 0
        ? ` Note: ${lopDaysApplied} day(s) will be Loss of Pay (LOP) due to insufficient balance.`
        : "";
    const commentNote = comment ? ` Manager note: "${comment}"` : "";

    await this.notifications.create({
      orgId: u.orgId,
      userId: existing.userId,
      type: "SUCCESS",
      title: "Leave Approved",
      message: `Your leave request has been approved.${lopNote}${commentNote}`,
      link: "/hr/leaves",
    });

    this.audit.log({
      action: "hr.leave_approved",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(leaveId),
      targetType: "leave_request",
      metadata: { comment, lopDaysApplied },
    });

    void this.dispatchLeaveDecision(u, leaveId, existing, "APPROVED", null);

    this.webhooksDispatch.dispatch(u.orgId, "leave.approved", {
      leaveId,
      userId: existing.userId,
      startDate: existing.startDate,
      endDate: existing.endDate,
      leaveTypeId: existing.leaveTypeId,
    });

    return { success: true };
  }

  async reject(u: CurrentUserContext, leaveId: number, body: RejectLeaveInput) {
    const existing = await this.db.query.leaveRequests.findFirst({
      where: and(eq(leaveRequests.id, leaveId), eq(leaveRequests.orgId, u.orgId)),
    });

    if (!existing) throw new NotFoundException("Leave request not found.");
    if (existing.status !== "PENDING") {
      throw new BadRequestException(`Cannot reject a request with status: ${existing.status}.`);
    }
    if (existing.userId === u.userId) {
      throw new ForbiddenException("You cannot reject your own leave request.");
    }

    const { reason, comment } = body;

    await this.db
      .update(leaveRequests)
      .set({
        status: "REJECTED",
        approverId: u.userId,
        rejectionReason: reason,
        managerComment: comment ?? null,
      })
      .where(eq(leaveRequests.id, leaveId));

    await this.notifications.create({
      orgId: u.orgId,
      userId: existing.userId,
      type: "ERROR",
      title: "Leave Rejected",
      message: `Your leave request has been rejected. Reason: ${reason}${comment ? ` — "${comment}"` : ""}`,
      link: "/hr/leaves",
    });

    this.audit.log({
      action: "hr.leave_rejected",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(leaveId),
      targetType: "leave_request",
      metadata: { reason, comment },
    });

    void this.dispatchLeaveDecision(u, leaveId, existing, "REJECTED", reason);

    return { success: true };
  }

  private countWorkdays(startDate: string, endDate: string): number {
    let count = 0;
    const cursor = new Date(startDate);
    const end = new Date(endDate);
    while (cursor <= end) {
      const day = cursor.getDay();
      if (day !== 0 && day !== 6) count++;
      cursor.setDate(cursor.getDate() + 1);
    }
    return count;
  }

  private countLeaveDays(startDate: string, endDate: string, isHalfDay: boolean): number {
    if (isHalfDay) return 0.5;
    return this.countWorkdays(startDate, endDate);
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

  private async dispatchLeaveDecision(
    u: CurrentUserContext,
    leaveId: number,
    existing: LeaveRow,
    decision: "APPROVED" | "REJECTED",
    rejectionReason: string | null,
  ): Promise<void> {
    try {
      const [employee, leaveTypeRow, approver] = await Promise.all([
        this.db.query.users.findFirst({
          where: eq(users.id, existing.userId),
          columns: { email: true, name: true },
        }),
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
      const approverName = approver?.name ?? "HR";

      if (employee?.email) {
        await this.email.sendLeaveStatusUpdateEmail(
          employee.email,
          employee.name ?? "Employee",
          leaveTypeName,
          existing.startDate,
          existing.endDate,
          decision,
          approverName,
          decision === "REJECTED" ? (rejectionReason ?? undefined) : undefined,
        );
      }

      await this.automation.runAutomationsForEvent(
        u.orgId,
        decision === "APPROVED" ? "leave.approved" : "leave.rejected",
        {
          leaveRequestId: leaveId,
          userId: existing.userId,
          employeeName: employee?.name ?? "",
          employeeEmail: employee?.email ?? "",
          leaveType: leaveTypeName,
          startDate: existing.startDate,
          endDate: existing.endDate,
          decision,
          approverId: u.userId,
          rejectionReason: decision === "REJECTED" ? rejectionReason : null,
          decidedAt: new Date().toISOString(),
        },
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
    const hrMembers = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "HR")));

    if (hrMembers.length === 0) return [];

    const hrUsers = await this.db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(
        inArray(
          users.id,
          hrMembers.map((m) => m.userId),
        ),
      );

    return hrUsers.filter((hr) => hr.email);
  }
}
