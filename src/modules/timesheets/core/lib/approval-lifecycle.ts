import { and, eq, inArray } from "drizzle-orm";
import { logger } from "../../../../common/logger/logger.service";
import { organizationMembers, timesheetPeriods } from "../../../../db/schema";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import type { PeriodLifecycleEvent } from "../events/timesheet-lifecycle.events";

/**
 * Everything a lifecycle event needs, returned by the UPDATE that performs the
 * transition. `event_seq` is only correct as read back from the statement that
 * incremented it — selecting it separately races another transition.
 *
 * Exported because the transitions live in more than one service
 * (`ApprovalsBulkService`, `PeriodsService`, `PeriodsSubmitService`), and what
 * an event carries should be written down once.
 *
 * The worker comes back as a membership: `timesheet_periods.user_id` was
 * dropped by the actor cutover (0715). The event contract still names the
 * worker by user id, which `membershipUserIds` reads back through it.
 */
export const LIFECYCLE_RETURNING = {
  eventSeq: timesheetPeriods.eventSeq,
  userMembershipId: timesheetPeriods.userMembershipId,
  periodStart: timesheetPeriods.periodStart,
  periodEnd: timesheetPeriods.periodEnd,
  status: timesheetPeriods.status,
  totalHours: timesheetPeriods.totalHours,
  billableHours: timesheetPeriods.billableHours,
  nonBillableHours: timesheetPeriods.nonBillableHours,
} as const;

export type LifecycleRow = {
  periodStart: string;
  periodEnd: string;
  status: PeriodLifecycleEvent["status"];
  totalHours: string;
  billableHours: string;
  nonBillableHours: string;
};

export function lifecyclePayload(
  orgId: string,
  periodId: number,
  row: LifecycleRow,
  ownerUserId: string,
  actorUserId: string,
  occurredAt: Date,
  reason: string | null,
): PeriodLifecycleEvent {
  return {
    organization_id: orgId,
    period_id: periodId,
    user_id: ownerUserId,
    period_start: row.periodStart,
    period_end: row.periodEnd,
    status: row.status,
    total_hours: row.totalHours,
    billable_hours: row.billableHours,
    non_billable_hours: row.nonBillableHours,
    actor_user_id: actorUserId,
    reason,
    occurred_at: occurredAt.toISOString(),
  };
}

/**
 * The user id behind each membership, read inside `orgId` only.
 *
 * The lifecycle event contract and the notification pipeline both name people
 * by user id, while since the actor cutover a period knows its worker and its
 * approver only as memberships. Bounded by the ids asked for.
 */
export async function membershipUserIds(
  db: DbOrTx,
  orgId: string,
  membershipIds: readonly (number | null)[],
): Promise<Map<number, string>> {
  const ids = [...new Set(membershipIds.filter((id): id is number => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: organizationMembers.id, userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.id, ids)))
    .limit(ids.length);
  return new Map(rows.map((r) => [r.id, r.userId]));
}

/**
 * The worker's user id for a lifecycle event or notice, or null.
 *
 * The event schema requires `user_id` and notifications are addressed to
 * users, but since the actor cutover a period knows its worker only as a
 * membership, and that membership can stop resolving: removing a member sets
 * it to null. That is a reason to announce nothing about this one period, not
 * to fail the approval, rejection, submission or lock it belongs to, which
 * used to surface as a 500 and roll the transition back. Callers commit the
 * transition and skip only the event and the notice; the skip is logged here
 * so it can be reconciled. A skipped event leaves a gap in the period's
 * `event_seq`, which the outbox's UNIQUE index does not mind.
 */
export function periodOwnerUserIdOrWarn(
  owners: ReadonlyMap<number, string>,
  membershipId: number | null,
  context: { orgId: string; periodId: number; operation: string },
): string | null {
  const userId = membershipId === null ? undefined : owners.get(membershipId);
  if (userId) return userId;
  logger.warn(
    "timesheets: period owner membership does not resolve; lifecycle event and notice skipped",
    {
      orgId: context.orgId,
      periodId: context.periodId,
      ownerMembershipId: membershipId,
      operation: context.operation,
    },
  );
  return null;
}
