import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { timesheetPeriods, timesheets } from "../../../../db/schema";
import { actingMembershipId } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { TimesheetsAuditService } from "../timesheets-audit.service";
import {
  TIMESHEET_LIFECYCLE_EVENTS,
  emitPeriodLifecycleEvent,
} from "../events/timesheet-lifecycle.events";
import type { BulkRejectInput, RejectPeriodInput } from "../dto/approvals.schemas";
import {
  LIFECYCLE_RETURNING,
  lifecyclePayload,
  periodOwnerUserIdOrWarn,
} from "./approval-lifecycle";

/** The transaction `ApprovalsBulkService` opens around a rejection. */
type RejectionTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The service's own collaborator, passed in rather than reached for. */
export interface RejectionTransitionDeps {
  readonly audit: TimesheetsAuditService;
}

/*
  What a rejection writes, inside the transaction `ApprovalsBulkService` opens:
  the period (or periods) and their live entries move to REJECTED with the
  reason, `event_seq` is bumped by the UPDATE that reads it back, the audit row
  names the acting membership, and one lifecycle event goes out per period whose
  owner still resolves. The rejection counterpart of `approval-transition.ts`.

  Neither function checks permission. The service reads the periods, runs
  `assertCanActOnPeriod` on each and resolves the owners before it opens the
  transaction, and sends the notices after it commits. A new caller must run
  the guard first: these are the writes, not the gate.
*/

/** One period, whose owner the caller has already resolved (or failed to). */
export async function applyRejection(
  tx: RejectionTx,
  deps: RejectionTransitionDeps,
  u: CurrentUserContext,
  periodId: number,
  rejection: {
    readonly input: Pick<RejectPeriodInput, "reason">;
    readonly ownerUserId: string | null;
    readonly now: Date;
  },
): Promise<void> {
  const { input, ownerUserId, now } = rejection;

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

  await deps.audit.record(tx, {
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
}

/**
 * Every period in `ids`, each already past the guard: one UPDATE per table for
 * the batch, then one audit row and one lifecycle event per period.
 */
export async function applyBulkRejection(
  tx: RejectionTx,
  deps: RejectionTransitionDeps,
  u: CurrentUserContext,
  ids: number[],
  rejection: {
    readonly input: Pick<BulkRejectInput, "reason">;
    readonly owners: ReadonlyMap<number, string>;
    readonly now: Date;
  },
): Promise<void> {
  const { input, owners, now } = rejection;

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
  await deps.audit.recordMany(
    tx,
    ids.map((id) => ({
      orgId: u.orgId,
      actorMembershipId: actorMembId,
      entityType: "period",
      entityId: id.toString(),
      action: "period.rejected",
      reason: input.reason,
    })),
  );

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
}
