import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  chatChannelMembers,
  chatChannels,
  chatMessages,
  chatPinnedMessages,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import {
  SENDER_MEMBERSHIP_WITH_USER,
  flattenMessageSender,
} from "./chat-message-sender-shape";

@Injectable()
export class ChatPinsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entities: EntityReferenceService,
  ) {}

  private async assertMember(channelId: number, actor: EntityActor) {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, actor.orgId)),
      columns: { id: true, isPrivate: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");
    // A private channel must not confirm its own existence to a non-member.
    const deny = () =>
      channel.isPrivate
        ? new NotFoundException("Channel not found")
        : new ForbiddenException("You are not a member of this channel");
    if (!actor.membershipId) throw deny();
    const member = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.orgId, actor.orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, actor.membershipId),
      ),
    });
    if (!member) throw deny();
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
            senderMembership: SENDER_MEMBERSHIP_WITH_USER,
            attachments: true,
          },
        },
        pinnedByMembership: {
          columns: { userId: true },
          with: { user: { columns: { id: true, name: true } } },
        },
      },
    });

    const resolved = await this.entities.withResolvedReferences(
      actor,
      rows.map((row) => flattenMessageSender(row.message)),
    );
    return rows.map((row, index) => {
      const { pinnedByMembership, ...pin } = row;
      return {
        ...pin,
        pinnedBy: pinnedByMembership?.userId ?? null,
        message: resolved[index],
        pinnedByUser: pinnedByMembership?.user ?? null,
      };
    });
  }

  async pin(channelId: number, messageId: number, actor: EntityActor) {
    await this.assertMember(channelId, actor);
    const message = await this.db.query.chatMessages.findFirst({
      columns: { id: true },
      where: and(
        eq(chatMessages.orgId, actor.orgId),
        eq(chatMessages.id, messageId),
        eq(chatMessages.channelId, channelId),
        eq(chatMessages.isDeleted, false),
      ),
    });
    if (!message) throw new NotFoundException("Message not found");
    await this.db
      .insert(chatPinnedMessages)
      .values({
        orgId: actor.orgId,
        channelId,
        messageId,
        pinnedByMembershipId: actor.membershipId ?? null,
      })
      .onConflictDoNothing();
    return { ok: true };
  }

  async unpin(channelId: number, messageId: number, actor: EntityActor) {
    await this.assertMember(channelId, actor);
    await this.db
      .delete(chatPinnedMessages)
      .where(
        and(
          eq(chatPinnedMessages.orgId, actor.orgId),
          eq(chatPinnedMessages.channelId, channelId),
          eq(chatPinnedMessages.messageId, messageId),
        ),
      );
    return { ok: true };
  }
}
