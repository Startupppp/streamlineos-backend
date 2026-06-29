import { Inject, Injectable } from "@nestjs/common";
import { chatChannelMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { AblyService } from "../realtime/ably.service";
import { eq } from "drizzle-orm";

@Injectable()
export class ChatNotificationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
  ) {}

  async publishNewMessageNotification(
    orgId: string,
    channelId: number,
    message: { id: number; content: string | null; senderId: string; senderName: string | null },
    channelType: string,
  ) {
    const memberIds = await this.db
      .select({ userId: chatChannelMembers.userId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.channelId, channelId));

    for (const { userId } of memberIds) {
      if (userId === message.senderId) continue;
      await this.ably.publishToUser(orgId, userId, "notification:message", {
        channelId,
        messageId: message.id,
        content: message.content,
        senderId: message.senderId,
        senderName: message.senderName,
        channelType,
      });
    }
  }
}
