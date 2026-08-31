import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { chatChannelMembers, chatMessages, chatPinnedMessages } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";

@Injectable()
export class ChatPinsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entities: EntityReferenceService,
  ) {}

  private async assertMember(channelId: number, actor: EntityActor) {
    const where = actor.membershipId
      ? and(
          eq(chatChannelMembers.orgId, actor.orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, actor.membershipId),
        )
      : and(
          eq(chatChannelMembers.orgId, actor.orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, actor.userId),
        );
    const member = await this.db.query.chatChannelMembers.findFirst({ where });
    if (!member) throw new ForbiddenException("You are not a member of this channel");
    return member;
  }

  async listPins(channelId: number, actor: EntityActor) {
    await this.assertMember(channelId, actor);
    const rows = await this.db.query.chatPinnedMessages.findMany({
      where: and(
        eq(chatPinnedMessages.orgId, actor.orgId),
        eq(chatPinnedMessages.channelId, channelId),
      ),
      orderBy: [desc(chatPinnedMessages.pinnedAt)],
      limit: 100,
      with: {
        message: {
          with: {
            sender: { columns: { id: true, name: true, image: true } },
            attachments: true,
          },
        },
        pinnedByUser: { columns: { id: true, name: true } },
      },
    });

    const resolved = await this.entities.withResolvedReferences(
      actor,
      rows.map((row) => row.message),
    );
    return rows.map((row, index) => ({ ...row, message: resolved[index] }));
  }

  async pin(channelId: number, messageId: number, actor: EntityActor) {
    await this.assertMember(channelId, actor);
    const message = await this.db.query.chatMessages.findFirst({
      where: and(
        eq(chatMessages.orgId, actor.orgId),
        eq(chatMessages.id, messageId),
        eq(chatMessages.channelId, channelId),
        eq(chatMessages.isDeleted, false),
      ),
    });
    if (!message) throw new NotFoundException("Message not found");
    await this.db.insert(chatPinnedMessages).values({
      orgId: actor.orgId,
      channelId,
      messageId,
      pinnedBy: actor.userId,
      pinnedByMembershipId: actor.membershipId ?? null,
    }).onConflictDoNothing();
    return { ok: true };
  }

  async unpin(channelId: number, messageId: number, actor: EntityActor) {
    await this.assertMember(channelId, actor);
    await this.db.delete(chatPinnedMessages).where(and(
      eq(chatPinnedMessages.orgId, actor.orgId),
      eq(chatPinnedMessages.channelId, channelId),
      eq(chatPinnedMessages.messageId, messageId),
    ));
    return { ok: true };
  }
}
