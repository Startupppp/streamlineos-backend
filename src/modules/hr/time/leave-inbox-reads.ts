import { and, desc, eq } from "drizzle-orm";
import { leaveRequests, leaveTypes, users } from "../../../db/schema";
import { descKeyset, type DescKeysetPosition } from "../../../common/pagination/desc-keyset";
import type { Db } from "../../../db/drizzle.module";

export type LeaveInboxRow = {
  id: number;
  startDate: string;
  endDate: string;
  createdAt: Date;
  leaveTypeName: string | null;
  userId: string | null;
  userName: string | null;
  userFirstName: string | null;
  userLastName: string | null;
  userImage: string | null;
};

export async function pendingLeavesRoutedToPage(
  db: Db,
  orgId: string,
  approverMembershipId: number,
  limit: number,
  cursor: DescKeysetPosition | null,
): Promise<LeaveInboxRow[]> {
  const rows = await db
    .select({
      id: leaveRequests.id,
      startDate: leaveRequests.startDate,
      endDate: leaveRequests.endDate,
      createdAt: leaveRequests.createdAt,
      leaveTypeName: leaveTypes.name,
      userId: users.id,
      userName: users.name,
      userFirstName: users.firstName,
      userLastName: users.lastName,
      userImage: users.image,
    })
    .from(leaveRequests)
    .leftJoin(
      leaveTypes,
      and(
        eq(leaveTypes.orgId, leaveRequests.orgId),
        eq(leaveTypes.id, leaveRequests.leaveTypeId),
      ),
    )
    .leftJoin(users, eq(users.id, leaveRequests.userId))
    .where(
      and(
        eq(leaveRequests.orgId, orgId),
        eq(leaveRequests.status, "PENDING"),
        eq(leaveRequests.approverMembershipId, approverMembershipId),
        descKeyset(leaveRequests.createdAt, leaveRequests.id, cursor),
      ),
    )
    .orderBy(desc(leaveRequests.createdAt), desc(leaveRequests.id))
    .limit(limit);

  return rows;
}
