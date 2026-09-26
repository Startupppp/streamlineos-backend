import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, ilike, inArray, lt, lte, or, sql } from "drizzle-orm";
import { chatChannelMembers, chatChannels, chatMessages, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import {
  SENDER_MEMBERSHIP_WITH_USER,
  flattenMessageSender,
} from "./chat-message-sender-shape";
import { chatMessageContentMatch } from "./chat-message-content-match";
import { filterByEntityAccess } from "./chat-channel-authorization";
import { ChatChannelListService } from "./chat-channel-list.service";

@Injectable()
export class ChatSearchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entities: EntityReferenceService,
    private readonly channelList: ChatChannelListService,
  ) {}

  async searchMessages(actor: EntityActor, query: string, limit = 20, cursor?: number, from?: string, to?: string, sender?: string) {
    const { orgId, membershipId } = actor;
    if (!membershipId) return { results: [], nextCursor: undefined };
    const term = query.trim();
    if (!term) return { results: [], nextCursor: undefined };

    try {
      const conditions = [
        eq(chatMessages.orgId, orgId),
        sql`EXISTS (SELECT 1 FROM ${chatChannelMembers} m
                    WHERE m.channel_id = ${chatMessages.channelId}
                      AND m.org_id = ${orgId}
                      AND m.membership_id = ${membershipId})`,
        await chatMessageContentMatch(this.db, term),
        eq(chatMessages.isDeleted, false),
      ];
      // Cursor and sort key must be the same column or pagination skips and repeats
      // rows; id is monotonic with insertion here. Revisit if this table is ever partitioned.
      if (cursor) conditions.push(lt(chatMessages.id, cursor));
      if (from) conditions.push(gte(chatMessages.createdAt, new Date(from)));
      if (to) conditions.push(lte(chatMessages.createdAt, new Date(to)));
      if (sender)
        conditions.push(
          sql`EXISTS (SELECT 1 FROM ${organizationMembers} om
                      WHERE om.id = ${chatMessages.senderMembershipId}
                        AND om.org_id = ${orgId}
                        AND om.user_id = ${sender})`,
        );

      const rows = await this.db.query.chatMessages.findMany({
        where: and(...conditions),
        orderBy: [desc(chatMessages.id)],
        limit: limit + 1,
        with: {
          senderMembership: SENDER_MEMBERSHIP_WITH_USER,
          channel: {
            columns: { id: true, name: true, type: true, entityType: true, entityId: true },
          },
        },
      });

      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const nextCursor = hasMore ? rows[rows.length - 1]?.id : undefined;
      const visible = await filterByEntityAccess(
        this.entities,
        rows,
        actor,
        (row) => row.channel,
      );
      const resolved = await this.entities.withResolvedReferences(actor, visible);
      const results = resolved.map((row) => {
        const flattened = flattenMessageSender(row);
        const { channel } = flattened;
        return {
          ...flattened,
          channel: channel
            ? { id: channel.id, name: channel.name, type: channel.type }
            : channel,
        };
      });
      return { results, nextCursor };
    } catch (error) {
      // Log the error but return empty results instead of crashing the chat interface.
      // This handles cases where the search function fails (e.g., missing tenant GUC,
      // database errors, or malformed search terms).
      logger.error("[chat.searchMessages] Search failed", {
        error: error instanceof Error ? error.message : String(error),
        query: term,
        orgId,
      });
      return { results: [], nextCursor: undefined };
    }
  }

  async searchChannels(actor: EntityActor, query: string) {
    const { orgId } = actor;
    if (!query.trim()) return [];
    const q = `%${query.trim()}%`;

    const memberChannelIdList = await this.channelList.listMemberChannelIds(actor, {
      includeArchived: true,
    });
    const memberChannelIds = new Set(memberChannelIdList);

    // Discoverability, not just tenancy. Without the `is_private` arm this read matched
    // every channel in the org: DIRECT channels are named `${creator} & ${target}`
    // (chat-channels.service.ts:122-125), so searching a colleague's name enumerated the
    // people they DM, and every PRIVATE channel's name and description came back to
    // non-members. `is_private` is exactly `type <> 'PUBLIC'` — migration 0981 installed
    // CHECK chk_chat_channels_privacy_matches_type, so the database guarantees the two
    // agree and this predicate cannot drift from the type column.
    //
    // An empty `memberChannelIds` compiles to `or(is_private = false, false)` in
    // drizzle-orm 0.45.2 (verified against the emitted SQL), i.e. public channels only —
    // not a silently dropped predicate.
    const channels = await this.db.query.chatChannels.findMany({
      where: and(
        eq(chatChannels.orgId, orgId),
        ilike(chatChannels.name, q),
        or(
          eq(chatChannels.isPrivate, false),
          inArray(chatChannels.id, memberChannelIdList),
        ),
      ),
      columns: {
        id: true,
        name: true,
        type: true,
        description: true,
        avatarUrl: true,
        entityType: true,
        entityId: true,
      },
      limit: 10,
    });

    const visible = await filterByEntityAccess(
      this.entities,
      channels,
      actor,
      (channel) => channel,
    );
    return visible.map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      description: channel.description,
      avatarUrl: channel.avatarUrl,
      isMember: memberChannelIds.has(channel.id),
    }));
  }

  async searchUsers(orgId: string, query: string) {
    if (!query.trim()) return [];
    const q = `%${query.trim()}%`;
    return this.db
      .select({ id: users.id, name: users.name, email: users.email, image: users.image })
      .from(users)
      .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          or(ilike(users.name, q), ilike(users.email, q)),
        ),
      )
      .limit(10);
  }
}
