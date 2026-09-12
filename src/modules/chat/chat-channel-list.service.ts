import { Inject, Injectable, InternalServerErrorException } from "@nestjs/common";
import { and, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { decodeChannelCursor, encodeChannelCursor, channelKeysetWhere } from "./chat-channel-cursor";
import {
  chatChannelMembers,
  chatChannels,
  organizationMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import { loadChannelActivity } from "./chat-channel-activity";
import { PAGE_SIZE_CAP } from "../../common/pagination/list-query.schema";
import { MAX_CAPABILITY_CHANNELS } from "../realtime/ably.service";
import {
  CHANNEL_LIST_COLUMNS,
  loadChannelMemberPreview,
  withMemberPreview,
} from "./chat-channel-member-preview";
import { filterByEntityAccess } from "./chat-channel-authorization";

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
  async listMemberChannelIds(actor: EntityActor): Promise<number[]> {
    const { orgId, userId } = actor;
    const membershipId = await this.getMembershipId(orgId, userId);
    if (membershipId === null) return [];
    const rows = await this.db
      .select({
        channelId: chatChannels.id,
        entityType: chatChannels.entityType,
        entityId: chatChannels.entityId,
      })
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
    const visible = await filterByEntityAccess(this.entities, rows, actor, (row) => row);
    return visible.map((row) => row.channelId);
  }

  async listPublicChannels(orgId: string, userId: string, cursor?: string | null, limit?: number) {
    const currentMembershipId = await this.getMembershipId(orgId, userId);
    if (currentMembershipId === null) return { channels: [], nextCursor: null };
    const PAGE_SIZE = Math.min(limit ?? CHAT_CHANNEL_PAGE_SIZE, PAGE_SIZE_CAP);
    const decoded = decodeChannelCursor(cursor ?? null);
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
      .where(and(eq(chatChannels.orgId, orgId), eq(chatChannels.type, "PUBLIC"), eq(chatChannels.isArchived, false), channelKeysetWhere(decoded)))
      .orderBy(desc(chatChannels.lastMessageAt), desc(chatChannels.id))
      .limit(PAGE_SIZE + 1);
    const hasMore = pageRows.length > PAGE_SIZE;
    const pageSlice = hasMore ? pageRows.slice(0, PAGE_SIZE) : pageRows;
    if (pageSlice.length === 0) return { channels: [], nextCursor: null };
    const channelIds = pageSlice.map((r) => r.id);
    const lastRow = pageSlice[pageSlice.length - 1];
    const nextCursor = hasMore && lastRow ? encodeChannelCursor(lastRow.lastMessageAt, lastRow.id) : null;
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
    const cursor = decodeChannelCursor(rawCursor);

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
            channelKeysetWhere(cursor),
          ),
        )
        .orderBy(desc(chatChannels.lastMessageAt), desc(chatChannels.id))
        .limit(PAGE_SIZE + 1);

      const hasMore = pageRows.length > PAGE_SIZE;
      const pageSlice = hasMore ? pageRows.slice(0, PAGE_SIZE) : pageRows;

      if (pageSlice.length === 0) return { channels: [], nextCursor: null };

      const lastRow = pageSlice[pageSlice.length - 1];
      const nextCursor = hasMore && lastRow
        ? encodeChannelCursor(lastRow.lastMessageAt, lastRow.id)
        : null;

      const pageChannelIds = pageSlice.map((r) => r.id);

      const pageChannels = await this.db.query.chatChannels.findMany({
        where: and(eq(chatChannels.orgId, orgId), inArray(chatChannels.id, pageChannelIds)),
        columns: CHANNEL_LIST_COLUMNS,
      });

      const channels = await filterByEntityAccess(
        this.entities,
        pageChannels,
        actor,
        (channel) => channel,
      ).catch(() =>
        pageChannels.filter((channel) => !channel.entityType || !channel.entityId),
      );
      const visibleIds = new Set(channels.map((channel) => channel.id));
      const channelIds = pageChannelIds.filter((id) => visibleIds.has(id));

      if (channelIds.length === 0) return { channels: [], nextCursor };

      const memberPreview = await loadChannelMemberPreview(this.db, orgId, channelIds, actorMembershipId);

      const { unreadCounts, lastMessages } = await loadChannelActivity(
        this.db, orgId, channelIds, actorMembershipId,
      );

      const enrichedChannels = await this.resolveEntityChannelDisplayNames(channels, actor).catch(
        () => channels,
      );

      const orderedChannels = channelIds
        .map((id) => enrichedChannels.find((ch) => ch.id === id))
        .filter((ch): ch is NonNullable<typeof ch> => ch !== undefined)
        .map((ch) => ({
          ...withMemberPreview(ch, memberPreview),
          unreadCount: unreadCounts.get(ch.id) ?? 0,
          lastMessage: lastMessages.get(ch.id) ?? null,
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
