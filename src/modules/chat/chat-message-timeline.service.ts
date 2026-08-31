import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import { chatChannelMembers, chatChannels, chatMessages } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { buildIdCursorPage } from "../../common/pagination/cursor";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import {
  resolvePeopleIdentities,
  subjectKey,
  type PersonIdentity,
} from "../directory/person-seam";

type ChatSender = { id: string | null; name: string | null; image: string | null };

function senderFromIdentity(identity: PersonIdentity | undefined): ChatSender {
  const parts = [identity?.firstName, identity?.lastName].filter(Boolean).join(" ");
  const name = identity?.displayName ?? (parts || null);
  return { id: identity?.userId ?? null, name: name ?? null, image: identity?.avatarUrl ?? null };
}

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
  ): Promise<boolean> {
    if (!membershipId) return false;
    const m = await this.db.query.chatChannelMembers.findFirst({
      where: and(
        eq(chatChannelMembers.orgId, orgId),
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.membershipId, membershipId),
      ),
      columns: { id: true },
    });
    return Boolean(m);
  }

  private withResolvedReferences<
    T extends { metadata: Record<string, unknown> | null },
  >(actor: EntityActor, messages: T[]): Promise<T[]> {
    return this.entities.withResolvedReferences(actor, messages);
  }

  private async resolveIdentities(
    orgId: string,
    senderIds: Set<string>,
  ): Promise<Map<string, PersonIdentity>> {
    if (senderIds.size === 0) return new Map();
    const subjects = [...senderIds].map((userId) => ({
      kind: "user" as const,
      userId,
    }));
    return resolvePeopleIdentities(this.db, orgId, subjects);
  }

  private enrich<
    M extends {
      senderId: string;
      replyTo: ({ senderId: string } & Record<string, unknown>) | null;
    },
  >(
    msg: M,
    identities: Map<string, PersonIdentity>,
  ) {
    return {
      ...msg,
      sender: senderFromIdentity(
        identities.get(subjectKey({ kind: "user", userId: msg.senderId })),
      ),
      replyTo: msg.replyTo
        ? {
            ...msg.replyTo,
            sender: senderFromIdentity(
              identities.get(
                subjectKey({ kind: "user", userId: msg.replyTo.senderId }),
              ),
            ),
          }
        : null,
    };
  }

  async list(
    channelId: number,
    actor: EntityActor,
    cursor: number | undefined,
    limit: number,
  ) {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, actor.orgId)),
      columns: { id: true, type: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");

    if (!(await this.isMember(channelId, actor.orgId, actor.membershipId))) {
      if (channel.type !== "PUBLIC") throw new NotFoundException("Channel not found");
      throw new ForbiddenException("You are not a member of this channel");
    }

    const safeLimit = Math.min(Math.max(1, limit), 100);
    const conditions = [eq(chatMessages.orgId, actor.orgId), eq(chatMessages.channelId, channelId)];
    if (cursor) conditions.push(lt(chatMessages.channelPosition, cursor));

    const rawMessages = await this.db.query.chatMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(chatMessages.channelPosition)],
      limit: safeLimit + 1,
      with: {
        attachments: true,
        replyTo: true,
      },
    });

    const page = buildIdCursorPage(rawMessages, safeLimit, (m) => m.channelPosition);
    const senderIds = new Set<string>();
    for (const m of page.data) {
      senderIds.add(m.senderId);
      if (m.replyTo?.senderId) senderIds.add(m.replyTo.senderId);
    }
    const identities = await this.resolveIdentities(actor.orgId, senderIds);
    const enriched = page.data.reverse().map((m) => this.enrich(m, identities));

    return {
      messages: await this.withResolvedReferences(actor, enriched),
      nextCursor: page.nextCursor,
    };
  }

  async poll(channelId: number, actor: EntityActor, since: Date) {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(eq(chatChannels.id, channelId), eq(chatChannels.orgId, actor.orgId)),
      columns: { id: true, type: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");

    if (!(await this.isMember(channelId, actor.orgId, actor.membershipId))) {
      if (channel.type !== "PUBLIC") throw new NotFoundException("Channel not found");
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
        replyTo: true,
      },
    });

    const senderIds = new Set<string>();
    for (const m of rawMessages) {
      senderIds.add(m.senderId);
      if (m.replyTo?.senderId) senderIds.add(m.replyTo.senderId);
    }
    const identities = await this.resolveIdentities(actor.orgId, senderIds);
    const enriched = rawMessages.reverse().map((m) => this.enrich(m, identities));

    return this.withResolvedReferences(actor, enriched);
  }

  async listThreadReplies(
    parentMessageId: number,
    actor: EntityActor,
    cursor: number | undefined,
    limit: number,
  ) {
    const rawParent = await this.db.query.chatMessages.findFirst({
      where: and(eq(chatMessages.id, parentMessageId), eq(chatMessages.orgId, actor.orgId)),
      with: {
        attachments: true,
        replyTo: true,
      },
    });

    if (!rawParent) throw new NotFoundException("Message not found");

    if (!(await this.isMember(rawParent.channelId, actor.orgId, actor.membershipId))) {
      const parentChannel = await this.db.query.chatChannels.findFirst({
        where: and(eq(chatChannels.id, rawParent.channelId), eq(chatChannels.orgId, actor.orgId)),
        columns: { type: true },
      });
      if (parentChannel?.type !== "PUBLIC") throw new NotFoundException("Message not found");
      throw new ForbiddenException("You are not a member of this channel");
    }

    const safeLimit = Math.min(Math.max(1, limit), 100);
    const conditions = [eq(chatMessages.orgId, actor.orgId), eq(chatMessages.replyToId, parentMessageId)];
    if (cursor) conditions.push(lt(chatMessages.channelPosition, cursor));

    const rawReplies = await this.db.query.chatMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(chatMessages.channelPosition)],
      limit: safeLimit + 1,
      with: {
        attachments: true,
        replyTo: true,
      },
    });

    const senderIds = new Set<string>();
    senderIds.add(rawParent.senderId);
    if (rawParent.replyTo?.senderId) senderIds.add(rawParent.replyTo.senderId);
    const page = buildIdCursorPage(rawReplies, safeLimit, (r) => r.channelPosition);
    for (const r of page.data) {
      senderIds.add(r.senderId);
      if (r.replyTo?.senderId) senderIds.add(r.replyTo.senderId);
    }

    const identities = await this.resolveIdentities(actor.orgId, senderIds);
    const parentMessage = this.enrich(rawParent, identities);
    const enrichedReplies = page.data.reverse().map((r) => this.enrich(r, identities));

    const [resolvedParent] = await this.withResolvedReferences(actor, [parentMessage]);
    return {
      parentMessage: resolvedParent ?? parentMessage,
      replies: await this.withResolvedReferences(actor, enrichedReplies),
      nextCursor: page.nextCursor,
    };
  }
}
