import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import {
  chatChannels,
  chatMessages,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { buildIdCursorPage } from "../../common/pagination/cursor";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import {
  enrich,
  isMember,
  resolveIdentities,
  withResolvedReferences,
} from "./lib/chat-timeline-enrich";

@Injectable()
export class ChatMessageTimelineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entities: EntityReferenceService,
  ) {}

  async list(
    channelId: number,
    actor: EntityActor,
    cursor: number | undefined,
    limit: number,
  ) {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(
        eq(chatChannels.id, channelId),
        eq(chatChannels.orgId, actor.orgId),
      ),
      columns: { id: true, type: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");

    if (!(await isMember(this.db, channelId, actor.orgId, actor.membershipId))) {
      if (channel.type !== "PUBLIC")
        throw new NotFoundException("Channel not found");
      throw new ForbiddenException("You are not a member of this channel");
    }

    const safeLimit = Math.min(Math.max(1, limit), 100);
    const conditions = [
      eq(chatMessages.orgId, actor.orgId),
      eq(chatMessages.channelId, channelId),
    ];
    if (cursor) conditions.push(lt(chatMessages.channelPosition, cursor));

    const rawMessages = await this.db.query.chatMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(chatMessages.channelPosition)],
      limit: safeLimit + 1,
      with: {
        attachments: true,
        senderMembership: { columns: { userId: true } },
        replyTo: {
          with: { senderMembership: { columns: { userId: true } } },
        },
      },
    });

    const page = buildIdCursorPage(
      rawMessages,
      safeLimit,
      (m) => m.channelPosition,
    );
    const senderIds = new Set<string>();
    for (const m of page.data) {
      if (m.senderMembership?.userId) senderIds.add(m.senderMembership.userId);
      if (m.replyTo?.senderMembership?.userId)
        senderIds.add(m.replyTo.senderMembership.userId);
    }
    const identities = await resolveIdentities(this.db, actor.orgId, senderIds);
    const enriched = page.data.reverse().map((m) => enrich(m, identities));

    return {
      messages: await withResolvedReferences(this.entities, actor, enriched),
      nextCursor: page.nextCursor,
    };
  }

  async poll(channelId: number, actor: EntityActor, since: Date) {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(
        eq(chatChannels.id, channelId),
        eq(chatChannels.orgId, actor.orgId),
      ),
      columns: { id: true, type: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");

    if (!(await isMember(this.db, channelId, actor.orgId, actor.membershipId))) {
      if (channel.type !== "PUBLIC")
        throw new NotFoundException("Channel not found");
      throw new ForbiddenException("You are not a member of this channel");
    }

    const rawMessages = await this.db.query.chatMessages.findMany({
      where: and(
        eq(chatMessages.orgId, actor.orgId),
        eq(chatMessages.channelId, channelId),
        gt(chatMessages.createdAt, since),
      ),
      orderBy: [desc(chatMessages.createdAt)],
      limit: 100,
      with: {
        attachments: true,
        senderMembership: { columns: { userId: true } },
        replyTo: {
          with: { senderMembership: { columns: { userId: true } } },
        },
      },
    });

    const senderIds = new Set<string>();
    for (const m of rawMessages) {
      if (m.senderMembership?.userId) senderIds.add(m.senderMembership.userId);
      if (m.replyTo?.senderMembership?.userId)
        senderIds.add(m.replyTo.senderMembership.userId);
    }
    const identities = await resolveIdentities(this.db, actor.orgId, senderIds);
    const enriched = rawMessages
      .reverse()
      .map((m) => enrich(m, identities));

    return withResolvedReferences(this.entities, actor, enriched);
  }

  async listThreadReplies(
    parentMessageId: number,
    actor: EntityActor,
    cursor: number | undefined,
    limit: number,
  ) {
    const rawParent = await this.db.query.chatMessages.findFirst({
      where: and(
        eq(chatMessages.id, parentMessageId),
        eq(chatMessages.orgId, actor.orgId),
      ),
      with: {
        attachments: true,
        senderMembership: { columns: { userId: true } },
        replyTo: {
          with: { senderMembership: { columns: { userId: true } } },
        },
      },
    });

    if (!rawParent) throw new NotFoundException("Message not found");

    if (
      !(await isMember(this.db, 
        rawParent.channelId,
        actor.orgId,
        actor.membershipId,
      ))
    ) {
      const parentChannel = await this.db.query.chatChannels.findFirst({
        where: and(
          eq(chatChannels.id, rawParent.channelId),
          eq(chatChannels.orgId, actor.orgId),
        ),
        columns: { type: true },
      });
      if (parentChannel?.type !== "PUBLIC")
        throw new NotFoundException("Message not found");
      throw new ForbiddenException("You are not a member of this channel");
    }

    const safeLimit = Math.min(Math.max(1, limit), 100);
    const conditions = [
      eq(chatMessages.orgId, actor.orgId),
      eq(chatMessages.replyToId, parentMessageId),
    ];
    if (cursor) conditions.push(lt(chatMessages.channelPosition, cursor));

    const rawReplies = await this.db.query.chatMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(chatMessages.channelPosition)],
      limit: safeLimit + 1,
      with: {
        attachments: true,
        senderMembership: { columns: { userId: true } },
        replyTo: {
          with: { senderMembership: { columns: { userId: true } } },
        },
      },
    });

    const senderIds = new Set<string>();
    if (rawParent.senderMembership?.userId)
      senderIds.add(rawParent.senderMembership.userId);
    if (rawParent.replyTo?.senderMembership?.userId)
      senderIds.add(rawParent.replyTo.senderMembership.userId);
    const page = buildIdCursorPage(
      rawReplies,
      safeLimit,
      (r) => r.channelPosition,
    );
    for (const r of page.data) {
      if (r.senderMembership?.userId) senderIds.add(r.senderMembership.userId);
      if (r.replyTo?.senderMembership?.userId)
        senderIds.add(r.replyTo.senderMembership.userId);
    }

    const identities = await resolveIdentities(this.db, actor.orgId, senderIds);
    const parentMessage = enrich(rawParent, identities);
    const enrichedReplies = page.data
      .reverse()
      .map((r) => enrich(r, identities));

    const [resolvedParent] = await withResolvedReferences(this.entities, actor, [
      parentMessage,
    ]);
    return {
      parentMessage: resolvedParent ?? parentMessage,
      replies: await withResolvedReferences(this.entities, actor, enrichedReplies),
      nextCursor: page.nextCursor,
    };
  }
}
