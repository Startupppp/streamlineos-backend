import { and, desc, eq, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../../../../db/drizzle.module";
import {
  organizationMembers,
  timesheetPeriods,
  users,
} from "../../../../db/schema";
import {
  descKeyset,
  type DescKeysetPosition,
} from "../../../../common/pagination/desc-keyset";

export type TimesheetInboxRow = {
  id: number;
  userMembershipId: number | null;
  userName: string | null;
  userEmail: string | null;
  periodStart: string;
  periodEnd: string;
  totalHours: string;
  submittedAt: Date;
  approvalDueAt: Date | null;
};

export async function listApprovalInboxRows(
  db: Db,
  orgId: string,
  approverMembershipId: number,
  limit: number,
  cursor: DescKeysetPosition | null,
): Promise<TimesheetInboxRow[]> {
  const ownerMember = alias(organizationMembers, "owner_member");

  const rows = await db
    .select({
      id: timesheetPeriods.id,
      userMembershipId: timesheetPeriods.userMembershipId,
      periodStart: timesheetPeriods.periodStart,
      periodEnd: timesheetPeriods.periodEnd,
      totalHours: timesheetPeriods.totalHours,
      submittedAt: timesheetPeriods.submittedAt,
      approvalDueAt: timesheetPeriods.approvalDueAt,
      userEmail: users.email,
      userName: users.name,
    })
    .from(timesheetPeriods)
    .leftJoin(
      ownerMember,
      and(
        eq(timesheetPeriods.orgId, ownerMember.orgId),
        eq(timesheetPeriods.userMembershipId, ownerMember.id),
      ),
    )
    .leftJoin(users, eq(ownerMember.userId, users.id))
    .where(
      and(
        eq(timesheetPeriods.orgId, orgId),
        eq(timesheetPeriods.status, "SUBMITTED"),
        eq(timesheetPeriods.currentApproverMembershipId, approverMembershipId),
        isNotNull(timesheetPeriods.submittedAt),
        descKeyset(timesheetPeriods.submittedAt, timesheetPeriods.id, cursor),
      ),
    )
    .orderBy(desc(timesheetPeriods.submittedAt), desc(timesheetPeriods.id))
    .limit(limit);

  return rows.flatMap((row) =>
    row.submittedAt === null ? [] : [{ ...row, submittedAt: row.submittedAt }],
  );
}

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
      approvalRoute: timesheetPeriods.approvalRoute,
      approvalDueAt: timesheetPeriods.approvalDueAt,
      approvalEscalatedAt: timesheetPeriods.approvalEscalatedAt,
      approvedBy: approverMember.userId,
      rejectionReason: timesheetPeriods.rejectionReason,
      createdAt: timesheetPeriods.createdAt,
      updatedAt: timesheetPeriods.updatedAt,
      userEmail: users.email,
      userName: users.name,
    })
    .from(timesheetPeriods)
    .leftJoin(
      ownerMember,
      and(
        eq(timesheetPeriods.orgId, ownerMember.orgId),
        eq(timesheetPeriods.userMembershipId, ownerMember.id),
      ),
    )
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

export async function readApprovedPeriod(
  db: Db,
  orgId: string,
  periodId: number,
) {
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
      approvalRoute: timesheetPeriods.approvalRoute,
      approvalDueAt: timesheetPeriods.approvalDueAt,
      approvalEscalatedAt: timesheetPeriods.approvalEscalatedAt,
      approvedBy: approverMember.userId,
      rejectionReason: timesheetPeriods.rejectionReason,
      createdAt: timesheetPeriods.createdAt,
      updatedAt: timesheetPeriods.updatedAt,
      userEmail: users.email,
      userName: users.name,
    })
    .from(timesheetPeriods)
    .leftJoin(
      ownerMember,
      and(
        eq(timesheetPeriods.orgId, ownerMember.orgId),
        eq(timesheetPeriods.userMembershipId, ownerMember.id),
      ),
    )
    .leftJoin(users, eq(ownerMember.userId, users.id))
    .leftJoin(
      approverMember,
      and(
        eq(timesheetPeriods.orgId, approverMember.orgId),
        eq(timesheetPeriods.approvedByMembershipId, approverMember.id),
      ),
    )
    .where(
      and(eq(timesheetPeriods.id, periodId), eq(timesheetPeriods.orgId, orgId)),
    )
    .limit(1);

  return updated;
}
