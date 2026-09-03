import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt } from "drizzle-orm";
import { chatChannelMembers, chatMessages, chatSavedMessages } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { buildIdCursorPage } from "../../common/pagination/cursor";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import {
  SENDER_MEMBERSHIP_WITH_USER,
  flattenMessageSender,
} from "./chat-message-sender-shape";

@Injectable()
export class ChatSavedService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entities: EntityReferenceService,
  ) {}

  async list(actor: EntityActor, cursor?: number, limit = 30) {
    // `Math.min(Math.max(1, x), 100)` is NaN-transparent, and a NaN limit does not throw:
    // drizzle emits the `limit` clause only for a finite non-negative number, so the clause
    // silently disappears and the read becomes unbounded. The controller now rejects a
    // non-numeric `?limit`; this second clamp is what makes the service safe for any
    // caller, since it is a public method and the guarantee belongs with the query.
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.trunc(limit)), 100) : 30;
    const membershipId = actor.membershipId;
    if (!membershipId) return { items: [], nextCursor: undefined };
    const conditions = [
      eq(chatSavedMessages.orgId, actor.orgId),
      eq(chatSavedMessages.membershipId, membershipId),
    ];
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
            senderMembership: SENDER_MEMBERSHIP_WITH_USER,
            channel: { columns: { id: true, name: true, type: true } },
            attachments: true,
          },
        },
      },
    });

    const page = buildIdCursorPage(rows, safeLimit, (row) => row.id);
    const resolved = await this.entities.withResolvedReferences(
      actor,
      page.data.map((row) => flattenMessageSender(row.message)),
    );
    return {
      items: page.data.map((row, index) => ({ ...row, message: resolved[index] })),
      nextCursor: page.nextCursor,
    };
  }

  async save(actor: EntityActor, messageId: number) {
    const message = await this.db.query.chatMessages.findFirst({
      where: and(
        eq(chatMessages.orgId, actor.orgId),
        eq(chatMessages.id, messageId),
        eq(chatMessages.isDeleted, false),
      ),
      columns: { id: true, channelId: true, orgId: true },
    });
    if (!message) throw new NotFoundException("Message not found");

    const membershipId = actor.membershipId;
    if (!membershipId) throw new ForbiddenException("Access denied");

    const membership = await this.db.query.chatChannelMembers.findFirst({
      columns: { id: true },
      where: and(
        eq(chatChannelMembers.orgId, actor.orgId),
        eq(chatChannelMembers.channelId, message.channelId),
        eq(chatChannelMembers.membershipId, membershipId),
      ),
    });
    if (!membership) throw new ForbiddenException("Access denied");

    await this.db.insert(chatSavedMessages).values({
      orgId: actor.orgId,
      membershipId,
      messageId,
    }).onConflictDoNothing();
    return { ok: true };
  }

  async unsave(actor: EntityActor, messageId: number) {
    const membershipId = actor.membershipId;
    if (!membershipId) throw new NotFoundException("Saved message not found");
    const removed = await this.db
      .delete(chatSavedMessages)
      .where(and(
        eq(chatSavedMessages.orgId, actor.orgId),
        eq(chatSavedMessages.membershipId, membershipId),
        eq(chatSavedMessages.messageId, messageId),
      ))
      .returning({ messageId: chatSavedMessages.messageId });
    if (removed.length === 0) throw new NotFoundException("Saved message not found");
    return { ok: true };
  }

  async isSaved(actor: EntityActor, messageId: number) {
    const membershipId = actor.membershipId;
    if (!membershipId) return { saved: false };
    const row = await this.db.query.chatSavedMessages.findFirst({
      where: and(
        eq(chatSavedMessages.orgId, actor.orgId),
        eq(chatSavedMessages.membershipId, membershipId),
        eq(chatSavedMessages.messageId, messageId),
      ),
      columns: { id: true },
    });
    return { saved: Boolean(row) };
  }
}
