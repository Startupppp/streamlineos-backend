import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { chatMessages } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AblyService } from "../realtime/ably.service";
import { isChannelMember, resolveMembershipId } from "./chat-membership-lookup";

@Injectable()
export class ChatMessageModerationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
  ) {}

  private async assertAuthor(messageId: number, userId: string, orgId: string) {
    const message = await this.db.query.chatMessages.findFirst({
      where: and(
        eq(chatMessages.id, messageId),
        eq(chatMessages.orgId, orgId),
        eq(chatMessages.isDeleted, false),
      ),
    });
    if (!message) throw new NotFoundException("Message not found");

    const membershipId = await resolveMembershipId(this.db, orgId, userId);
    if (
      membershipId === null ||
      !(await isChannelMember(this.db, message.channelId, orgId, membershipId))
    )
      throw new ForbiddenException("You are not a member of this channel");

    return { message, membershipId };
  }

  async edit(messageId: number, userId: string, orgId: string, content: string) {
    const { message, membershipId } = await this.assertAuthor(messageId, userId, orgId);

    if (message.senderMembershipId !== membershipId)
      throw new ForbiddenException("You can only edit your own messages");

    const updatedAt = new Date();
    await this.db
      .update(chatMessages)
      .set({ content: content.trim(), isEdited: true, updatedAt })
      .where(
        and(
          eq(chatMessages.orgId, orgId),
          eq(chatMessages.id, messageId),
          eq(chatMessages.senderMembershipId, membershipId),
        ),
      );

    void this.ably.publishChatEvent(orgId, message.channelId, "message:updated", {
      id: messageId,
      channelId: message.channelId,
      content: content.trim(),
      isEdited: true,
      updatedAt: updatedAt.toISOString(),
    });

    return { ok: true };
  }

  async remove(messageId: number, userId: string, isOrgAdmin: boolean, orgId: string) {
    const { message, membershipId } = await this.assertAuthor(messageId, userId, orgId);

    if (!isOrgAdmin && message.senderMembershipId !== membershipId)
      throw new ForbiddenException("You can only delete your own messages");

    await this.db
      .update(chatMessages)
      .set({ isDeleted: true, content: null, updatedAt: new Date() })
      .where(
        and(
          eq(chatMessages.orgId, orgId),
          eq(chatMessages.id, messageId),
          eq(chatMessages.channelId, message.channelId),
        ),
      );

    void this.ably.publishChatEvent(orgId, message.channelId, "message:deleted", {
      id: messageId,
      channelId: message.channelId,
    });

    return { ok: true };
  }
}
