import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { chatChannels, chatChannelMembers, organizationMembers } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import type { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";

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

export async function resolveOrgMembershipRow(
  db: Db,
  orgId: string,
  userId: string,
): Promise<{ membershipId: number; isOwner: boolean }> {
  const membership = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.userId, userId),
      eq(organizationMembers.status, "ACTIVE"),
    ),
    columns: { id: true, isOwner: true },
  });
  if (!membership) throw new ForbiddenException("User is not an active organization member");
  return { membershipId: membership.id, isOwner: membership.isOwner ?? false };
}

export async function resolveOrgMembership(db: Db, orgId: string, userId: string): Promise<number> {
  const { membershipId } = await resolveOrgMembershipRow(db, orgId, userId);
  return membershipId;
}

export interface ChannelEntityLink {
  entityType: string | null;
  entityId: string | null;
}

export interface ChannelMemberStanding extends ChannelEntityLink {
  membershipId: number;
  role: string;
  isOwner: boolean;
}

export function actorFromStanding(
  orgId: string,
  userId: string,
  standing: ChannelMemberStanding,
): EntityActor {
  return {
    orgId,
    userId,
    membershipId: standing.membershipId,
    isOrgOwner: standing.isOwner,
  };
}

export async function assertEntityAccess(
  entities: EntityReferenceService,
  link: ChannelEntityLink | null | undefined,
  actor: EntityActor,
  missMessage: string,
): Promise<void> {
  if (!link?.entityType || !link.entityId) return;
  const [resolution] = await entities.resolve(actor, [
    { type: link.entityType, id: link.entityId },
  ]);
  if (resolution?.status !== "resolved") throw new NotFoundException(missMessage);
}

export async function filterByEntityAccess<T>(
  entities: EntityReferenceService,
  rows: T[],
  actor: EntityActor,
  linkOf: (row: T) => ChannelEntityLink | null | undefined,
): Promise<T[]> {
  const linked: { position: number; type: string; id: string }[] = [];
  rows.forEach((row, position) => {
    const link = linkOf(row);
    if (!link?.entityType || !link.entityId) return;
    linked.push({ position, type: link.entityType, id: link.entityId });
  });
  if (linked.length === 0) return rows;

  const resolutions = await entities.resolve(
    actor,
    linked.map((entry) => ({ type: entry.type, id: entry.id })),
  );
  const denied = new Set<number>();
  linked.forEach((entry, position) => {
    if (resolutions[position]?.status !== "resolved") denied.add(entry.position);
  });
  if (denied.size === 0) return rows;
  return rows.filter((_row, position) => !denied.has(position));
}

export async function assertChannelMember(
  db: Db,
  channelId: number,
  userId: string,
  orgId: string,
): Promise<ChannelMemberStanding> {
  const channel = await db.query.chatChannels.findFirst({
    where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
    columns: { id: true, isPrivate: true, entityType: true, entityId: true },
  });
  if (!channel) throw new NotFoundException("Channel not found");
  const { membershipId, isOwner } = await resolveOrgMembershipRow(db, orgId, userId);
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
  return {
    membershipId,
    role: member.role,
    isOwner,
    entityType: channel.entityType ?? null,
    entityId: channel.entityId ?? null,
  };
}

export async function assertChannelAccess(
  db: Db,
  entities: EntityReferenceService,
  channelId: number,
  actor: EntityActor,
  missMessage = "Channel not found",
): Promise<ChannelMemberStanding> {
  const standing = await assertChannelMember(db, channelId, actor.userId, actor.orgId);
  await assertEntityAccess(entities, standing, actor, missMessage);
  return standing;
}

export async function assertChannelAdmin(db: Db, channelId: number, userId: string, orgId: string): Promise<number> {
  const { membershipId, role } = await assertChannelMember(db, channelId, userId, orgId);
  if (role !== "ADMIN") throw new ForbiddenException("Only channel admins can perform this action");
  return membershipId;
}
