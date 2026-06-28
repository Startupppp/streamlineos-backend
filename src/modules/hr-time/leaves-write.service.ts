import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import {
  leaveBalances,
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
import type {
  ApproveLeaveInput,
  CreateLeaveInput,
  RejectLeaveInput,
  UpdateLeaveInput,
} from "./dto/leaves.schemas";

const UNPAID_LEAVE_NAME = "Unpaid Leave";

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
        columns: { name: true },
      }),
    ]);

    const isUnpaid = leaveType?.name === UNPAID_LEAVE_NAME;
    if (!isUnpaid && balance && Number(balance.balance) < requestedDays) {
      throw new BadRequestException(
        `Insufficient leave balance. Available: ${balance.balance}, Required: ${requestedDays}`,
      );
    }

    const overlapping = await this.db.query.leaveRequests.findFirst({
      where: and(
        eq(leaveRequests.userId, u.userId),
        eq(leaveRequests.orgId, u.orgId),
        lte(leaveRequests.startDate, formatDateOnly(new Date(body.endDate))),
        gte(leaveRequests.startDate, formatDateOnly(new Date(body.startDate))),
      ),
    });
    if (overlapping && overlapping.status !== "REJECTED") {
      throw new BadRequestException("You already have a leave request for overlapping dates.");
    }

    const [leaveRequest] = await this.db
      .insert(leaveRequests)
      .values({
        orgId: u.orgId,
        userId: u.userId,
        leaveTypeId: body.leaveTypeId,
        startDate: formatDateOnly(new Date(body.startDate)),
        endDate: formatDateOnly(new Date(body.endDate)),
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

    void this.dispatchLeaveRequested(
      u,
      leaveRequest.id,
      body,
      leaveType?.name ?? "Leave",
      requestedDays,
    );

    return { success: true };
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
        const leaveType = await tx.query.leaveTypes.findFirst({
          where: eq(leaveTypes.id, existing.leaveTypeId),
          columns: { name: true },
        });

        if (leaveType?.name !== UNPAID_LEAVE_NAME) {
          const start = new Date(existing.startDate);
          const end = new Date(existing.endDate);
          let diffDays = existing.isHalfDay ? 0.5 : 0;
          if (!existing.isHalfDay) {
            const cursor = new Date(start);
            while (cursor <= end) {
              const day = cursor.getDay();
              if (day !== 0 && day !== 6) diffDays++;
              cursor.setDate(cursor.getDate() + 1);
            }
          }

          const balanceRecord = await tx.query.leaveBalances.findFirst({
            where: and(
              eq(leaveBalances.userId, existing.userId),
              eq(leaveBalances.leaveTypeId, existing.leaveTypeId),
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

      const leaveType = await tx.query.leaveTypes.findFirst({
        where: eq(leaveTypes.id, existing.leaveTypeId),
        columns: { name: true },
      });
      if (leaveType?.name === UNPAID_LEAVE_NAME) return;

      const diffDays = this.countLeaveDays(existing.startDate, existing.endDate, existing.isHalfDay);

      const balanceRecord = await tx.query.leaveBalances.findFirst({
        where: and(
          eq(leaveBalances.userId, existing.userId),
          eq(leaveBalances.leaveTypeId, existing.leaveTypeId),
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

  private countLeaveDays(startDate: string, endDate: string, isHalfDay: boolean): number {
    if (isHalfDay) return 0.5;
    let diffDays = 0;
    const cursor = new Date(startDate);
    const end = new Date(endDate);
    while (cursor <= end) {
      const day = cursor.getDay();
      if (day !== 0 && day !== 6) diffDays++;
      cursor.setDate(cursor.getDate() + 1);
    }
    return diffDays;
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
