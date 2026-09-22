import { ConflictException } from "@nestjs/common";
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

type RejectionTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface RejectionTransitionDeps {
  readonly audit: TimesheetsAuditService;
}

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
      approvalDueAt: null,
      eventSeq: sql`${timesheetPeriods.eventSeq} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(timesheetPeriods.id, periodId),
        eq(timesheetPeriods.orgId, u.orgId),
        eq(timesheetPeriods.status, "SUBMITTED"),
      ),
    )
    .returning(LIFECYCLE_RETURNING);

  if (!transition) throw new ConflictException(`Period ${periodId} is no longer awaiting a decision`);

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
): Promise<number[]> {
  const { input, owners, now } = rejection;

  const transitions = await tx
    .update(timesheetPeriods)
    .set({
      status: "REJECTED",
      rejectedAt: now,
      rejectionReason: input.reason,
      approvalDueAt: null,
      eventSeq: sql`${timesheetPeriods.eventSeq} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(timesheetPeriods.orgId, u.orgId),
        inArray(timesheetPeriods.id, ids),
        eq(timesheetPeriods.status, "SUBMITTED"),
      ),
    )
    .returning({ ...LIFECYCLE_RETURNING, id: timesheetPeriods.id });
  const periodIds = transitions.map((transition) => transition.id);
  if (periodIds.length === 0) return periodIds;

  await tx
    .update(timesheets)
    .set({
      status: "REJECTED",
      rejectionReason: input.reason,
      updatedAt: now,
    })
    .where(
      and(
        inArray(timesheets.timesheetPeriodId, periodIds),
        eq(timesheets.orgId, u.orgId),
        isNull(timesheets.voidedAt),
      ),
    );

  const actorMembId = actingMembershipId(u.principal);
  await deps.audit.recordMany(
    tx,
    periodIds.map((id) => ({
      orgId: u.orgId,
      actorMembershipId: actorMembId,
      entityType: "period",
      entityId: id.toString(),
      action: "period.rejected",
      reason: input.reason,
    })),
  );

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
  return periodIds;
}
