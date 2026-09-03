/**
 * Who may act on a huddle, and whether the huddle exists in the caller's tenant at all.
 *
 * Every huddle route resolves the actor's membership before it touches a row, and every
 * huddle lookup is scoped by `orgId` so a cross-tenant id is a 404 rather than a 403 —
 * a 403 would confirm the id exists in some other organization.
 */
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { chatChannels, chatHuddles, organizationMembers } from "../../db/schema";
import type { Db } from "../../db/drizzle.types";
import { isChannelMember, resolveMembershipId } from "./chat-membership-lookup";

/**
 * The actor's membership id, or a refusal. A departed member keeps neither their channel
 * membership nor the right to open a huddle, so the active-membership check runs first.
 */
export async function assertHuddleChannelMember(
  db: Db,
  channelId: number,
  userId: string,
  orgId: string,
): Promise<number> {
  const membershipId = await resolveMembershipId(db, orgId, userId);
  if (membershipId === null) throw new ForbiddenException("Your membership is no longer active");
  const channel = await db.query.chatChannels.findFirst({
    where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
    columns: { isArchived: true },
  });
  if (!channel) throw new NotFoundException("Channel not found");
  const isMember = await isChannelMember(db, channelId, orgId, membershipId);
  if (!isMember) throw new ForbiddenException("You are not a member of this channel");
  if (channel.isArchived) throw new ForbiddenException("Channel is archived");
  return membershipId;
}

/** The live huddle with this id in this org, or a 404 carrying the caller's own wording. */
export async function requireActiveHuddle(db: Db, huddleId: number, orgId: string, notFoundMessage: string) {
  const huddle = await db.query.chatHuddles.findFirst({
    where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId), eq(chatHuddles.status, "active")),
  });
  if (!huddle) throw new NotFoundException(notFoundMessage);
  return huddle;
}

/**
 * A membership id regardless of status, deliberately unlike `resolveMembershipId`.
 * Leaving a call and being removed from one must still work for a member who has since
 * been deactivated, otherwise their tile is stuck in the mesh forever.
 */
export async function resolveMembershipIdAnyStatus(
  db: Db,
  orgId: string,
  userId: string,
): Promise<number | null> {
  const row = await db.query.organizationMembers.findFirst({
    where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)),
    columns: { id: true },
  });
  return row?.id ?? null;
}
