import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import {
  chatChannelMembers,
  chatMessages,
  chatUserPresence,
  organizationMembers,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import type { StatusInput } from "./dto/chat.schemas";
import { chatMessageContentMatch } from "./chat-message-content-match";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import type { EntityActor } from "../entity-reference/entity-reference.types";
import { filterByEntityAccess } from "./chat-channel-authorization";

const PRESENCE_WINDOW_MS = 90 * 1000;

/**
 * The ceiling on `GET /chat/unread`. 100, not 99: the one consumer renders "99+" above 99,
 * so a saturated answer must be strictly greater than 99 to be indistinguishable from the
 * true total there.
 */
const UNREAD_TOTAL_CAP = 100;

@Injectable()
export class ChatPresenceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly entities: EntityReferenceService,
  ) {}

  private async resolveMembershipId(orgId: string, userId: string): Promise<number | null> {
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

  async heartbeat(userId: string, orgId: string) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    if (!membershipId) return { ok: true };
    await this.db
      .insert(chatUserPresence)
      .values({ orgId, membershipId, status: "ONLINE", lastSeenAt: new Date() })
      .onConflictDoUpdate({
        target: [chatUserPresence.orgId, chatUserPresence.membershipId],
        set: { status: "ONLINE", lastSeenAt: new Date() },
      });

    return { ok: true };
  }

  getOnlineUsers(orgId: string) {
    const cutoff = new Date(Date.now() - PRESENCE_WINDOW_MS);

    return this.db
      .select({
        userId: organizationMembers.userId,
        status: chatUserPresence.status,
        lastSeenAt: chatUserPresence.lastSeenAt,
        userName: users.name,
        userImage: users.image,
      })
      .from(chatUserPresence)
      .innerJoin(organizationMembers, eq(organizationMembers.id, chatUserPresence.membershipId))
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(chatUserPresence.orgId, orgId), gt(chatUserPresence.lastSeenAt, cutoff)))
      .limit(500);
  }

  async setStatus(userId: string, orgId: string, body: StatusInput) {
    const membershipId = await this.resolveMembershipId(orgId, userId);
    if (!membershipId) return { ok: true };
    await this.db
      .insert(chatUserPresence)
      .values({ orgId, membershipId, status: body.status, lastSeenAt: new Date() })
      .onConflictDoUpdate({
        target: [chatUserPresence.orgId, chatUserPresence.membershipId],
        set: { status: body.status, lastSeenAt: new Date() },
      });

    return { ok: true };
  }

  /**
   * The badge total, bounded.
   *
   * Two things were wrong with the uncapped join this replaces. It carried NO `org_id`
   * predicate on either side — not a cross-tenant leak (`organization_members.id` and
   * `chat_channels.id` are globally unique identity columns and RLS supplies the tenant
   * qual for the `bypassrls = false` app role) but it cost the planner the LEADING column
   * of `idx_chat_messages_unread`, so the index could only be entered on `channel_id`. And
   * it counted every unread message in every channel with no ceiling, which is unbounded
   * in the user's absence: one week away makes the badge slower without limit.
   *
   * Measured on 400,000 messages / 80 channels (scratch_bechat_perf, `EXPLAIN (ANALYZE,
   * BUFFERS)`):
   *   shipped            502.5 ms, 3,116 shared buffers, 398,000 rows counted, 8 MB memoize
   *   + org predicates   ~1,756 shared buffers
   *   + total cap (this)   1.4 ms,   235 shared buffers, Index Only Scan, Heap Fetches 0
   *
   * The cap is on the WHOLE count, not per channel, so the number is EXACT below it and
   * saturates at the cap above it — a per-channel cap would under-report a real total. The
   * only consumer is the sidebar (`components/layout/app-sidebar.tsx:188-197`), which
   * renders `total > 99 ? "99+" : total`, so every value this can now return renders
   * identically to the uncapped one.
   */
  async getUnreadTotal(userId: string, orgId: string): Promise<number> {
    try {
      const membershipId = await this.resolveMembershipId(orgId, userId);
      if (!membershipId) return 0;
      const capped = this.db
        .select({ one: sql<number>`1` })
        .from(chatChannelMembers)
        .innerJoin(
          chatMessages,
          and(
            eq(chatMessages.orgId, chatChannelMembers.orgId),
            eq(chatMessages.channelId, chatChannelMembers.channelId),
            gt(chatMessages.channelPosition, chatChannelMembers.lastReadPosition),
            eq(chatMessages.isDeleted, false),
          ),
        )
        .where(
          and(
            eq(chatChannelMembers.orgId, orgId),
            eq(chatChannelMembers.membershipId, membershipId),
          ),
        )
        .limit(UNREAD_TOTAL_CAP)
        .as("capped_unread");

      const [row] = await this.db.select({ total: count() }).from(capped);

      return row?.total ?? 0;
    } catch (error) {
      logger.error("[chat.getUnreadTotal]", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return 0;
    }
  }

  async searchMessages(actor: EntityActor, query: string, channelId: number | undefined, limit: number) {
    const { orgId, userId } = actor;
    const membershipId = await this.resolveMembershipId(orgId, userId);
    if (!membershipId) return [];
    const memberExistsCondition = sql`EXISTS (SELECT 1 FROM ${chatChannelMembers} m
                    WHERE m.channel_id = ${chatMessages.channelId}
                      AND m.org_id = ${orgId}
                      AND m.membership_id = ${membershipId})`;
    // The SAME content predicate `/chat/search/messages` uses, not a second one.
    // This route shipped a bare `content ILIKE '%q%'` with no trigram helper and no id
    // cap, so a member could loop it and drive a full scan of the tenant's message table;
    // `chatMessageContentMatch` routes any term of 3+ characters through
    // `app.search_chat_message_ids` and caps the id set at 1,000. The route, its query
    // schema and its response shape are unchanged — only the predicate's cost ceiling is.
    const conditions = [
      eq(chatMessages.orgId, orgId),
      await chatMessageContentMatch(this.db, query.trim()),
      eq(chatMessages.isDeleted, false),
      memberExistsCondition,
    ];

    if (channelId) conditions.push(eq(chatMessages.channelId, channelId));

    const rows = await this.db.query.chatMessages.findMany({
      where: and(...conditions),
      orderBy: [desc(chatMessages.createdAt)],
      limit: Math.min(limit, 50),
      with: {
        senderMembership: { columns: { id: true }, with: { user: { columns: { id: true, name: true, image: true } } } },
        channel: {
          columns: { id: true, name: true, type: true, entityType: true, entityId: true },
        },
      },
    });
    const visible = await filterByEntityAccess(this.entities, rows, actor, (row) => row.channel);
    return visible.map((row) => ({
      ...row,
      channel: row.channel
        ? { id: row.channel.id, name: row.channel.name, type: row.channel.type }
        : row.channel,
    }));
  }

  getOrgUsers(orgId: string) {
    return this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
        role: organizationMembers.role,
      })
      .from(users)
      .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
      .where(
        and(eq(users.isActive, true), eq(organizationMembers.orgId, orgId)),
      )
      .limit(500);
  }
}
