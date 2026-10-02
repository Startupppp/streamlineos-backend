import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  chatMessageReactions,
  chatMessages,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AblyService } from "../realtime/ably.service";
import { MESSAGE_REACTIONS_WITH, foldReactions } from "./chat-message-reaction-shape";
import { assertChannelMember } from "./chat-channel-authorization";

@Injectable()
export class ChatReactionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
  ) {}

  private async assertMessage(
    messageId: number,
    channelId: number,
    orgId: string,
  ): Promise<void> {
    const [msg] = await this.db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.orgId, orgId),
          eq(chatMessages.channelId, channelId),
          eq(chatMessages.isDeleted, false),
        ),
      )
      .limit(1);
    if (!msg) throw new NotFoundException("Message not found");
  }

  private async loadReactions(
    orgId: string,
    messageId: number,
  ): Promise<Record<string, string[]>> {
    const rows = await this.db.query.chatMessageReactions.findMany({
      where: and(
        eq(chatMessageReactions.orgId, orgId),
        eq(chatMessageReactions.messageId, messageId),
      ),
      ...MESSAGE_REACTIONS_WITH,
    });
    return foldReactions(rows);
  }

  async addReaction(
    channelId: number,
    messageId: number,
    userId: string,
    orgId: string,
    emoji: string,
  ): Promise<{ reactions: Record<string, string[]> }> {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    await this.assertMessage(messageId, channelId, orgId);

    await this.db
      .insert(chatMessageReactions)
      .values({ orgId, messageId, membershipId, emoji })
      .onConflictDoNothing();

    const reactions = await this.loadReactions(orgId, messageId);
    void this.ably.publishChatEvent(orgId, channelId, "reaction:updated", {
      messageId,
      channelId,
      reactions,
    });
    return { reactions };
  }

  async removeReaction(
    channelId: number,
    messageId: number,
    userId: string,
    orgId: string,
    emoji: string,
  ): Promise<{ reactions: Record<string, string[]> }> {
    const { membershipId } = await assertChannelMember(this.db, channelId, userId, orgId);
    await this.assertMessage(messageId, channelId, orgId);

    await this.db.delete(chatMessageReactions).where(
      and(
        eq(chatMessageReactions.orgId, orgId),
        eq(chatMessageReactions.messageId, messageId),
        eq(chatMessageReactions.membershipId, membershipId),
        eq(chatMessageReactions.emoji, emoji),
      ),
    );

    const reactions = await this.loadReactions(orgId, messageId);
    void this.ably.publishChatEvent(orgId, channelId, "reaction:updated", {
      messageId,
      channelId,
      reactions,
    });
    return { reactions };
  }
}
