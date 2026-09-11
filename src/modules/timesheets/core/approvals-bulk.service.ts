import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { logger } from "../../../common/logger/logger.service";
import { timesheetPeriods, timesheets } from "../../../db/schema";
import { actingMembershipId } from "../../../common/auth/principal";
import { TimesheetsAuditService } from "./timesheets-audit.service";
import {
  ApprovalsService,
  LIFECYCLE_RETURNING,
  isExpectedApprovalSkip,
  lifecyclePayload,
  membershipUserIds,
  periodOwnerUserIdOrWarn,
} from "./approvals.service";
import {
  TIMESHEET_LIFECYCLE_EVENTS,
  emitPeriodLifecycleEvent,
} from "./events/timesheet-lifecycle.events";
import type {
  BulkApproveInput,
  BulkRejectInput,
  RejectPeriodInput,
} from "./dto/approvals.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

@Injectable()
export class ApprovalsBulkService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: TimesheetsAuditService,
    private readonly approvals: ApprovalsService,
  ) {}

  async rejectPeriod(
    u: CurrentUserContext,
    periodId: number,
    input: RejectPeriodInput,
  ) {
    const [period] = await this.db
      .select()
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.id, periodId),
          eq(timesheetPeriods.orgId, u.orgId),
        ),
      )
      .limit(1);

    if (!period) throw new NotFoundException("Period not found");
    if (period.status !== "SUBMITTED")
      throw new ConflictException("Only submitted periods can be rejected");
    await this.approvals.assertCanActOnPeriod(u, period);

    const owners = await membershipUserIds(this.db, u.orgId, [period.userMembershipId]);
    const ownerUserId = periodOwnerUserIdOrWarn(owners, period.userMembershipId, {
      orgId: u.orgId,
      periodId,
      operation: "reject",
    });

    const now = new Date();
    await this.db.transaction(async (tx) => {
      const [transition] = await tx
        .update(timesheetPeriods)
        .set({
          status: "REJECTED",
          rejectedAt: now,
          rejectionReason: input.reason,
          eventSeq: sql`${timesheetPeriods.eventSeq} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(timesheetPeriods.id, periodId),
            eq(timesheetPeriods.orgId, u.orgId),
          ),
        )
        .returning(LIFECYCLE_RETURNING);

      await tx
        .update(timesheets)
        .set({
          status: "REJECTED",
          rejectionReason: input.reason,
          updatedAt: now,
        })
        .where(
          and(
            eq(timesheets.timesheetPeriodId, periodId),
            eq(timesheets.orgId, u.orgId),
            isNull(timesheets.voidedAt),
          ),
        );

      await this.audit.record(tx, {
        orgId: u.orgId,
        actorMembershipId: actingMembershipId(u.principal),
        entityType: "period",
        entityId: periodId.toString(),
        action: "period.rejected",
        reason: input.reason,
      });

      if (transition && ownerUserId) {
        await emitPeriodLifecycleEvent(tx, {
          eventType: TIMESHEET_LIFECYCLE_EVENTS.rejected,
          orgId: u.orgId,
          periodId,
          eventSeq: transition.eventSeq,
          occurredAt: now,
          payload: lifecyclePayload(
            u.orgId,
            periodId,
            transition,
            ownerUserId,
            u.userId,
            now,
            input.reason,
          ),
        });
      }
    });

    if (ownerUserId) {
      await this.approvals.notifyPeriodRejected(u, {
        periodId,
        ownerUserId,
        title: `Timesheet rejected: ${period.periodStart} to ${period.periodEnd}`,
        message: `Your timesheet for ${period.periodStart}–${period.periodEnd} was rejected: ${input.reason}`,
        variables: {
          periodId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          reason: input.reason,
        },
      });
    }

    const [updated] = await this.db
      .select()
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.id, periodId),
          eq(timesheetPeriods.orgId, u.orgId),
        ),
      )
      .limit(1);

    return updated;
  }

  async bulkApprove(u: CurrentUserContext, input: BulkApproveInput) {
    let approved = 0;
    let skipped = 0;
    for (const periodId of input.periodIds) {
      try {
        await this.approvals.approveSinglePeriod(u, periodId);
        approved++;
      } catch (error) {
        if (isExpectedApprovalSkip(error)) {
          skipped++;
          continue;
        }
        logger.error("bulkApprove: failed to approve period", {
          orgId: u.orgId,
          periodId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    return { approved, skipped };
  }

  async bulkReject(u: CurrentUserContext, input: BulkRejectInput) {
    const candidates = await this.db
      .select({
        id: timesheetPeriods.id,
        status: timesheetPeriods.status,
        userMembershipId: timesheetPeriods.userMembershipId,
        currentApproverMembershipId: timesheetPeriods.currentApproverMembershipId,
      })
      .from(timesheetPeriods)
      .where(
        and(
          eq(timesheetPeriods.orgId, u.orgId),
          inArray(timesheetPeriods.id, input.periodIds),
          eq(timesheetPeriods.status, "SUBMITTED"),
        ),
      );

    const periods = [];
    for (const p of candidates) {
      try {
        await this.approvals.assertCanActOnPeriod(u, p);
        periods.push(p);
      } catch (err) {
        if (!(err instanceof ForbiddenException)) {
          logger.warn("bulkReject: assertCanActOnPeriod failed unexpectedly", {
            orgId: u.orgId,
            periodId: p.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (periods.length === 0) return { rejected: 0 };

    const now = new Date();
    const ids = periods.map((p) => p.id);
    const owners = await membershipUserIds(
      this.db,
      u.orgId,
      periods.map((p) => p.userMembershipId),
    );

    await this.db.transaction(async (tx) => {
      const transitions = await tx
        .update(timesheetPeriods)
        .set({
          status: "REJECTED",
          rejectedAt: now,
          rejectionReason: input.reason,
          eventSeq: sql`${timesheetPeriods.eventSeq} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(timesheetPeriods.orgId, u.orgId),
            inArray(timesheetPeriods.id, ids),
          ),
        )
        .returning({ ...LIFECYCLE_RETURNING, id: timesheetPeriods.id });

      await tx
        .update(timesheets)
        .set({
          status: "REJECTED",
          rejectionReason: input.reason,
          updatedAt: now,
        })
        .where(
          and(
            inArray(timesheets.timesheetPeriodId, ids),
            eq(timesheets.orgId, u.orgId),
            isNull(timesheets.voidedAt),
          ),
        );

      const actorMembId = actingMembershipId(u.principal);
      for (const id of ids) {
        await this.audit.record(tx, {
          orgId: u.orgId,
          actorMembershipId: actorMembId,
          entityType: "period",
          entityId: id.toString(),
          action: "period.rejected",
          reason: input.reason,
        });
      }

      /**
       * One event per period, not one for the batch. A bulk rejection is a
       * convenience for the approver; to everyone downstream it is N separate
       * things that happened to N separate people, and an event whose
       * `period_id` is a list is unroutable.
       */
      for (const transition of transitions) {
        const ownerUserId = periodOwnerUserIdOrWarn(owners, transition.userMembershipId, {
          orgId: u.orgId,
          periodId: transition.id,
          operation: "bulk-reject",
        });
        if (!ownerUserId) continue;
        await emitPeriodLifecycleEvent(tx, {
          eventType: TIMESHEET_LIFECYCLE_EVENTS.rejected,
          orgId: u.orgId,
          periodId: transition.id,
          eventSeq: transition.eventSeq,
          occurredAt: now,
          payload: lifecyclePayload(
            u.orgId,
            transition.id,
            transition,
            ownerUserId,
            u.userId,
            now,
            input.reason,
          ),
        });
      }
    });

    /**
     * One notification per worker, after the batch commits. A bulk rejection is
     * one action for the approver and N separate pieces of bad news for N
     * people, each of whom needs the reason and their own period link.
     */
    for (const p of periods) {
      const ownerUserId =
        p.userMembershipId === null ? undefined : owners.get(p.userMembershipId);
      if (!ownerUserId) continue;
      await this.approvals.notifyPeriodRejected(u, {
        periodId: p.id,
        ownerUserId,
        title: "Timesheet rejected",
        message: `Your submitted timesheet was rejected: ${input.reason}`,
        variables: { periodId: p.id, reason: input.reason },
      });
    }

    return { rejected: ids.length };
  }
}
