import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  leaveBalances,
  leaveRequests,
  leaveTypes,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { leaveApprovalScope, resolveLeavesViewScope } from "./leaves-scope";
import { AuditService } from "../../../common/audit/audit.service";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import { LeaveLedgerService } from "./leave-ledger.service";
import { openingEntitlementOf } from "./leave-entitlement";
import type { TenantTx } from "../../../db/drizzle.types";
import type { ApproveLeaveInput, RejectLeaveInput, UpdateLeaveInput } from "./dto/leaves.schemas";
import { LeaveDecisionEffectsService } from "./leave-decision-effects.service";
import { ApprovalAuthorityService } from "../../directory/approval-authority.service";

@Injectable()
export class LeavesApprovalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly ledger: LeaveLedgerService,
    private readonly effects: LeaveDecisionEffectsService,
    private readonly approvals: ApprovalAuthorityService,
  ) {}

  /**
   * BUG-HRMS-017. Whether this decider may act on a request they raised.
   *
   * Normally not: deciding your own leave is the segregation-of-duties control
   * this refusal exists for, and it stays. But `ApprovalAuthorityService` already
   * routes a sole founder's request back to themselves on purpose — "no rung and
   * no queue member remains, so dead-ending them is worse" — and this path then
   * refused the route its own router had chosen. A one-person organisation could
   * raise leave and never close it: the request sat PENDING for ever, balances
   * frozen, with the UI saying only "Cannot approve own request" and offering no
   * alternate approver.
   *
   * Asking the router, rather than re-deriving the rule here, is what keeps the
   * two halves from disagreeing again. The hatch opens only when the router says
   * nobody else can decide, so any org with a second approver is unaffected.
   */
  private async mayDecideOwnRequest(
    orgId: string,
    subjectUserId: string,
  ): Promise<boolean> {
    const route = await this.approvals.resolve(orgId, subjectUserId, "leave");
    return route.ownerSelfApproval && route.approver?.userId === subjectUserId;
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

  private leaveYear(startDate: string): number {
    return Number(startDate.slice(0, 4));
  }

  /**
   * HRMS-E2E-014. Open this person's balance for the type at its configured
   * entitlement, so an approval has something real to deduct from.
   *
   * Nothing creates a `leave_balances` row when a leave type is configured, and
   * the deduction below used to be skipped when the row was missing — so on a
   * freshly configured organisation an approval silently subtracted nothing and
   * wrote no ledger entry. `daysPerYear` is the opening entitlement; the row is
   * created here, inside the approval's own transaction, rather than in the GET
   * that reads balances, which may not write (BE-33).
   *
   * `onConflictDoNothing` against `uniq_leave_balances_user_type_year` makes two
   * approvals racing for the same person and type safe: one inserts, the other
   * re-reads. Returns null when the request has no membership or the type has
   * gone, in which case the caller behaves exactly as it did before.
   */
  private async openBalanceForApproval(
    tx: TenantTx,
    orgId: string,
    current: {
      userId: string;
      userMembershipId: number | null;
      leaveTypeId: number;
      startDate: string;
    },
  ) {
    if (current.userMembershipId === null) return null;

    const type = await tx.query.leaveTypes.findFirst({
      where: and(eq(leaveTypes.id, current.leaveTypeId), eq(leaveTypes.orgId, orgId)),
      columns: { id: true, name: true, daysPerYear: true },
    });
    if (!type) return null;

    const year = this.leaveYear(current.startDate);
    await tx
      .insert(leaveBalances)
      .values({
        orgId,
        userId: current.userId,
        userMembershipId: current.userMembershipId,
        leaveTypeId: current.leaveTypeId,
        balance: openingEntitlementOf(type),
        year,
      })
      .onConflictDoNothing();

    const [opened] = await tx
      .select()
      .from(leaveBalances)
      .where(
        and(
          eq(leaveBalances.userMembershipId, current.userMembershipId),
          eq(leaveBalances.leaveTypeId, current.leaveTypeId),
          eq(leaveBalances.orgId, orgId),
          eq(leaveBalances.year, year),
        ),
      )
      .limit(1)
      .for("update");
    return opened ?? null;
  }

  async updateStatus(
    currentUser: CurrentUserContext,
    leaveRequestId: number,
    _input: UpdateLeaveInput,
  ) {
    const scope = await resolveLeavesViewScope(this.access, currentUser);
    if (scope.denied) {
      throw new ForbiddenException("Only admins can approve or reject leave requests.");
    }
    const approvalWhere = scope.compose(
      {
        tenant: leaveRequests.orgId,
        scope: leaveApprovalScope(
          currentUser.principal != null ? actingMembershipId(currentUser.principal) : null,
        ),
      },
      ({ sql: where }) => where,
      () => sql`false`,
    );

    const transition = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(leaveRequests)
        .where(and(eq(leaveRequests.id, leaveRequestId), approvalWhere))
        .limit(1)
        .for("update");
      if (!current) return null;
      if (
        current.userId === currentUser.userId &&
        !(await this.mayDecideOwnRequest(currentUser.orgId, current.userId))
      ) {
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
            eq(leaveRequests.status, current.status),
            eq(leaveRequests.rowVersion, current.rowVersion),
            approvalWhere,
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

          const [balanceRecord] = current.userMembershipId == null
            ? []
            : await tx
              .select()
              .from(leaveBalances)
              .where(
                and(
                  eq(leaveBalances.userMembershipId, current.userMembershipId),
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
    if (scope.denied) {
      throw new ForbiddenException("You do not have permission to approve leave requests.");
    }
    const approvalWhere = scope.compose(
      {
        tenant: leaveRequests.orgId,
        scope: leaveApprovalScope(
          currentUser.principal != null ? actingMembershipId(currentUser.principal) : null,
        ),
      },
      ({ sql: where }) => where,
      () => sql`false`,
    );

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
        .where(and(eq(leaveRequests.id, leaveRequestId), approvalWhere))
        .limit(1)
        .for("update");
      if (!current) throw new NotFoundException("Leave request not found.");
      if (current.status !== "PENDING") {
        throw new ConflictException(`Cannot approve a request with status: ${current.status}.`);
      }
      if (
        current.userId === currentUser.userId &&
        !(await this.mayDecideOwnRequest(currentUser.orgId, current.userId))
      ) {
        throw new ForbiddenException(
          "You cannot approve your own leave request. Ask another approver, or have an administrator assign you a reporting manager.",
        );
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
            eq(leaveRequests.status, "PENDING"),
            eq(leaveRequests.rowVersion, current.rowVersion),
            approvalWhere,
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
        const [existingBalance] = current.userMembershipId == null
          ? []
          : await tx
            .select()
            .from(leaveBalances)
            .where(
              and(
                eq(leaveBalances.userMembershipId, current.userMembershipId),
                eq(leaveBalances.leaveTypeId, current.leaveTypeId),
                eq(leaveBalances.orgId, currentUser.orgId),
                eq(leaveBalances.year, this.leaveYear(current.startDate)),
              ),
            )
            .limit(1)
            .for("update");

        // HRMS-E2E-014. Nothing creates a balance row when a leave type is
        // configured, so a freshly configured organisation has none — and this
        // deduction used to be skipped entirely when the row was missing. An
        // approval then subtracted nothing and wrote no ledger entry, which is
        // why the audit could not verify a deduction: there was nothing to
        // deduct from. The type's daysPerYear is the opening entitlement, so the
        // row is opened here, on the write path, rather than in the GET that
        // reads it (BE-33).
        const balanceRecord =
          existingBalance ??
          (await this.openBalanceForApproval(tx, currentUser.orgId, current));

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
    if (scope.denied) {
      throw new ForbiddenException("You do not have permission to reject leave requests.");
    }
    const approvalWhere = scope.compose(
      {
        tenant: leaveRequests.orgId,
        scope: leaveApprovalScope(
          currentUser.principal != null ? actingMembershipId(currentUser.principal) : null,
        ),
      },
      ({ sql: where }) => where,
      () => sql`false`,
    );

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
        .where(and(eq(leaveRequests.id, leaveRequestId), approvalWhere))
        .limit(1)
        .for("update");
      if (!current) throw new NotFoundException("Leave request not found.");
      if (current.status !== "PENDING") {
        throw new ConflictException(`Cannot reject a request with status: ${current.status}.`);
      }
      if (
        current.userId === currentUser.userId &&
        !(await this.mayDecideOwnRequest(currentUser.orgId, current.userId))
      ) {
        throw new ForbiddenException(
          "You cannot reject your own leave request. Ask another approver, or have an administrator assign you a reporting manager.",
        );
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
            eq(leaveRequests.status, "PENDING"),
            eq(leaveRequests.rowVersion, current.rowVersion),
            approvalWhere,
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
