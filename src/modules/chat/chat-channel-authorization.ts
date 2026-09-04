import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { chatChannels, chatChannelMembers, organizationMembers } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

/**
 * The membership predicate every channel operation re-asserts, and the admin
 * escalation built on it.
 *
 * `chat-channel-members-implementation.ts` registered a file-size exception whose
 * own removal trigger was "the authorization predicate is extracted for reuse
 * elsewhere". This is that extraction: the predicate is the single rule the
 * whole surface shares, so it is the one thing worth naming separately — a
 * private channel answers 404 rather than 403 to a non-member (never confirming
 * the channel exists), while a public one answers 403.
 */

export async function resolveOrgMembership(db: Db, orgId: string, userId: string): Promise<number> {
  const membership = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.userId, userId),
      eq(organizationMembers.status, "ACTIVE"),
    ),
    columns: { id: true },
  });
  if (!membership) throw new ForbiddenException("User is not an active organization member");
  return membership.id;
}

export async function assertChannelMember(
  db: Db,
  channelId: number,
  userId: string,
  orgId: string,
): Promise<{ membershipId: number; role: string }> {
  const channel = await db.query.chatChannels.findFirst({
    where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
    columns: { id: true, isPrivate: true },
  });
  if (!channel) throw new NotFoundException("Channel not found");
  const membershipId = await resolveOrgMembership(db, orgId, userId);
  const member = await db.query.chatChannelMembers.findFirst({
    where: and(
      eq(chatChannelMembers.orgId, orgId),
      eq(chatChannelMembers.channelId, channelId),
      eq(chatChannelMembers.membershipId, membershipId),
    ),
    columns: { role: true },
  });
  if (!member) {
    if (channel.isPrivate) throw new NotFoundException("Channel not found");
    throw new ForbiddenException("You are not a member of this channel");
  }
  return { membershipId, role: member.role };
}

export async function assertChannelAdmin(db: Db, channelId: number, userId: string, orgId: string): Promise<number> {
  const { membershipId, role } = await assertChannelMember(db, channelId, userId, orgId);
  if (role !== "ADMIN") throw new ForbiddenException("Only channel admins can perform this action");
  return membershipId;
}
