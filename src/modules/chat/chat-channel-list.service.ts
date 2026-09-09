import { Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import {
  chatChannelMembers,
  chatChannels,
  chatMessages,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import { resolvePeopleIdentities, subjectKey } from "../directory/person-seam";
import { PAGE_SIZE_CAP } from "../../common/pagination/list-query.schema";
import { MAX_CAPABILITY_CHANNELS } from "../realtime/ably.service";
import {
  CHANNEL_LIST_COLUMNS,
  loadChannelMemberPreview,
  withMemberPreview,
} from "./chat-channel-member-preview";

export const CHAT_CHANNEL_PAGE_SIZE = 50;

export function entityChannelFallbackName(
  entityType: string,
  entityId: string,
): string {
  return `${entityType.charAt(0).toUpperCase() + entityType.slice(1)}: ${entityId}`;
}

@Injectable()
export class ChatChannelListService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entities: EntityReferenceService,
  ) {}

  async getMembershipId(orgId: string, userId: string): Promise<number | null> {
    const row = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    return row?.id ?? null;
  }

  async resolveEntityChannelDisplayNames<
    T extends {
      id: number;
      name: string;
      entityType: string | null;
      entityId: string | null;
    },
  >(channels: T[], actor: EntityActor): Promise<T[]> {
    const pending: { position: number; type: string; id: string }[] = [];
    channels.forEach((channel, position) => {
      if (!channel.entityType || !channel.entityId) return;
      pending.push({ position, type: channel.entityType, id: channel.entityId });
    });
    if (pending.length === 0) return channels;

    const resolutions = await this.entities.resolve(
      actor,
      pending.map((entry) => ({ type: entry.type, id: entry.id })),
    );

    const renamed = new Map<number, string>();
    pending.forEach((entry, position) => {
      const resolution = resolutions[position];
      if (resolution?.status !== "resolved") return;
      const channel = channels[entry.position];
      if (channel === undefined) return;
      const resolved = resolution.card.title;
      if (channel.name === resolved) return;
      if (channel.name !== entityChannelFallbackName(entry.type, entry.id)) return;
      renamed.set(entry.position, resolved);
    });

    if (renamed.size === 0) return channels;
    return channels.map((channel, position) => {
      const name = renamed.get(position);
      return name === undefined ? channel : { ...channel, name };
    });
  }

  async resolveEntityChannelDisplayName<
    T extends {
      id: number;
      name: string;
      entityType: string | null;
      entityId: string | null;
    },
  >(channel: T, actor: EntityActor): Promise<T> {
    const [named] = await this.resolveEntityChannelDisplayNames([channel], actor);
    return named ?? channel;
  }

  async getMyChannels(actor: EntityActor, cursor?: string | null, limit?: number) {
    return this.listMemberChannels(actor, false, cursor ?? null, limit);
  }
  async getArchivedChannels(actor: EntityActor, cursor?: string | null, limit?: number) {
    return this.listMemberChannels(actor, true, cursor ?? null, limit);
  }

  /**
   * Bounded at the database, not at the consumer. The only caller is the Ably
   * token route, and `AblyService.createChatTokenRequest` already grants at most
   * `MAX_CAPABILITY_CHANNELS` of whatever it is handed. Reading every membership
   * row first meant a member of 50,000 channels paid for 50,000 rows on every
   * token mint to have 49,500 of them thrown away in memory. One row beyond the
   * grant is read so the truncation the consumer performs is observable here.
   */
  async listMemberChannelIds(orgId: string, userId: string): Promise<number[]> {
    const membershipId = await this.getMembershipId(orgId, userId);
    if (membershipId === null) return [];
    const rows = await this.db
      .select({ channelId: chatChannels.id })
      .from(chatChannelMembers)
      .innerJoin(chatChannels, eq(chatChannels.id, chatChannelMembers.channelId))
      .where(
        and(
          eq(chatChannels.orgId, orgId),
          eq(chatChannelMembers.membershipId, membershipId),
          eq(chatChannels.isArchived, false),
        ),
      )
      .limit(MAX_CAPABILITY_CHANNELS + 1);
    if (rows.length > MAX_CAPABILITY_CHANNELS)
      logger.warn("chat: member channel capability list truncated", {
        orgId,
        userId,
        granted: MAX_CAPABILITY_CHANNELS,
      });
    return rows.map((row) => row.channelId);
  }

  async listPublicChannels(orgId: string, userId: string, cursor?: string | null, limit?: number) {
    const currentMembershipId = await this.getMembershipId(orgId, userId);
    if (currentMembershipId === null) return { channels: [], nextCursor: null };
    const PAGE_SIZE = Math.min(limit ?? CHAT_CHANNEL_PAGE_SIZE, PAGE_SIZE_CAP);
    const decoded = this.decodeChannelCursor(cursor ?? null);
    const pageRows = await this.db
      .select({
        id: chatChannels.id,
        name: chatChannels.name,
        description: chatChannels.description,
        avatarUrl: chatChannels.avatarUrl,
        type: chatChannels.type,
        createdAt: chatChannels.createdAt,
        lastMessageAt: chatChannels.lastMessageAt,
      })
      .from(chatChannels)
      .where(and(eq(chatChannels.orgId, orgId), eq(chatChannels.type, "PUBLIC"), eq(chatChannels.isArchived, false), this.channelKeysetWhere(decoded)))
      .orderBy(desc(chatChannels.lastMessageAt), desc(chatChannels.id))
      .limit(PAGE_SIZE + 1);
    const hasMore = pageRows.length > PAGE_SIZE;
    const pageSlice = hasMore ? pageRows.slice(0, PAGE_SIZE) : pageRows;
    if (pageSlice.length === 0) return { channels: [], nextCursor: null };
    const channelIds = pageSlice.map((r) => r.id);
    const lastRow = pageSlice[pageSlice.length - 1];
    const nextCursor = hasMore && lastRow ? this.encodeChannelCursor(lastRow.lastMessageAt, lastRow.id) : null;
    const [countRows, memberRows] = await Promise.all([
      this.db
        .select({ channelId: chatChannelMembers.channelId, cnt: count() })
        .from(chatChannelMembers)
        .where(and(eq(chatChannelMembers.orgId, orgId), inArray(chatChannelMembers.channelId, channelIds)))
        .groupBy(chatChannelMembers.channelId),
      this.db
        .select({ channelId: chatChannelMembers.channelId })
        .from(chatChannelMembers)
        .where(and(eq(chatChannelMembers.orgId, orgId), inArray(chatChannelMembers.channelId, channelIds), eq(chatChannelMembers.membershipId, currentMembershipId))),
    ]);
    const countMap = new Map(countRows.map((r) => [r.channelId, r.cnt]));
    const memberSet = new Set(memberRows.map((r) => r.channelId));
    return {
      channels: pageSlice.map((ch) => ({ ...ch, memberCount: countMap.get(ch.id) ?? 0, isMember: memberSet.has(ch.id) })),
      nextCursor,
    };
  }

  private decodeChannelCursor(raw: string | null): { lma: Date | null; id: number } | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) return null;
      const obj = parsed as Record<string, unknown>;
      if (typeof obj["id"] !== "number") return null;
      if (obj["lma"] !== null && typeof obj["lma"] !== "string") return null;
      return {
        lma: typeof obj["lma"] === "string" ? new Date(obj["lma"]) : null,
        id: obj["id"] as number,
      };
    } catch {
      return null;
    }
  }

  private encodeChannelCursor(lma: Date | null, id: number): string {
    return Buffer.from(JSON.stringify({ lma: lma?.toISOString() ?? null, id }), "utf8").toString("base64url");
  }
  private channelKeysetWhere(cursor: { lma: Date | null; id: number } | null) {
    if (!cursor) return undefined;
    const { lma, id } = cursor;
    if (lma !== null) {
      return sql`(
        ${chatChannels.lastMessageAt} < ${lma.toISOString()}::timestamptz
        OR (${chatChannels.lastMessageAt} = ${lma.toISOString()}::timestamptz AND ${chatChannels.id} < ${id})
        OR ${chatChannels.lastMessageAt} IS NULL
      )`;
    }
    return and(isNull(chatChannels.lastMessageAt), lt(chatChannels.id, id));
  }

  private async listMemberChannels(
    actor: EntityActor,
    archived: boolean,
    rawCursor: string | null,
    limit?: number,
  ) {
    const PAGE_SIZE = Math.min(limit ?? CHAT_CHANNEL_PAGE_SIZE, PAGE_SIZE_CAP);
    const { orgId } = actor;
    if (!actor.membershipId) return { channels: [], nextCursor: null };
    const actorMembershipId = actor.membershipId;
    const cursor = this.decodeChannelCursor(rawCursor);

    try {
      const pageRows = await this.db
        .select({ id: chatChannels.id, lastMessageAt: chatChannels.lastMessageAt })
        .from(chatChannelMembers)
        .innerJoin(
          chatChannels,
          and(
            eq(chatChannels.id, chatChannelMembers.channelId),
            eq(chatChannels.orgId, orgId),
            eq(chatChannels.isArchived, false),
          ),
        )
        .where(
          and(
            eq(chatChannelMembers.orgId, orgId),
            eq(chatChannelMembers.membershipId, actorMembershipId),
            archived ? isNotNull(chatChannelMembers.archivedAt) : isNull(chatChannelMembers.archivedAt),
            this.channelKeysetWhere(cursor),
          ),
        )
        .orderBy(desc(chatChannels.lastMessageAt), desc(chatChannels.id))
        .limit(PAGE_SIZE + 1);

      const hasMore = pageRows.length > PAGE_SIZE;
      const pageSlice = hasMore ? pageRows.slice(0, PAGE_SIZE) : pageRows;

      if (pageSlice.length === 0) return { channels: [], nextCursor: null };

      const lastRow = pageSlice[pageSlice.length - 1];
      const nextCursor = hasMore && lastRow
        ? this.encodeChannelCursor(lastRow.lastMessageAt, lastRow.id)
        : null;

      const channelIds = pageSlice.map((r) => r.id);

      const channels = await this.db.query.chatChannels.findMany({
        where: and(eq(chatChannels.orgId, orgId), inArray(chatChannels.id, channelIds)),
        columns: CHANNEL_LIST_COLUMNS,
      });

      const memberPreview = await loadChannelMemberPreview(this.db, orgId, channelIds, actorMembershipId);

      const unreadRows = await this.db
        .select({ channelId: chatMessages.channelId, count: count() })
        .from(chatMessages)
        .innerJoin(
          chatChannelMembers,
          and(
            eq(chatChannelMembers.channelId, chatMessages.channelId),
            eq(chatChannelMembers.membershipId, actorMembershipId),
            eq(chatChannelMembers.orgId, orgId),
          ),
        )
        .where(
          and(
            inArray(chatMessages.channelId, channelIds),
            eq(chatMessages.isDeleted, false),
            eq(chatMessages.orgId, orgId),
            gt(chatMessages.channelPosition, chatChannelMembers.lastReadPosition),
          ),
        )
        .groupBy(chatMessages.channelId);

      const unreadMap = new Map(unreadRows.map((r) => [r.channelId, r.count]));

      // One index probe per channel, not one full range read per channel.
      //
      // `SELECT DISTINCT ON (channel_id) … ORDER BY channel_id, created_at DESC` has no
      // btree skip scan available to it here, so Postgres's Unique node consumes EVERY
      // tuple the scan below it produces and throws away all but the first per channel.
      // Measured on 400,000 messages across 80 channels (scratch_bechat_perf,
      // `EXPLAIN (ANALYZE, BUFFERS)`, 50 channel ids, three warm runs):
      //
      //   DISTINCT ON   ~182 ms   6,839 shared buffers + 4,244 temp (external merge, 17 MB)
      //                           248,750 rows sorted to produce 50
      //   LATERAL         0.39 ms   203 shared buffers, no temp
      //
      // ~460x on time and ~33x on shared buffers, and the gap widens with history because
      // the DISTINCT ON reads the whole channel while the LATERAL reads one row of it.
      // The sidebar drains up to 20 pages per mount with `refetchOnWindowFocus`
      // (frontend `hooks/api/chat-core-read.ts:105-118`), so this is paid up to 20 times a
      // focus.
      //
      // Identical answers, not merely similar: `ORDER BY created_at DESC LIMIT 1` inside
      // the LATERAL is exactly what `DISTINCT ON` was keeping, the INNER join drops a
      // channel with no undeleted message exactly as `DISTINCT ON` did, and the sender
      // join stays a LEFT join so a departed sender still yields the message with a null
      // name. Verified by `EXCEPT` in both directions on the seeded set: 50 rows each,
      // zero rows on either side of the difference.
      const latestMessage = this.db
        .select({
          content: chatMessages.content,
          senderMembershipId: chatMessages.senderMembershipId,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        // `chatChannels.id` is not in this subquery's FROM, so drizzle renders it as the
        // outer reference `"chat_channels"."id"` — the lateral correlation.
        .where(
          and(
            eq(chatMessages.orgId, orgId),
            eq(chatMessages.channelId, chatChannels.id),
            eq(chatMessages.isDeleted, false),
          ),
        )
        .orderBy(desc(chatMessages.createdAt))
        .limit(1)
        .as("latest_message");

      const lastMessageRows = await this.db
        .select({
          channelId: chatChannels.id,
          content: latestMessage.content,
          senderUserId: organizationMembers.userId,
          createdAt: latestMessage.createdAt,
        })
        .from(chatChannels)
        .innerJoinLateral(latestMessage, sql`true`)
        .leftJoin(
          organizationMembers,
          and(
            eq(organizationMembers.id, latestMessage.senderMembershipId),
            eq(organizationMembers.orgId, orgId),
          ),
        )
        .where(and(eq(chatChannels.orgId, orgId), inArray(chatChannels.id, channelIds)));

      const lastMsgSenderIds = [...new Set(lastMessageRows.map((r) => r.senderUserId).filter((id): id is string => id !== null))];
      const senderIdentities = await resolvePeopleIdentities(
        this.db,
        orgId,
        lastMsgSenderIds.map((uid) => ({ kind: "user" as const, userId: uid })),
      );

      const lastMsgMap = new Map(
        lastMessageRows.map((r) => {
          const identity = r.senderUserId ? senderIdentities.get(subjectKey({ kind: "user", userId: r.senderUserId })) : undefined;
          const parts = [identity?.firstName, identity?.lastName].filter(Boolean).join(" ");
          const senderName = identity?.displayName ?? (parts || null);
          return [r.channelId, { content: r.content, senderName, createdAt: r.createdAt }];
        }),
      );

      const enrichedChannels = await this.resolveEntityChannelDisplayNames(channels, actor).catch(
        () => channels,
      );

      const orderedChannels = channelIds
        .map((id) => enrichedChannels.find((ch) => ch.id === id))
        .filter((ch): ch is NonNullable<typeof ch> => ch !== undefined)
        .map((ch) => ({
          ...withMemberPreview(ch, memberPreview),
          unreadCount: unreadMap.get(ch.id) ?? 0,
          lastMessage: lastMsgMap.get(ch.id) ?? null,
        }));

      return { channels: orderedChannels, nextCursor };
    } catch (error) {
      logger.error(archived ? "[chat.getArchivedChannels]" : "[chat.getMyChannels]", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw new InternalServerErrorException("Failed to load channels");
    }
  }
}
