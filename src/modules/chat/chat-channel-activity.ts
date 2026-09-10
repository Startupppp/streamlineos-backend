import { and, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { chatChannelMembers, chatChannels, chatMessages, organizationMembers } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { resolvePeopleIdentities, subjectKey } from "../directory/person-seam";

/** Loads tenant-scoped sidebar activity with one latest-message probe per channel. */
export async function loadChannelActivity(
  db: Db,
  orgId: string,
  channelIds: number[],
  actorMembershipId: number,
) {
  const unreadRows = await db
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
  const latestMessage = db
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

  const lastMessageRows = await db
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
    db,
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

  return { unreadCounts: unreadMap, lastMessages: lastMsgMap };
}
