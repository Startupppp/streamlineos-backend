import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { timesheetPeriods, timesheets } from "../../../../db/schema";
import { actingMembershipId } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { OrganizationActor } from "../../../../common/organization/organization-actor";
import type { RateResolverService } from "../rate-resolver.service";
import type { TimesheetsAuditService } from "../timesheets-audit.service";
import {
  TIMESHEET_LIFECYCLE_EVENTS,
  emitPeriodLifecycleEvent,
} from "../events/timesheet-lifecycle.events";
import { LIFECYCLE_RETURNING, lifecyclePayload } from "./approval-lifecycle";

/** The transaction `ApprovalsService.approveSinglePeriod` opens. */
type ApprovalTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The service's own collaborators, passed in rather than reached for. */
export interface ApprovalTransitionDeps {
  readonly rateResolver: RateResolverService;
  readonly audit: TimesheetsAuditService;
}

/**
 * The approval itself, inside the caller's transaction: the period and its
 * entries move to APPROVED (and locked, when the org locks on approval), each
 * uninvoiced billable entry is stamped with its resolved rate, the audit row is
 * written and the lifecycle events are emitted.
 *
 * The guard, the actor, the settings and the owner lookup all happen in
 * `approveSinglePeriod` before this runs, and the notice after it commits;
 * see the comments there for why `emitCount` claims two sequence numbers.
 */
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

  const [transition] = await tx
    .update(timesheetPeriods)
    .set({
      status: "APPROVED",
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
      ),
    )
    .returning(LIFECYCLE_RETURNING);

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
    after: { status: "APPROVED" },
  });

  if (transition && ownerUserId) {
    const base = transition.eventSeq - emitCount + 1;
    const payload = lifecyclePayload(u.orgId, periodId, transition, ownerUserId, u.userId, now, null);

    await emitPeriodLifecycleEvent(tx, {
      eventType: TIMESHEET_LIFECYCLE_EVENTS.approved,
      orgId: u.orgId,
      periodId,
      eventSeq: base,
      occurredAt: now,
      payload,
    });

    if (lockAfterApproval) {
      await emitPeriodLifecycleEvent(tx, {
        eventType: TIMESHEET_LIFECYCLE_EVENTS.locked,
        orgId: u.orgId,
        periodId,
        eventSeq: transition.eventSeq,
        occurredAt: now,
        payload,
      });
    }
  }
}
