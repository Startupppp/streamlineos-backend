import { Inject, Injectable } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, gte, ilike, inArray, lt, lte, or, sql } from "drizzle-orm";
import { chatChannelMembers, chatChannels, chatMessages, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import {
  SENDER_MEMBERSHIP_WITH_USER,
  flattenMessageSender,
} from "./chat-message-sender-shape";

const CHAT_SEARCH_ID_CAP = 1000;
const TRIGRAM_MIN_TERM_LENGTH = 3;

@Injectable()
export class ChatSearchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entities: EntityReferenceService,
  ) {}

  private async resolveContentMatch(term: string): Promise<SQL<unknown>> {
    const like = sql`${chatMessages.content} ILIKE ${"%" + term + "%"}`;
    if (term.length < TRIGRAM_MIN_TERM_LENGTH) return like;
    const idRows = await this.db.execute(
      sql`SELECT app.search_chat_message_ids(${term}, ${CHAT_SEARCH_ID_CAP + 1}) AS id`,
    );
    if (idRows.length > CHAT_SEARCH_ID_CAP) return like;
    const ids = idRows.map((row) => Number(row["id"]));
    if (ids.length === 0) return sql`false`;
    return inArray(chatMessages.id, ids);
  }

  async searchMessages(actor: EntityActor, query: string, limit = 20, cursor?: number, from?: string, to?: string, sender?: string) {
    const { orgId, membershipId } = actor;
    if (!membershipId) return { results: [], nextCursor: undefined };
    const term = query.trim();
    if (!term) return { results: [], nextCursor: undefined };

    const conditions = [
      eq(chatMessages.orgId, orgId),
      sql`EXISTS (SELECT 1 FROM ${chatChannelMembers} m
                  WHERE m.channel_id = ${chatMessages.channelId}
                    AND m.org_id = ${orgId}
                    AND m.membership_id = ${membershipId})`,
      await this.resolveContentMatch(term),
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
        channel: { columns: { id: true, name: true, type: true } },
      },
    });

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const resolved = await this.entities.withResolvedReferences(actor, rows);
    const results = resolved.map(flattenMessageSender);
    return { results, nextCursor: hasMore ? rows[rows.length - 1]?.id : undefined };
  }

  async searchChannels(orgId: string, userId: string, query: string) {
    if (!query.trim()) return [];
    const q = `%${query.trim()}%`;

    const memberChannels = await this.db
      .select({ channelId: chatChannelMembers.channelId })
      .from(chatChannelMembers)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.id, chatChannelMembers.membershipId),
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .where(eq(chatChannelMembers.orgId, orgId));

    const memberChannelIds = new Set(memberChannels.map(m => m.channelId));

    const channels = await this.db.query.chatChannels.findMany({
      where: and(
        eq(chatChannels.orgId, orgId),
        ilike(chatChannels.name, q),
      ),
      columns: { id: true, name: true, type: true, description: true, avatarUrl: true },
      limit: 10,
    });

    return channels.map(c => ({ ...c, isMember: memberChannelIds.has(c.id) }));
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
