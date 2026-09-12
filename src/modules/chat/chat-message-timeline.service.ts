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
import { SENDER_MEMBERSHIP_ID_ONLY } from "./chat-message-sender-shape";
import { MESSAGE_REACTIONS_WITH } from "./chat-message-reaction-shape";
import { hydrateTimelineMessages } from "./chat-timeline-hydration";
import { assertEntityAccess } from "./chat-channel-authorization";

const REPLY_PREVIEW_WITH = {
  columns: { id: true, content: true },
  with: { senderMembership: SENDER_MEMBERSHIP_ID_ONLY },
} as const;

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

  private async authorizeChannelRead(channelId: number, actor: EntityActor) {
    const channel = await this.db.query.chatChannels.findFirst({
      where: and(
        eq(chatChannels.id, channelId),
        eq(chatChannels.orgId, actor.orgId),
      ),
      columns: { id: true, type: true, entityType: true, entityId: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");

    if (!(await this.isMember(channelId, actor.orgId, actor.membershipId))) {
      if (channel.type !== "PUBLIC")
        throw new NotFoundException("Channel not found");
      throw new ForbiddenException("You are not a member of this channel");
    }

    await assertEntityAccess(this.entities, channel, actor, "Channel not found");
    return channel;
  }

  async list(
    channelId: number,
    actor: EntityActor,
    cursor: number | undefined,
    limit: number,
  ) {
    await this.authorizeChannelRead(channelId, actor);

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
        senderMembership: SENDER_MEMBERSHIP_ID_ONLY,
        reactions: MESSAGE_REACTIONS_WITH,
        replyTo: REPLY_PREVIEW_WITH,
      },
    });

    const page = buildIdCursorPage(
      rawMessages,
      safeLimit,
      (m) => m.channelPosition,
    );
    const messages = await hydrateTimelineMessages(
      this.db, this.entities, actor, page.data.reverse(),
    );

    return {
      messages,
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
    await this.authorizeChannelRead(channelId, actor);

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
        senderMembership: SENDER_MEMBERSHIP_ID_ONLY,
        reactions: MESSAGE_REACTIONS_WITH,
        replyTo: REPLY_PREVIEW_WITH,
      },
    });

    const page = buildIdCursorPage(rawMessages, safeLimit, (m) => m.channelPosition);
    const messages = await hydrateTimelineMessages(
      this.db, this.entities, actor, page.data,
    );

    return {
      messages,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      latestPosition: page.data.at(-1)?.channelPosition ?? null,
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
        senderMembership: SENDER_MEMBERSHIP_ID_ONLY,
        reactions: MESSAGE_REACTIONS_WITH,
        replyTo: REPLY_PREVIEW_WITH,
      },
    });

    if (!rawParent) throw new NotFoundException("Message not found");

    const isParentChannelMember = await this.isMember(
      rawParent.channelId,
      actor.orgId,
      actor.membershipId,
    );
    const parentChannel = await this.db.query.chatChannels.findFirst({
      where: and(
        eq(chatChannels.id, rawParent.channelId),
        eq(chatChannels.orgId, actor.orgId),
      ),
      columns: { type: true, entityType: true, entityId: true },
    });

    if (!isParentChannelMember) {
      if (parentChannel?.type !== "PUBLIC")
        throw new NotFoundException("Message not found");
      throw new ForbiddenException("You are not a member of this channel");
    }

    await assertEntityAccess(this.entities, parentChannel, actor, "Message not found");

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
        senderMembership: SENDER_MEMBERSHIP_ID_ONLY,
        reactions: MESSAGE_REACTIONS_WITH,
        replyTo: REPLY_PREVIEW_WITH,
      },
    });

    const page = buildIdCursorPage(
      rawReplies,
      safeLimit,
      (r) => r.channelPosition,
    );
    const [parentMessage, ...replies] = await hydrateTimelineMessages(
      this.db, this.entities, actor, [rawParent, ...page.data.reverse()],
    );

    return {
      parentMessage,
      replies,
      nextCursor: page.nextCursor,
    };
  }
}
