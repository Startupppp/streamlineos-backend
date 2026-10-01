import { ConflictException } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { timesheetPeriods, timesheets } from "../../../../db/schema";
import { actingMembershipId } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { OrganizationActor } from "../../../../common/organization/organization-actor";
import { bulkUpdateFromValues } from "../../../../common/db/bulk-update";
import type { RateResolverService } from "../rate-resolver.service";
import type { TimesheetsAuditService } from "../timesheets-audit.service";
import {
  TIMESHEET_LIFECYCLE_EVENTS,
  emitPeriodLifecycleEvent,
  emitPeriodLifecycleEvents,
  type EmitPeriodLifecycleInput,
} from "../events/timesheet-lifecycle.events";
import { LIFECYCLE_RETURNING, lifecyclePayload, periodOwnerUserIdOrWarn } from "./approval-lifecycle";

type ApprovalTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ApprovalTransitionDeps {
  readonly rateResolver: RateResolverService;
  readonly audit: TimesheetsAuditService;
}

export async function applyApproval(
  tx: ApprovalTx,
  deps: ApprovalTransitionDeps,
  u: CurrentUserContext,
  periodId: number,
  approval: {
    readonly approverActor: Pick<OrganizationActor, "membershipId">;
    readonly lockAfterApproval: boolean;
    readonly emitCount: number;
    readonly ownerUserId: string | null;
    readonly now: Date;
  },
): Promise<void> {
  const { approverActor, lockAfterApproval, emitCount, ownerUserId, now } = approval;
  // Approving with lockAfterApproval stamps lockedAt, so the period really is
  // locked and the status has to say so. Leaving it APPROVED while emitting
  // timesheets.period.locked put the row and its event stream out of step and
  // left the LOCKED state reachable only through the explicit lock route.
  const finalStatus = lockAfterApproval ? "LOCKED" : "APPROVED";

  const [transition] = await tx
    .update(timesheetPeriods)
    .set({
      status: finalStatus,
      approvedAt: now,
      approvedByMembershipId: approverActor.membershipId,
      lockedAt: lockAfterApproval ? now : null,
      eventSeq: sql`${timesheetPeriods.eventSeq} + ${emitCount}`,
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
      status: "APPROVED",
      approvedByMembershipId: approverActor.membershipId,
      approvedAt: now,
      lockedAt: lockAfterApproval ? now : null,
      lockedByMembershipId: lockAfterApproval
        ? approverActor.membershipId
        : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(timesheets.timesheetPeriodId, periodId),
        eq(timesheets.orgId, u.orgId),
        isNull(timesheets.voidedAt),
      ),
    );

  const billableEntries = await tx
    .select()
    .from(timesheets)
    .where(
      and(
        eq(timesheets.timesheetPeriodId, periodId),
        eq(timesheets.orgId, u.orgId),
        eq(timesheets.isBillable, true),
        isNull(timesheets.billRate),
        isNull(timesheets.voidedAt),
      ),
    );

  const resolvedRates = await deps.rateResolver.resolveMany(
    u.orgId,
    billableEntries.map((entry) => ({
      projectId: entry.projectId,
      userMembershipId: entry.userMembershipId,
      ticketId: entry.ticketId,
      date: entry.date,
    })),
  );

  type RateGroup = {
    billRate: string;
    costRate: string | null;
    currency: string;
    rateSource: (typeof resolvedRates)[number]["source"];
    ids: number[];
  };
  const rateGroups = new Map<string, RateGroup>();
  for (const [i, entry] of billableEntries.entries()) {
    const resolved = resolvedRates[i];
    if (!resolved || resolved.billRate === null) continue;
    const groupKey = `${resolved.billRate}:${resolved.costRate ?? ""}:${resolved.currency}:${resolved.source ?? ""}`;
    const group = rateGroups.get(groupKey) ?? {
      billRate: resolved.billRate.toString(),
      costRate:
        resolved.costRate !== null ? resolved.costRate.toString() : null,
      currency: resolved.currency,
      rateSource: resolved.source,
      ids: [],
    };
    group.ids.push(entry.id);
    rateGroups.set(groupKey, group);
  }

  for (const group of rateGroups.values()) {
    await tx
      .update(timesheets)
      .set({
        billRate: group.billRate,
        costRate: group.costRate,
        currency: group.currency,
        rateSource: group.rateSource,
        updatedAt: now,
      })
      .where(
        and(
          eq(timesheets.orgId, u.orgId),
          inArray(timesheets.id, group.ids),
        ),
      );
  }

  await deps.audit.record(tx, {
    orgId: u.orgId,
    actorMembershipId: actingMembershipId(u.principal),
    entityType: "period",
    entityId: periodId.toString(),
    action: "period.approved",
    after: { status: finalStatus },
  });

  if (transition && ownerUserId) {
    const base = transition.eventSeq - emitCount + 1;

    await emitPeriodLifecycleEvent(tx, {
      eventType: TIMESHEET_LIFECYCLE_EVENTS.approved,
      orgId: u.orgId,
      periodId,
      eventSeq: base,
      occurredAt: now,
      // The approval event reports the approval, whatever the lock did next.
      payload: lifecyclePayload(
        u.orgId,
        periodId,
        { ...transition, status: "APPROVED" },
        ownerUserId,
        u.userId,
        now,
        null,
      ),
    });

    if (lockAfterApproval) {
      await emitPeriodLifecycleEvent(tx, {
        eventType: TIMESHEET_LIFECYCLE_EVENTS.locked,
        orgId: u.orgId,
        periodId,
        eventSeq: transition.eventSeq,
        occurredAt: now,
        // Report the status this transition just established rather than
        // whatever the driver echoed back, so the event cannot drift from it.
        payload: lifecyclePayload(
          u.orgId,
          periodId,
          { ...transition, status: finalStatus },
          ownerUserId,
          u.userId,
          now,
          null,
        ),
      });
    }
  }
}

export async function applyBulkApproval(
  tx: ApprovalTx,
  deps: ApprovalTransitionDeps,
  u: CurrentUserContext,
  ids: readonly number[],
  approval: {
    readonly approverActor: Pick<OrganizationActor, "membershipId">;
    readonly lockAfterApproval: boolean;
    readonly owners: ReadonlyMap<number, string>;
    readonly now: Date;
  },
): Promise<number[]> {
  const { approverActor, lockAfterApproval, owners, now } = approval;
  const emitCount = lockAfterApproval ? 2 : 1;
  // See applyApproval: a period that gets lockedAt stamped must carry LOCKED.
  const finalStatus = lockAfterApproval ? "LOCKED" : "APPROVED";

  const transitions = await tx
    .update(timesheetPeriods)
    .set({
      status: finalStatus,
      approvedAt: now,
      approvedByMembershipId: approverActor.membershipId,
      lockedAt: lockAfterApproval ? now : null,
      eventSeq: sql`${timesheetPeriods.eventSeq} + ${emitCount}`,
      updatedAt: now,
    })
    .where(
      and(
        eq(timesheetPeriods.orgId, u.orgId),
        inArray(timesheetPeriods.id, [...ids]),
        eq(timesheetPeriods.status, "SUBMITTED"),
      ),
    )
    .returning({ ...LIFECYCLE_RETURNING, id: timesheetPeriods.id });
  const periodIds = transitions.map((transition) => transition.id);
  if (periodIds.length === 0) return periodIds;

  await tx
    .update(timesheets)
    .set({
      status: "APPROVED",
      approvedByMembershipId: approverActor.membershipId,
      approvedAt: now,
      lockedAt: lockAfterApproval ? now : null,
      lockedByMembershipId: lockAfterApproval ? approverActor.membershipId : null,
      updatedAt: now,
    })
    .where(
      and(
        inArray(timesheets.timesheetPeriodId, periodIds),
        eq(timesheets.orgId, u.orgId),
        isNull(timesheets.voidedAt),
      ),
    );

  const billableEntries = await tx
    .select()
    .from(timesheets)
    .where(
      and(
        inArray(timesheets.timesheetPeriodId, periodIds),
        eq(timesheets.orgId, u.orgId),
        eq(timesheets.isBillable, true),
        isNull(timesheets.billRate),
        isNull(timesheets.voidedAt),
      ),
    );

  const resolvedRates = await deps.rateResolver.resolveMany(
    u.orgId,
    billableEntries.map((entry) => ({
      projectId: entry.projectId,
      userMembershipId: entry.userMembershipId,
      ticketId: entry.ticketId,
      date: entry.date,
    })),
  );

  const rateRows: Array<{ key: number; values: [string, string | null, string, string | null] }> = [];
  for (const [i, entry] of billableEntries.entries()) {
    const resolved = resolvedRates[i];
    if (!resolved || resolved.billRate === null) continue;
    rateRows.push({
      key: entry.id,
      values: [
        resolved.billRate.toString(),
        resolved.costRate !== null ? resolved.costRate.toString() : null,
        resolved.currency,
        resolved.source,
      ],
    });
  }
  if (rateRows.length > 0) {
    await bulkUpdateFromValues(tx, {
      table: timesheets,
      orgId: u.orgId,
      key: { column: "id", type: "integer" },
      columns: [
        { column: "bill_rate", type: "numeric(10, 2)" },
        { column: "cost_rate", type: "numeric(10, 2)" },
        { column: "currency", type: "text" },
        { column: "rate_source", type: "timesheet_rate_source" },
      ],
      rows: rateRows,
      touch: ["updated_at"],
    });
  }

  const actorMembershipId = actingMembershipId(u.principal);
  await deps.audit.recordMany(
    tx,
    periodIds.map((id) => ({
      orgId: u.orgId,
      actorMembershipId,
      entityType: "period",
      entityId: id.toString(),
      action: "period.approved",
      after: { status: finalStatus },
    })),
  );

  const events: EmitPeriodLifecycleInput[] = [];
  for (const transition of transitions) {
    const ownerUserId = periodOwnerUserIdOrWarn(owners, transition.userMembershipId, {
      orgId: u.orgId,
      periodId: transition.id,
      operation: "bulk-approve",
    });
    if (!ownerUserId) continue;
    events.push({
      eventType: TIMESHEET_LIFECYCLE_EVENTS.approved,
      orgId: u.orgId,
      periodId: transition.id,
      eventSeq: transition.eventSeq - emitCount + 1,
      occurredAt: now,
      payload: lifecyclePayload(
        u.orgId,
        transition.id,
        { ...transition, status: "APPROVED" },
        ownerUserId,
        u.userId,
        now,
        null,
      ),
    });
    if (lockAfterApproval) {
      events.push({
        eventType: TIMESHEET_LIFECYCLE_EVENTS.locked,
        orgId: u.orgId,
        periodId: transition.id,
        eventSeq: transition.eventSeq,
        occurredAt: now,
        payload: lifecyclePayload(
          u.orgId,
          transition.id,
          { ...transition, status: finalStatus },
          ownerUserId,
          u.userId,
          now,
          null,
        ),
      });
    }
  }
  await emitPeriodLifecycleEvents(tx, events);
  return periodIds;
}
