import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { chatMessages } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AblyService } from "../realtime/ably.service";
import { assertChannelMember } from "./chat-channel-authorization";

@Injectable()
export class ChatMessageModerationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
  ) {}

  /**
   * The channel in the URL is part of the identity of the message, not decoration.
   *
   * `PATCH|DELETE /chat/channels/:channelId/messages/:messageId` parsed `:channelId` through
   * `channelAndMessageIdParams` and then threw it away: the lookup keyed on `(id, orgId)`
   * alone, so any channel id in the path addressed any message in the tenant. The membership
   * check that followed read the message's OWN `channelId`, so it always agreed with itself
   * and the mismatch could not be detected downstream either. A message that does not live in
   * the named channel is a miss, and a miss is 404 — never 403, which would confirm to a
   * prober that the id exists somewhere else in the org.
   */
  private async assertAuthor(
    messageId: number,
    channelId: number,
    userId: string,
    orgId: string,
  ) {
    const message = await this.db.query.chatMessages.findFirst({
      where: and(
        eq(chatMessages.id, messageId),
        eq(chatMessages.orgId, orgId),
        eq(chatMessages.channelId, channelId),
        eq(chatMessages.isDeleted, false),
      ),
    });
    if (!message) throw new NotFoundException("Message not found");

    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);

    return { message, membershipId };
  }

  async edit(
    messageId: number,
    channelId: number,
    userId: string,
    orgId: string,
    content: string,
  ) {
    const { message, membershipId } = await this.assertAuthor(
      messageId,
      channelId,
      userId,
      orgId,
    );

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
          eq(chatMessages.channelId, channelId),
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

  async remove(
    messageId: number,
    channelId: number,
    userId: string,
    isOrgAdmin: boolean,
    orgId: string,
  ) {
    const { message, membershipId } = await this.assertAuthor(
      messageId,
      channelId,
      userId,
      orgId,
    );

    if (!isOrgAdmin && message.senderMembershipId !== membershipId)
      throw new ForbiddenException("You can only delete your own messages");

    await this.db
      .update(chatMessages)
      .set({ isDeleted: true, content: null, updatedAt: new Date() })
      .where(
        and(
          eq(chatMessages.orgId, orgId),
          eq(chatMessages.id, messageId),
          eq(chatMessages.channelId, channelId),
        ),
      );

    void this.ably.publishChatEvent(orgId, message.channelId, "message:deleted", {
      id: messageId,
      channelId: message.channelId,
    });

    return { ok: true };
  }
}
