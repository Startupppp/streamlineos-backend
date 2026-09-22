import { and, eq, inArray } from "drizzle-orm";
import { logger } from "../../../../common/logger/logger.service";
import { organizationMembers, timesheetPeriods } from "../../../../db/schema";
import type { DbOrTx } from "../../../../common/rbac/access-invalidate";
import type { PeriodLifecycleEvent } from "../events/timesheet-lifecycle.events";

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
