import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import {
  chatChannelMembers,
  chatChannels,
  chatMessages,
} from "../../db/schema";
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
import { liftSenderId } from "./chat-message-sender-shape";
import {
  MESSAGE_REACTIONS_WITH,
  foldReactions,
  type ReactionRow,
} from "./chat-message-reaction-shape";

type ChatSender = {
  id: string | null;
  name: string | null;
  image: string | null;
};

function senderFromIdentity(identity: PersonIdentity | undefined): ChatSender {
  const parts = [identity?.firstName, identity?.lastName]
    .filter(Boolean)
    .join(" ");
  const name = identity?.displayName ?? (parts || null);
  return {
    id: identity?.userId ?? null,
    name: name ?? null,
    image: identity?.avatarUrl ?? null,
  };
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
      senderMembership: { userId: string } | null;
      reactions: ReactionRow[];
      replyTo:
        | ({ senderMembership: { userId: string } | null } & Record<
            string,
            unknown
          >)
        | null;
    },
  >(msg: M, identities: Map<string, PersonIdentity>) {
    return {
      ...liftSenderId(msg),
      // Folded here rather than left as join rows: the wire shape is the same
      // `emoji -> userId[]` map the reaction mutation and the realtime event carry, so a
      // refetch and a live event agree about what the bubble should render.
      reactions: foldReactions(msg.reactions),
      sender: senderFromIdentity(
        msg.senderMembership
          ? identities.get(
              subjectKey({ kind: "user", userId: msg.senderMembership.userId }),
            )
          : undefined,
      ),
      replyTo: msg.replyTo
        ? {
            ...liftSenderId(msg.replyTo),
            sender: senderFromIdentity(
              msg.replyTo.senderMembership
                ? identities.get(
                    subjectKey({
                      kind: "user",
                      userId: msg.replyTo.senderMembership.userId,
                    }),
                  )
                : undefined,
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
      where: and(
        eq(chatChannels.id, channelId),
        eq(chatChannels.orgId, actor.orgId),
      ),
      columns: { id: true, type: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");

    if (!(await this.isMember(channelId, actor.orgId, actor.membershipId))) {
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
        attachments: { columns: { id: true, fileName: true, fileUrl: true, fileKey: true, fileSize: true, mimeType: true } },
        senderMembership: { columns: { userId: true } },
        reactions: MESSAGE_REACTIONS_WITH,
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
    const identities = await this.resolveIdentities(actor.orgId, senderIds);
    const enriched = page.data.reverse().map((m) => this.enrich(m, identities));

    return {
      messages: await this.withResolvedReferences(actor, enriched),
      nextCursor: page.nextCursor,
    };
  }

  async poll(
    channelId: number,
    actor: EntityActor,
    since: Date | undefined,
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

    if (!(await this.isMember(channelId, actor.orgId, actor.membershipId))) {
      if (channel.type !== "PUBLIC")
        throw new NotFoundException("Channel not found");
      throw new ForbiddenException("You are not a member of this channel");
    }

    const safeLimit = Math.min(Math.max(1, limit), 100);
    // `is_deleted = false` STAYS, against the audit's recommendation to drop it so a
    // deletion arrives as a tombstone the way `list()` returns one. Two reasons, and the
    // first is decisive:
    //
    // 1. It would not achieve what it was proposed for. `poll()` is a FORWARD-ONLY cursor
    //    on `channel_position` (`> cursor`, or `created_at > since`). A message the client
    //    has already received and rendered sits BEHIND its cursor, so deleting it can
    //    never re-deliver it through this route whatever this predicate says. The stated
    //    failure — "the polling client renders the pre-delete content forever" — is
    //    unchanged by dropping the filter. Propagating a deletion the client already holds
    //    needs the realtime `message:deleted` event or a deletions-since feed, which is a
    //    different route, not a different predicate here.
    //
    // 2. It is a deliberate, documented contract: `chat-poll-pagination.spec.ts` asserts
    //    "excludes deleted messages from every page" and its tenant-scope test fails the
    //    query outright if `is_deleted` is absent.
    //
    // The residual is real and worth naming: a message deleted AHEAD of the client's
    // cursor is skipped by `poll()` and returned as a tombstone by `list()`, so the two
    // reads of one channel disagree by that row. That is a benign extra row appearing on
    // a manual refetch, not stale content, and closing it properly means a deletion feed.
    const conditions = [
      eq(chatMessages.orgId, actor.orgId),
      eq(chatMessages.channelId, channelId),
      eq(chatMessages.isDeleted, false),
    ];

    if (cursor !== undefined) {
      conditions.push(gt(chatMessages.channelPosition, cursor));
    } else if (since !== undefined) {
      conditions.push(gt(chatMessages.createdAt, since));
    }

    const rawMessages = await this.db.query.chatMessages.findMany({
      where: and(...conditions),
      orderBy: [asc(chatMessages.channelPosition)],
      limit: safeLimit + 1,
      with: {
        attachments: { columns: { id: true, fileName: true, fileUrl: true, fileKey: true, fileSize: true, mimeType: true } },
        senderMembership: { columns: { userId: true } },
        reactions: MESSAGE_REACTIONS_WITH,
        replyTo: {
          with: { senderMembership: { columns: { userId: true } } },
        },
      },
    });

    const page = buildIdCursorPage(rawMessages, safeLimit, (m) => m.channelPosition);
    const senderIds = new Set<string>();
    for (const m of page.data) {
      if (m.senderMembership?.userId) senderIds.add(m.senderMembership.userId);
      if (m.replyTo?.senderMembership?.userId)
        senderIds.add(m.replyTo.senderMembership.userId);
    }
    const identities = await this.resolveIdentities(actor.orgId, senderIds);
    const enriched = page.data.map((m) => this.enrich(m, identities));

    return {
      messages: await this.withResolvedReferences(actor, enriched),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
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
        attachments: { columns: { id: true, fileName: true, fileUrl: true, fileKey: true, fileSize: true, mimeType: true } },
        senderMembership: { columns: { userId: true } },
        reactions: MESSAGE_REACTIONS_WITH,
        replyTo: {
          with: { senderMembership: { columns: { userId: true } } },
        },
      },
    });

    if (!rawParent) throw new NotFoundException("Message not found");

    if (
      !(await this.isMember(
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
        attachments: { columns: { id: true, fileName: true, fileUrl: true, fileKey: true, fileSize: true, mimeType: true } },
        senderMembership: { columns: { userId: true } },
        reactions: MESSAGE_REACTIONS_WITH,
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

    const identities = await this.resolveIdentities(actor.orgId, senderIds);
    const parentMessage = this.enrich(rawParent, identities);
    const enrichedReplies = page.data
      .reverse()
      .map((r) => this.enrich(r, identities));

    const [resolvedParent] = await this.withResolvedReferences(actor, [
      parentMessage,
    ]);
    return {
      parentMessage: resolvedParent ?? parentMessage,
      replies: await this.withResolvedReferences(actor, enrichedReplies),
      nextCursor: page.nextCursor,
    };
  }
}
