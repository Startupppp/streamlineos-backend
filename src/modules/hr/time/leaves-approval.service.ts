import {
  BadRequestException,
  ConflictException,
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
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { leaveApprovalScope, resolveLeavesViewScope } from "./leaves-scope";
import { AuditService } from "../../../common/audit/audit.service";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import { LeaveLedgerService } from "./leave-ledger.service";
import type { ApproveLeaveInput, RejectLeaveInput, UpdateLeaveInput } from "./dto/leaves.schemas";
import { LeaveDecisionEffectsService } from "./leave-decision-effects.service";

@Injectable()
export class LeavesApprovalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly ledger: LeaveLedgerService,
    private readonly effects: LeaveDecisionEffectsService,
  ) {}

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

  private leaveYear(startDate: string): number {
    return Number(startDate.slice(0, 4));
  }

  async updateStatus(
    currentUser: CurrentUserContext,
    leaveRequestId: number,
    _input: UpdateLeaveInput,
  ) {
    const scope = await resolveLeavesViewScope(this.access, currentUser);
    if (scope === "none") {
      throw new ForbiddenException("Only admins can approve or reject leave requests.");
    }

    const transition = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(leaveRequests)
        .where(
          and(
            eq(leaveRequests.id, leaveRequestId),
            eq(leaveRequests.orgId, currentUser.orgId),
            leaveApprovalScope(scope, currentUser.orgId, currentUser.userId),
          ),
        )
        .limit(1)
        .for("update");
      if (!current) return null;
      if (current.userId === currentUser.userId) {
        throw new ForbiddenException("You cannot approve or reject your own leave request.");
      }
      if (current.status === "PENDING") return { existing: current, changed: false };
      if (current.status !== "APPROVED" && current.status !== "REJECTED") {
        throw new BadRequestException(
          `Cannot revert a ${current.status} leave request to pending.`,
        );
      }

      const changed = await tx
        .update(leaveRequests)
        .set({
          status: "PENDING",
          approverId: current.approverId,
          rejectionReason: null,
          rowVersion: current.rowVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(leaveRequests.id, leaveRequestId),
            eq(leaveRequests.orgId, currentUser.orgId),
            eq(leaveRequests.status, current.status),
            eq(leaveRequests.rowVersion, current.rowVersion),
            leaveApprovalScope(scope, currentUser.orgId, currentUser.userId),
          ),
        )
        .returning({ id: leaveRequests.id });
      if (changed.length !== 1) {
        throw new ConflictException("This leave request was already updated. Refresh and try again.");
      }

      if (current.status === "APPROVED") {
        const leaveTypeRow = await tx.query.leaveTypes.findFirst({
          where: and(
            eq(leaveTypes.id, current.leaveTypeId),
            eq(leaveTypes.orgId, currentUser.orgId),
          ),
          columns: { daysPerYear: true },
        });

        if ((leaveTypeRow?.daysPerYear ?? 1) !== 0) {
          const diffDays = this.countLeaveDays(
            current.startDate,
            current.endDate,
            current.isHalfDay,
          );

          const [balanceRecord] = await tx
            .select()
            .from(leaveBalances)
            .where(
              and(
                eq(leaveBalances.userId, current.userId),
                eq(leaveBalances.leaveTypeId, current.leaveTypeId),
                eq(leaveBalances.orgId, currentUser.orgId),
                eq(leaveBalances.year, this.leaveYear(current.startDate)),
              ),
            )
            .limit(1)
            .for("update");

          if (balanceRecord) {
            const prevLopDays = Number(current.lopDays ?? 0);
            const paidDays = diffDays - prevLopDays;
            const restored = Number(balanceRecord.balance) + paidDays;
            await tx
              .update(leaveBalances)
              .set({ balance: restored.toString() })
              .where(eq(leaveBalances.id, balanceRecord.id));
            await tx
              .update(leaveRequests)
              .set({ lopDays: "0" })
              .where(
                and(
                  eq(leaveRequests.id, leaveRequestId),
                  eq(leaveRequests.orgId, currentUser.orgId),
                ),
              );

            if (paidDays > 0) await this.ledger.write(
              {
                orgId: currentUser.orgId,
                userId: current.userId,
                leaveTypeId: current.leaveTypeId,
                txnType: "reversal",
                days: paidDays,
                effectiveDate: current.startDate,
                source: "request",
                sourceId: String(leaveRequestId),
                note: "Status reverted to pending - balance restored",
                createdBy: currentUser.userId,
              },
              tx,
            );
          }
        }
      }
      await this.audit.logCritical({
        action: "hr.leave_reverted_to_pending",
        userId: currentUser.userId,
        orgId: currentUser.orgId,
        targetId: String(leaveRequestId),
        targetType: "leave_request",
        metadata: { previousStatus: current.status },
      });
      return { existing: current, changed: true };
    });
    if (!transition) return { ok: false as const, reason: "not_found" as const };

    if (transition.changed)
      await this.effects.afterRevertedToPending(
        currentUser.orgId,
        currentUser.userId,
        transition.existing,
      );

    return { ok: true as const };
  }

  async approve(
    currentUser: CurrentUserContext,
    leaveRequestId: number,
    input: ApproveLeaveInput,
  ) {
    const scope = await resolveLeavesViewScope(this.access, currentUser);
    if (scope === "none") {
      throw new ForbiddenException("You do not have permission to approve leave requests.");
    }

    let approverMembershipId: number;
    try {
      const actor = await assertOrganizationActor(this.db, currentUser.orgId, {
        kind: "user",
        userId: currentUser.userId,
      });
      approverMembershipId = actor.membershipId;
    } catch (e) {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    }

    const comment = input.comment;
    let lopDaysApplied = 0;

    const existing = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(leaveRequests)
        .where(
          and(
            eq(leaveRequests.id, leaveRequestId),
            eq(leaveRequests.orgId, currentUser.orgId),
            leaveApprovalScope(scope, currentUser.orgId, currentUser.userId),
          ),
        )
        .limit(1)
        .for("update");
      if (!current) throw new NotFoundException("Leave request not found.");
      if (current.status !== "PENDING") {
        throw new ConflictException(`Cannot approve a request with status: ${current.status}.`);
      }
      if (current.userId === currentUser.userId) {
        throw new ForbiddenException("You cannot approve your own leave request.");
      }

      const changed = await tx
        .update(leaveRequests)
        .set({
          status: "APPROVED",
          approverId: currentUser.userId,
          approverMembershipId,
          managerComment: comment ?? null,
          rowVersion: current.rowVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(leaveRequests.id, leaveRequestId),
            eq(leaveRequests.orgId, currentUser.orgId),
            eq(leaveRequests.status, "PENDING"),
            eq(leaveRequests.rowVersion, current.rowVersion),
            leaveApprovalScope(scope, currentUser.orgId, currentUser.userId),
          ),
        )
        .returning({ id: leaveRequests.id });
      if (changed.length !== 1) {
        throw new ConflictException("This leave request was already decided.");
      }

      const leaveTypeRow = await tx.query.leaveTypes.findFirst({
        where: and(
          eq(leaveTypes.id, current.leaveTypeId),
          eq(leaveTypes.orgId, currentUser.orgId),
        ),
        columns: { daysPerYear: true },
      });

      const isUnpaid = (leaveTypeRow?.daysPerYear ?? 1) === 0;
      if (!isUnpaid) {
        const diffDays = this.countLeaveDays(
          current.startDate,
          current.endDate,
          current.isHalfDay,
        );
        const [balanceRecord] = await tx
          .select()
          .from(leaveBalances)
          .where(
            and(
              eq(leaveBalances.userId, current.userId),
              eq(leaveBalances.leaveTypeId, current.leaveTypeId),
              eq(leaveBalances.orgId, currentUser.orgId),
              eq(leaveBalances.year, this.leaveYear(current.startDate)),
            ),
          )
          .limit(1)
          .for("update");

        if (balanceRecord) {
          const available = Number(balanceRecord.balance);
          const lopDays = Math.max(0, diffDays - Math.max(0, available));
          const paidDays = diffDays - lopDays;
          lopDaysApplied = lopDays;
          await tx
            .update(leaveRequests)
            .set({ lopDays: lopDays.toString() })
            .where(
              and(
                eq(leaveRequests.id, leaveRequestId),
                eq(leaveRequests.orgId, currentUser.orgId),
              ),
            );
          await tx
            .update(leaveBalances)
            .set({ balance: Math.max(0, available - paidDays).toString() })
            .where(eq(leaveBalances.id, balanceRecord.id));

          if (paidDays > 0) {
            await this.ledger.write(
              {
                orgId: currentUser.orgId,
                userId: current.userId,
                leaveTypeId: current.leaveTypeId,
                txnType: "consumption",
                days: paidDays,
                effectiveDate: current.startDate,
                source: "request",
                sourceId: String(leaveRequestId),
                note: comment ?? undefined,
                createdBy: currentUser.userId,
              },
              tx,
            );
          }
        }
      }
      await this.audit.logCritical({
        action: "hr.leave_approved",
        userId: currentUser.userId,
        orgId: currentUser.orgId,
        targetId: String(leaveRequestId),
        targetType: "leave_request",
        metadata: { comment, lopDaysApplied },
      });
      return current;
    });

    await this.effects.afterApproved(
      currentUser,
      leaveRequestId,
      existing,
      comment,
      lopDaysApplied,
    );

    return { success: true };
  }

  async reject(
    currentUser: CurrentUserContext,
    leaveRequestId: number,
    input: RejectLeaveInput,
  ) {
    const scope = await resolveLeavesViewScope(this.access, currentUser);
    if (scope === "none") {
      throw new ForbiddenException("You do not have permission to reject leave requests.");
    }

    let approverMembershipId: number;
    try {
      const actor = await assertOrganizationActor(this.db, currentUser.orgId, {
        kind: "user",
        userId: currentUser.userId,
      });
      approverMembershipId = actor.membershipId;
    } catch (e) {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    }

    const { reason, comment } = input;

    const existing = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(leaveRequests)
        .where(
          and(
            eq(leaveRequests.id, leaveRequestId),
            eq(leaveRequests.orgId, currentUser.orgId),
            leaveApprovalScope(scope, currentUser.orgId, currentUser.userId),
          ),
        )
        .limit(1)
        .for("update");
      if (!current) throw new NotFoundException("Leave request not found.");
      if (current.status !== "PENDING") {
        throw new ConflictException(`Cannot reject a request with status: ${current.status}.`);
      }
      if (current.userId === currentUser.userId) {
        throw new ForbiddenException("You cannot reject your own leave request.");
      }

      const changed = await tx
        .update(leaveRequests)
        .set({
          status: "REJECTED",
          approverId: currentUser.userId,
          approverMembershipId,
          rejectionReason: reason,
          managerComment: comment ?? null,
          rowVersion: current.rowVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(leaveRequests.id, leaveRequestId),
            eq(leaveRequests.orgId, currentUser.orgId),
            eq(leaveRequests.status, "PENDING"),
            eq(leaveRequests.rowVersion, current.rowVersion),
            leaveApprovalScope(scope, currentUser.orgId, currentUser.userId),
          ),
        )
        .returning({ id: leaveRequests.id });
      if (changed.length !== 1) {
        throw new ConflictException("This leave request was already decided.");
      }

      await this.audit.logCritical({
        action: "hr.leave_rejected",
        userId: currentUser.userId,
        orgId: currentUser.orgId,
        targetId: String(leaveRequestId),
        targetType: "leave_request",
        metadata: { reason, comment },
      });
      return current;
    });

    await this.effects.afterRejected(
      currentUser,
      leaveRequestId,
      existing,
      reason,
      comment,
    );

    return { success: true };
  }
}
