import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { chatChannelMembers, organizationMembers, users } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import type { ChannelMemberWire } from "./chat-channel-member-shape";

/**
 * How many member rows one channel may put into the CHANNEL LIST.
 *
 * The list used to embed the channel's whole roster: `db.query.chatChannels.findMany` with an
 * unqualified `with: { members: … }` returns every row of `chat_channel_members` for every channel
 * on the page, so an org-wide channel put its entire headcount into a list response. The page size
 * bounded the channels and nothing bounded the members inside them. Measured over HTTP on the
 * seeded database, `GET /chat/channels` answered **436,371 bytes against a declared 131,072-byte
 * ceiling**; the two 500-member channels in that tenant contributed ~245 KB of member rows each.
 *
 * A list row needs a handful of members: the caller's own row (its `isFavorite`, `role`,
 * `lastReadAt` and notification preference drive the row's controls), the other party on a DIRECT
 * channel, and a short avatar stack. The full roster has its own paginated endpoint,
 * `GET /chat/channels/{channelId}/members`. Eight covers every one of those with headroom.
 */
export const CHANNEL_LIST_MEMBER_PREVIEW = 8;

/**
 * The channel columns a list row actually carries.
 *
 * `findMany` with no `columns` ships every column of the table, so `message_count`, `is_pinned`,
 * `linked_deal_id` and `created_by_membership_id` rode 50 rows of a list that renders none of them.
 */
export const CHANNEL_LIST_COLUMNS = {
  id: true,
  orgId: true,
  name: true,
  type: true,
  description: true,
  avatarUrl: true,
  isArchived: true,
  isPrivate: true,
  entityType: true,
  entityId: true,
  lastMessageAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The preview row is the same wire shape the detail route emits, minus `user.email` — eight rows of
 * an address per channel across a 50-channel page is exactly the payload this preview exists to cut,
 * and no list surface renders one.
 */
export type ChannelMemberPreview = ChannelMemberWire;

export interface ChannelMemberPreviewPage {
  members: ChannelMemberPreview[];
  memberCount: number;
}

/**
 * A bounded member preview plus the true member count, in ONE statement, for a page of channels.
 *
 * `count(*) over (partition by channel_id)` is taken before the rank filter cuts the rows, so the
 * count is the real roster size and never the preview's length — a truncated array must never have
 * to be counted to be reported. The ordering puts the caller's own row first (the list row's
 * controls read it and must never miss it), then admins, then oldest membership, so the preview is
 * deterministic across requests rather than whatever order the scan produced.
 *
 * One statement for the whole page, not one per channel: the ranking partitions by `channel_id`
 * over the page's ids, so widening the page does not add a round trip.
 */
export async function loadChannelMemberPreview(
  db: Db,
  orgId: string,
  channelIds: number[],
  actorMembershipId: number,
): Promise<Map<number, ChannelMemberPreviewPage>> {
  const result = new Map<number, ChannelMemberPreviewPage>();
  if (channelIds.length === 0) return result;

  const ranked = db
    .select({
      id: chatChannelMembers.id,
      channelId: chatChannelMembers.channelId,
      role: chatChannelMembers.role,
      lastReadAt: chatChannelMembers.lastReadAt,
      joinedAt: chatChannelMembers.joinedAt,
      mutedUntil: chatChannelMembers.mutedUntil,
      archivedAt: chatChannelMembers.archivedAt,
      isFavorite: chatChannelMembers.isFavorite,
      notificationPreference: chatChannelMembers.notificationPreference,
      // Explicit aliases, not the bare columns. A subquery projection keeps each column's own
      // name, so `chat_channel_members.id`, `organization_members.id` and `users.id` all arrive as
      // "id" and the outer SELECT is ambiguous — the query fails at the database with the three
      // duplicates plainly visible in the SQL, which is how this was caught.
      membershipUserId: sql<string | null>`${organizationMembers.userId}`.as("member_user_id"),
      userId: sql<string | null>`${users.id}`.as("user_row_id"),
      userName: sql<string | null>`${users.name}`.as("user_row_name"),
      userImage: sql<string | null>`${users.image}`.as("user_row_image"),
      memberCount: sql<number>`count(*) over (partition by ${chatChannelMembers.channelId})`.as("member_count"),
      memberRank: sql<number>`row_number() over (partition by ${chatChannelMembers.channelId} order by (${chatChannelMembers.membershipId} = ${actorMembershipId}) desc, (${chatChannelMembers.role} = 'ADMIN') desc, ${chatChannelMembers.id} asc)`.as(
        "member_rank",
      ),
    })
    .from(chatChannelMembers)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.id, chatChannelMembers.membershipId),
        eq(organizationMembers.orgId, chatChannelMembers.orgId),
      ),
    )
    .leftJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(chatChannelMembers.orgId, orgId), inArray(chatChannelMembers.channelId, channelIds)))
    .as("ranked_channel_members");

  const rows = await db.select().from(ranked).where(lte(ranked.memberRank, CHANNEL_LIST_MEMBER_PREVIEW));

  for (const row of rows) {
    const page = result.get(row.channelId) ?? { members: [], memberCount: Number(row.memberCount) };
    page.members.push({
      id: row.id,
      channelId: row.channelId,
      role: row.role,
      lastReadAt: row.lastReadAt,
      joinedAt: row.joinedAt,
      mutedUntil: row.mutedUntil,
      archivedAt: row.archivedAt,
      isFavorite: row.isFavorite,
      notificationPreference: row.notificationPreference,
      userId: row.membershipUserId,
      user: row.userId === null ? null : { id: row.userId, name: row.userName, image: row.userImage },
    });
    result.set(row.channelId, page);
  }
  return result;
}

/**
 * Attach the preview to a channel row.
 *
 * `memberCount` rides beside the array so a truncated preview never has to be counted to be
 * reported, and `membersTruncated` says outright that the array is a preview rather than leaving a
 * consumer to infer it from a length it cannot trust.
 */
export function withMemberPreview<T extends { id: number }>(
  channel: T,
  preview: Map<number, ChannelMemberPreviewPage>,
): T & { members: ChannelMemberPreview[]; memberCount: number; membersTruncated: boolean } {
  const page = preview.get(channel.id);
  const members = page?.members ?? [];
  const memberCount = page?.memberCount ?? 0;
  return { ...channel, members, memberCount, membersTruncated: memberCount > members.length };
}
