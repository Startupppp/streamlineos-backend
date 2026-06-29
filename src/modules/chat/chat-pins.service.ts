import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { chatChannelMembers, chatMessages, chatPinnedMessages } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

@Injectable()
export class ChatPinsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async assertMember(channelId: number, userId: string) {
    const member = await this.db.query.chatChannelMembers.findFirst({
      where: and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)),
    });
    if (!member) throw new ForbiddenException("You are not a member of this channel");
    return member;
  }

  async listPins(channelId: number, userId: string) {
    await this.assertMember(channelId, userId);
    return this.db.query.chatPinnedMessages.findMany({
      where: eq(chatPinnedMessages.channelId, channelId),
      orderBy: [desc(chatPinnedMessages.pinnedAt)],
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
  }

  async pin(channelId: number, messageId: number, userId: string) {
    await this.assertMember(channelId, userId);
    const message = await this.db.query.chatMessages.findFirst({
      where: and(eq(chatMessages.id, messageId), eq(chatMessages.channelId, channelId), eq(chatMessages.isDeleted, false)),
    });
    if (!message) throw new NotFoundException("Message not found");
    await this.db.insert(chatPinnedMessages).values({ channelId, messageId, pinnedBy: userId }).onConflictDoNothing();
    return { ok: true };
  }

  async unpin(channelId: number, messageId: number, userId: string) {
    await this.assertMember(channelId, userId);
    await this.db.delete(chatPinnedMessages).where(and(eq(chatPinnedMessages.channelId, channelId), eq(chatPinnedMessages.messageId, messageId)));
    return { ok: true };
  }
}
