import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt } from "drizzle-orm";
import { chatChannelMembers, chatMessages, chatSavedMessages } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { buildIdCursorPage } from "../../common/pagination/cursor";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";

@Injectable()
export class ChatSavedService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entities: EntityReferenceService,
  ) {}

  async list(actor: EntityActor, cursor?: number, limit = 30) {
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const conditions = [eq(chatSavedMessages.userId, actor.userId)];
    if (cursor) {
      conditions.push(lt(chatSavedMessages.id, cursor));
    }

    const rows = await this.db.query.chatSavedMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(chatSavedMessages.id)],
      limit: safeLimit + 1,
      with: {
        message: {
          with: {
            sender: { columns: { id: true, name: true, image: true } },
            channel: { columns: { id: true, name: true, type: true } },
            attachments: true,
          },
        },
      },
    });

    const page = buildIdCursorPage(rows, safeLimit, (row) => row.id);
    const resolved = await this.entities.withResolvedReferences(
      actor,
      page.data.map((row) => row.message),
    );
    return {
      items: page.data.map((row, index) => ({ ...row, message: resolved[index] })),
      nextCursor: page.nextCursor,
    };
  }

  async save(userId: string, messageId: number) {
    const message = await this.db.query.chatMessages.findFirst({
      where: and(eq(chatMessages.id, messageId), eq(chatMessages.isDeleted, false)),
      columns: { id: true, channelId: true, orgId: true },
    });
    if (!message) throw new NotFoundException("Message not found");

    const membership = await this.db.query.chatChannelMembers.findFirst({
      where: and(eq(chatChannelMembers.channelId, message.channelId), eq(chatChannelMembers.userId, userId)),
    });
    if (!membership) throw new ForbiddenException("Access denied");

    await this.db.insert(chatSavedMessages).values({ orgId: message.orgId, userId, messageId }).onConflictDoNothing();
    return { ok: true };
  }

  async unsave(userId: string, messageId: number) {
    await this.db
      .delete(chatSavedMessages)
      .where(and(eq(chatSavedMessages.userId, userId), eq(chatSavedMessages.messageId, messageId)));
    return { ok: true };
  }

  async isSaved(userId: string, messageId: number) {
    const row = await this.db.query.chatSavedMessages.findFirst({
      where: and(eq(chatSavedMessages.userId, userId), eq(chatSavedMessages.messageId, messageId)),
      columns: { id: true },
    });
    return { saved: Boolean(row) };
  }
}
