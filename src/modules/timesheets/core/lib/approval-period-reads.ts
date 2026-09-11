import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../../../../db/drizzle.module";
import { organizationMembers, timesheetPeriods, users } from "../../../../db/schema";

/*
  The two period reads behind the approvals list and the approve response,
  with the owner and approver joined tenant-matched through two aliases of
  `organization_members`. Both are bounded: the list keyset-paginates on
  (submitted_at, id) and the single read is by id.
*/

/** One keyset page of periods (plus one row, to know whether there is a next). */
export async function listApprovalRows(
  db: Db,
  conditions: Parameters<typeof and>,
  limit: number,
) {
  const approverMember = alias(organizationMembers, "approver_member");
  const ownerMember = alias(organizationMembers, "owner_member");

  return db
    .select({
      id: timesheetPeriods.id,
      orgId: timesheetPeriods.orgId,
      userMembershipId: timesheetPeriods.userMembershipId,
      periodStart: timesheetPeriods.periodStart,
      periodEnd: timesheetPeriods.periodEnd,
      status: timesheetPeriods.status,
      totalHours: timesheetPeriods.totalHours,
      billableHours: timesheetPeriods.billableHours,
      nonBillableHours: timesheetPeriods.nonBillableHours,
      submittedAt: timesheetPeriods.submittedAt,
      approvedAt: timesheetPeriods.approvedAt,
      rejectedAt: timesheetPeriods.rejectedAt,
      lockedAt: timesheetPeriods.lockedAt,
      currentApproverMembershipId: timesheetPeriods.currentApproverMembershipId,
      approvedBy: approverMember.userId,
      rejectionReason: timesheetPeriods.rejectionReason,
      createdAt: timesheetPeriods.createdAt,
      updatedAt: timesheetPeriods.updatedAt,
      userEmail: users.email,
      userName: users.name,
    })
    .from(timesheetPeriods)
    .leftJoin(ownerMember, and(
      eq(timesheetPeriods.orgId, ownerMember.orgId),
      eq(timesheetPeriods.userMembershipId, ownerMember.id),
    ))
    .leftJoin(users, eq(ownerMember.userId, users.id))
    .leftJoin(
      approverMember,
      and(
        eq(timesheetPeriods.orgId, approverMember.orgId),
        eq(timesheetPeriods.approvedByMembershipId, approverMember.id),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(timesheetPeriods.submittedAt), desc(timesheetPeriods.id))
    .limit(limit + 1);
}

/** The period as the approve route returns it, read back after the approval committed. */
export async function readApprovedPeriod(db: Db, orgId: string, periodId: number) {
  const approverMember = alias(organizationMembers, "approver_member");
  const ownerMember = alias(organizationMembers, "owner_member");

  const [updated] = await db
    .select({
      id: timesheetPeriods.id,
      orgId: timesheetPeriods.orgId,
      userMembershipId: timesheetPeriods.userMembershipId,
      periodStart: timesheetPeriods.periodStart,
      periodEnd: timesheetPeriods.periodEnd,
      status: timesheetPeriods.status,
      totalHours: timesheetPeriods.totalHours,
      billableHours: timesheetPeriods.billableHours,
      nonBillableHours: timesheetPeriods.nonBillableHours,
      submittedAt: timesheetPeriods.submittedAt,
      approvedAt: timesheetPeriods.approvedAt,
      rejectedAt: timesheetPeriods.rejectedAt,
      lockedAt: timesheetPeriods.lockedAt,
      currentApproverMembershipId: timesheetPeriods.currentApproverMembershipId,
      approvedBy: approverMember.userId,
      rejectionReason: timesheetPeriods.rejectionReason,
      createdAt: timesheetPeriods.createdAt,
      updatedAt: timesheetPeriods.updatedAt,
      userEmail: users.email,
      userName: users.name,
    })
    .from(timesheetPeriods)
    .leftJoin(ownerMember, and(
      eq(timesheetPeriods.orgId, ownerMember.orgId),
      eq(timesheetPeriods.userMembershipId, ownerMember.id),
    ))
    .leftJoin(users, eq(ownerMember.userId, users.id))
    .leftJoin(
      approverMember,
      and(
        eq(timesheetPeriods.orgId, approverMember.orgId),
        eq(timesheetPeriods.approvedByMembershipId, approverMember.id),
      ),
    )
    .where(
      and(
        eq(timesheetPeriods.id, periodId),
        eq(timesheetPeriods.orgId, orgId),
      ),
    )
    .limit(1);

  return updated;
}
