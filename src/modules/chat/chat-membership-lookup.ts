import { and, eq } from "drizzle-orm";
import { chatChannelMembers, organizationMembers } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

export async function resolveMembershipId(
  db: Db,
  orgId: string,
  userId: string,
): Promise<number | null> {
  const row = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.userId, userId),
      eq(organizationMembers.status, "ACTIVE"),
    ),
    columns: { id: true },
  });
  return row?.id ?? null;
}

export async function isChannelMember(
  db: Db,
  channelId: number,
  orgId: string,
  membershipId: number,
): Promise<boolean> {
  const member = await db.query.chatChannelMembers.findFirst({
    where: and(
      eq(chatChannelMembers.orgId, orgId),
      eq(chatChannelMembers.channelId, channelId),
      eq(chatChannelMembers.membershipId, membershipId),
    ),
    columns: { id: true },
  });
  return Boolean(member);
}
