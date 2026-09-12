import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { chatAttachments, chatMessages } from "../../db/schema";
import { StorageService } from "../storage/storage.service";
import { ChatChannelMembersService } from "./chat-channel-members.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";

@Injectable()
export class ChatAttachmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly members: ChatChannelMembersService,
  ) {}

  async getSignedUrl(
    channelId: number,
    attachmentId: number,
    actor: EntityActor,
  ): Promise<{ url: string }> {
    const orgId = actor.orgId;
    await this.members.assertChannelMembership(channelId, actor);

    const rows = await this.db
      .select({ fileKey: chatAttachments.fileKey })
      .from(chatAttachments)
      .innerJoin(chatMessages, eq(chatAttachments.messageId, chatMessages.id))
      .where(
        and(
          eq(chatAttachments.id, attachmentId),
          eq(chatAttachments.orgId, orgId),
          eq(chatMessages.orgId, orgId),
          eq(chatMessages.channelId, channelId),
          eq(chatMessages.isDeleted, false),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw new NotFoundException("Attachment not found");

    const url = await this.storage.getFileUrl(orgId, row.fileKey, 3600);
    return { url };
  }
}
