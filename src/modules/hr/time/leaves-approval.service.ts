import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  leaveBalances,
  leaveRequests,
  leaveTypes,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { resolveLeavesViewScope } from "./leaves-scope";
import { AuditService } from "../../../common/audit/audit.service";
import { EmailService } from "../../email/email.service";
import { AutomationService } from "../../automation/automation.service";
import { WebhooksDispatchService } from "../../webhooks/webhooks-dispatch.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { LeaveLedgerService } from "./leave-ledger.service";
import { PayrollInputsService } from "../payroll-inputs/payroll-inputs.service";
import { CacheService } from "../../../common/cache/cache.service";
import { logger } from "../../../common/logger/logger.service";
import type { ApproveLeaveInput, RejectLeaveInput, UpdateLeaveInput } from "./dto/leaves.schemas";

interface LeaveRow {
  userId: string;
  leaveTypeId: number;
  startDate: string;
  endDate: string;
}

@Injectable()
export class LeavesApprovalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
    private readonly webhooksDispatch: WebhooksDispatchService,
    private readonly notifications: NotificationsService,
    private readonly access: AccessService,
    private readonly ledger: LeaveLedgerService,
    private readonly payrollInputs: PayrollInputsService,
    private readonly cache: CacheService,
  ) {}

  private async invalidateLeaveAnalytics(orgId: string): Promise<void> {
    await this.cache.invalidateNamespace(`hr:leave-analytics:${orgId}`);
  }

  private rebuildPayrollInputsForLeaveRange(
    orgId: string,
    actorId: string,
    startDate: string,
    endDate: string,
  ): void {
    const months = new Set<string>();
    months.add(startDate.slice(0, 7));
    months.add(endDate.slice(0, 7));
    for (const monthKey of months) {
      void this.payrollInputs
        .rebuildOpenPeriodForMonth(orgId, actorId, monthKey)
        .catch((err: unknown) => {
          logger.warn("payroll input rebuild after leave decision failed", {
            orgId,
            monthKey,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
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

    if (
      existing.status === "PENDING" &&
      (body.status === "APPROVED" || body.status === "REJECTED")
    ) {
      this.rebuildPayrollInputsForLeaveRange(
        u.orgId,
        u.userId,
        existing.startDate,
        existing.endDate,
      );
    }

    await this.invalidateLeaveAnalytics(u.orgId);

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

    this.rebuildPayrollInputsForLeaveRange(
      u.orgId,
      u.userId,
      existing.startDate,
      existing.endDate,
    );

    await this.invalidateLeaveAnalytics(u.orgId);

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

    this.rebuildPayrollInputsForLeaveRange(
      u.orgId,
      u.userId,
      existing.startDate,
      existing.endDate,
    );

    this.audit.log({
      action: "hr.leave_rejected",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(leaveId),
      targetType: "leave_request",
      metadata: { reason, comment },
    });

    void this.dispatchLeaveDecision(u, leaveId, existing, "REJECTED", reason);

    await this.invalidateLeaveAnalytics(u.orgId);

    return { success: true };
  }
}
