import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import { chatChannelMembers, chatMessages } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { buildIdCursorPage } from "../../common/pagination/cursor";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";

@Injectable()
export class ChatMessageTimelineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entities: EntityReferenceService,
  ) {}

  private async isMember(
    channelId: number,
    orgId: string,
    membershipId?: number | null,
    userId?: string,
  ): Promise<boolean> {
    if (membershipId) {
      const m = await this.db.query.chatChannelMembers.findFirst({
        where: and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
        columns: { id: true },
      });
      if (m) return true;
    }
    if (userId) {
      const m = await this.db.query.chatChannelMembers.findFirst({
        where: and(
          eq(chatChannelMembers.orgId, orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.userId, userId),
        ),
        columns: { id: true },
      });
      return Boolean(m);
    }
    return false;
  }

  private withResolvedReferences<
    T extends { metadata: Record<string, unknown> | null },
  >(actor: EntityActor, messages: T[]): Promise<T[]> {
    return this.entities.withResolvedReferences(actor, messages);
  }

  async list(
    channelId: number,
    actor: EntityActor,
    cursor: number | undefined,
    limit: number,
  ) {
    if (
      !(await this.isMember(channelId, actor.orgId, actor.membershipId, actor.userId))
    )
      throw new ForbiddenException("You are not a member of this channel");

    const safeLimit = Math.min(Math.max(1, limit), 100);
    const conditions = [eq(chatMessages.channelId, channelId)];
    if (cursor) conditions.push(lt(chatMessages.id, cursor));

    const messages = await this.db.query.chatMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(chatMessages.id)],
      limit: safeLimit + 1,
      with: {
        sender: { columns: { id: true, name: true, image: true } },
        attachments: true,
        replyTo: { with: { sender: { columns: { id: true, name: true } } } },
      },
    });

    const page = buildIdCursorPage(messages, safeLimit, (m) => m.id);
    return {
      messages: await this.withResolvedReferences(actor, page.data.reverse()),
      nextCursor: page.nextCursor,
    };
  }

  async poll(channelId: number, actor: EntityActor, since: Date) {
    if (
      !(await this.isMember(channelId, actor.orgId, actor.membershipId, actor.userId))
    )
      throw new ForbiddenException("You are not a member of this channel");

    const messages = await this.db.query.chatMessages.findMany({
      where: and(
        eq(chatMessages.channelId, channelId),
        gt(chatMessages.createdAt, since),
      ),
      orderBy: [desc(chatMessages.createdAt)],
      limit: 100,
      with: {
        sender: { columns: { id: true, name: true, image: true } },
        attachments: true,
        replyTo: { with: { sender: { columns: { id: true, name: true } } } },
      },
    });

    return this.withResolvedReferences(actor, messages.reverse());
  }

  async listThreadReplies(
    parentMessageId: number,
    actor: EntityActor,
    cursor: number | undefined,
    limit: number,
  ) {
    const parentMessage = await this.db.query.chatMessages.findFirst({
      where: eq(chatMessages.id, parentMessageId),
      with: {
        sender: { columns: { id: true, name: true, image: true } },
        attachments: true,
        replyTo: { with: { sender: { columns: { id: true, name: true } } } },
      },
    });

    if (!parentMessage) throw new NotFoundException("Message not found");

    if (
      !(await this.isMember(
        parentMessage.channelId,
        actor.orgId,
        actor.membershipId,
        actor.userId,
      ))
    )
      throw new ForbiddenException("You are not a member of this channel");

    const safeLimit = Math.min(Math.max(1, limit), 100);
    const conditions = [eq(chatMessages.replyToId, parentMessageId)];
    if (cursor) conditions.push(lt(chatMessages.id, cursor));

    const replies = await this.db.query.chatMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(chatMessages.id)],
      limit: safeLimit + 1,
      with: {
        sender: { columns: { id: true, name: true, image: true } },
        attachments: true,
        replyTo: { with: { sender: { columns: { id: true, name: true } } } },
      },
    });

    const page = buildIdCursorPage(replies, safeLimit, (r) => r.id);
    const [resolvedParent] = await this.withResolvedReferences(actor, [
      parentMessage,
    ]);
    return {
      parentMessage: resolvedParent ?? parentMessage,
      replies: await this.withResolvedReferences(actor, page.data.reverse()),
      nextCursor: page.nextCursor,
    };
  }
}
