import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import {
  chatAttachments,
  chatChannelMembers,
  chatChannels,
  chatMessages,
} from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import { DRIZZLE } from "../../db/drizzle.constants";
import { channelHighWaterMark } from "./chat-channel-member-state";
import type { UpdateChannelInput } from "./dto/chat.schemas";
import { assertUsersInOrg } from "../../common/tenant/org-membership";
import { PAGE_SIZE_CAP } from "../../common/pagination/list-query.schema";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import { randomUUID } from "node:crypto";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import {
  assertChannelAccess,
  assertChannelAdmin,
  assertChannelMember,
  assertEntityAccess,
  resolveOrgMembership,
} from "./chat-channel-authorization";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { REALTIME_TOKEN_REVOCATION_EVENT } from "../realtime/realtime-token-revocation";
import {
  CHANNEL_MEMBER_COLUMNS,
  CHANNEL_MEMBER_MEMBERSHIP_WITH,
  flattenChannelMember,
} from "./chat-channel-member-shape";
import { ChatMessagesService } from "./chat-messages.service";

@Injectable()
export class ChatChannelMembersImplementation {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entities: EntityReferenceService,
    @Optional() private readonly chatMessages?: ChatMessagesService,
  ) {}

  async assertChannelMembership(channelId: number, actor: EntityActor): Promise<void> {
    await assertChannelAccess(this.db, this.entities, channelId, actor);
  }

  async getChannel(channelId: number, actor: EntityActor) {
    const orgId = actor.orgId;
    await assertChannelAccess(this.db, this.entities, channelId, actor);

    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)),
      with: {
        members: {
          columns: CHANNEL_MEMBER_COLUMNS,
          with: { membership: CHANNEL_MEMBER_MEMBERSHIP_WITH },
        },
      },
    });

    if (!channel) return null;
    return { ...channel, members: channel.members.map(flattenChannelMember) };
  }

  async listMembers(channelId: number, actor: EntityActor, cursor?: number, limit?: number) {
    const orgId = actor.orgId;
    await assertChannelAccess(this.db, this.entities, channelId, actor);

    const PAGE_SIZE = Math.min(limit ?? 50, PAGE_SIZE_CAP);

    const rows = await this.db.query.chatChannelMembers.findMany({
      where: and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        cursor !== undefined ? gt(chatChannelMembers.id, cursor) : undefined,
      ),
      orderBy: [asc(chatChannelMembers.id)],
      limit: PAGE_SIZE + 1,
      columns: CHANNEL_MEMBER_COLUMNS,
      with: { membership: CHANNEL_MEMBER_MEMBERSHIP_WITH },
    });

    const hasMore = rows.length > PAGE_SIZE;
    const pageSlice = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const nextCursor = hasMore ? (pageSlice[pageSlice.length - 1]?.id ?? null) : null;
    return { members: pageSlice.map(flattenChannelMember), nextCursor };
  }

  async addMember(channelId: number, targetUserId: string, requesterId: string, orgId: string) {
    await assertChannelAdmin(this.db, channelId, requesterId, orgId);

    await assertUsersInOrg(this.db, orgId, [targetUserId]);
    const targetMembershipId = await resolveOrgMembership(this.db, orgId, targetUserId);

    const existing = await this.db.query.chatChannelMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, targetMembershipId),
      ),
    });

    if (existing) throw new ConflictException("User is already a member of this channel");

    await this.db.insert(chatChannelMembers).values({
      orgId,
      channelId,
      membershipId: targetMembershipId,
      role: "MEMBER",
      lastReadPosition: channelHighWaterMark(channelId, orgId),
    });

    return { ok: true };
  }

  async removeMember(channelId: number, targetUserId: string, requesterId: string, orgId: string) {
    const { role } = await assertChannelMember(this.db, channelId, requesterId, orgId);

    if (requesterId !== targetUserId && role !== "ADMIN")
      throw new ForbiddenException("Only channel admins can remove other members");

    const targetMembershipId = await resolveOrgMembership(this.db, orgId, targetUserId);
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx.delete(chatChannelMembers).where(
          and(
            eq(chatChannelMembers.orgId, orgId),
            eq(chatChannelMembers.channelId, channelId),
            eq(chatChannelMembers.membershipId, targetMembershipId),
          ),
        );
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "realtime.token-revocation",
          aggregateId: `${channelId}:${targetMembershipId}:${randomUUID()}`,
          aggregateVersion: 1,
          eventType: REALTIME_TOKEN_REVOCATION_EVENT,
          payload: { orgId, userId: targetUserId, channelId, membershipId: targetMembershipId },
          occurredAt: new Date(),
        });
      },
      { orgId },
    );

    return { ok: true };
  }

  async updateChannel(channelId: number, userId: string, body: UpdateChannelInput, orgId: string) {
    const { role } = await assertChannelMember(this.db, channelId, userId, orgId);
    if (role !== "ADMIN")
      throw new ForbiddenException("Only channel admins can update channel details");

    const updateData: Partial<typeof chatChannels.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) updateData.name = body.name;
    if (body.description !== undefined) updateData.description = body.description;
    if (body.avatarUrl !== undefined) updateData.avatarUrl = body.avatarUrl;

    await this.db
      .update(chatChannels)
      .set(updateData)
      .where(and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, orgId)));

    return { ok: true };
  }

  async joinOpenChannel(channelId: number, actor: EntityActor) {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(
        eq(chatChannels.id, channelId),
        eq(chatChannels.orgId, actor.orgId),
        eq(chatChannels.isArchived, false),
      ),
      columns: { id: true, type: true, entityType: true, entityId: true },
    });

    if (!channel) throw new NotFoundException("Channel not found");
    const actorMembershipId = await resolveOrgMembership(this.db, actor.orgId, actor.userId);

    if (channel.type !== "PUBLIC") {
      if (!channel.entityType || !channel.entityId)
        throw new NotFoundException("Channel not found");
      await assertEntityAccess(this.entities, channel, actor, "Channel not found");
    }

    const existing = await this.db.query.chatChannelMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(chatChannelMembers.orgId, actor.orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, actorMembershipId),
      ),
    });

    if (existing) return { ok: true };

    await this.db
      .insert(chatChannelMembers)
      .values({
        orgId: actor.orgId,
        channelId,
        membershipId: actorMembershipId,
        role: "MEMBER",
        lastReadPosition: channelHighWaterMark(channelId, actor.orgId),
      })
      .onConflictDoNothing();

    await this.chatMessages?.sendSystemMessage(
      channelId,
      actor.userId,
      actor.orgId,
      "joined the channel",
      { type: "join" },
    );

    return { ok: true };
  }

  async leaveChannel(channelId: number, userId: string, orgId: string) {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx.delete(chatChannelMembers).where(
          and(
            eq(chatChannelMembers.orgId, orgId),
            eq(chatChannelMembers.channelId, channelId),
            eq(chatChannelMembers.membershipId, membershipId),
          ),
        );
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "realtime.token-revocation",
          aggregateId: `${channelId}:${membershipId}:${randomUUID()}`,
          aggregateVersion: 1,
          eventType: REALTIME_TOKEN_REVOCATION_EVENT,
          payload: { orgId, userId, channelId, membershipId },
          occurredAt: new Date(),
        });
      },
      { orgId },
    );

    await this.chatMessages?.sendSystemMessage(
      channelId,
      userId,
      orgId,
      "left the channel",
      { type: "leave" },
    );

    return { ok: true };
  }

  async listChannelFiles(channelId: number, actor: EntityActor, cursor?: number, limit = 20) {
    const orgId = actor.orgId;
    await assertChannelAccess(this.db, this.entities, channelId, actor);
    const safeLimit = Math.min(Math.max(1, limit), 100);

    const rows = await this.db
      .select({
        id: chatAttachments.id,
        messageId: chatAttachments.messageId,
        fileName: chatAttachments.fileName,
        fileUrl: chatAttachments.fileUrl,
        fileKey: chatAttachments.fileKey,
        fileSize: chatAttachments.fileSize,
        mimeType: chatAttachments.mimeType,
        createdAt: chatAttachments.createdAt,
      })
      .from(chatAttachments)
      .innerJoin(chatMessages, eq(chatAttachments.messageId, chatMessages.id))
      .where(
        cursor !== undefined
          ? and(
              eq(chatAttachments.orgId, orgId),
              eq(chatMessages.orgId, orgId),
              eq(chatMessages.channelId, channelId),
              eq(chatMessages.isDeleted, false),
              lt(chatAttachments.id, cursor),
            )
          : and(
              eq(chatAttachments.orgId, orgId),
              eq(chatMessages.orgId, orgId),
              eq(chatMessages.channelId, channelId),
              eq(chatMessages.isDeleted, false),
            ),
      )
      .orderBy(desc(chatAttachments.id))
      .limit(safeLimit + 1);

    const hasMore = rows.length > safeLimit;
    if (hasMore) rows.pop();
    return { files: rows, nextCursor: hasMore ? rows[rows.length - 1]?.id : undefined };
  }

  async updateMemberRole(channelId: number, targetUserId: string, requesterId: string, orgId: string, role: string) {
    const { role: requesterRole } = await assertChannelMember(this.db, channelId, requesterId, orgId);
    if (requesterRole !== "ADMIN") throw new ForbiddenException("Only admins can change roles");

    const targetMembershipId = await resolveOrgMembership(this.db, orgId, targetUserId);
    if (!targetMembershipId) return { ok: true };

    await this.db.update(chatChannelMembers).set({ role }).where(
      and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, targetMembershipId),
      ),
    );
    return { ok: true };
  }
}
