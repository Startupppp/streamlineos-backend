import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { chatChannelMembers, organizationMembers, users } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

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
 * A list row needs a handful of members: the caller's own row (its `isFavorite`, `role` and
 * notification preference drive the row's controls), the other party on a DIRECT channel, and a
 * short avatar stack. The full roster has its own paginated endpoint,
 * `GET /chat/channels/{channelId}/members`. Eight covers every one of those with headroom.
 */
export const CHANNEL_LIST_MEMBER_PREVIEW = 8;

/**
 * The channel columns a list row actually carries.
 *
 * Six columns that the sidebar never renders were removed in the 2026-09-06 budget fix:
 * `orgId` (read from the session, never from the channel object), `description` (detail panel only),
 * `isPrivate` (no list surface reads it), `lastMessageAt` (cursor uses the id query; nothing renders
 * this column), `createdAt` (detail panel only) and `updatedAt` (nothing renders it).
 * Removing them saves ~156 bytes per channel × 50 channels = ~7.8 KB per page.
 */
export const CHANNEL_LIST_COLUMNS = {
  id: true,
  name: true,
  type: true,
  avatarUrl: true,
  isArchived: true,
  entityType: true,
  entityId: true,
} as const;

/**
 * The list member preview: a subset of the full member wire shape.
 *
 * `lastReadAt`, `joinedAt` and `archivedAt` are present on the detail route but are never consumed
 * by any list-rendering component — the unread count is a pre-computed integer on the channel row,
 * `joinedAt` is not displayed in the sidebar, and `archivedAt` is read only by the channel info
 * panel which fetches via the detail route. Removing the three ISO strings saves ~93 bytes ×
 * 8 preview members × 50 channels = ~37 KB per page.
 */
export interface ChannelMemberPreview {
  id: number;
  channelId: number;
  userId: string | null;
  role: string;
  mutedUntil: Date | null;
  isFavorite: boolean;
  notificationPreference: string;
  user: { id: string; name: string | null; image: string | null } | null;
}

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
      mutedUntil: chatChannelMembers.mutedUntil,
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
    // `deleted_at IS NULL` on the identity join, and it stays a LEFT join: a member whose user row
    // is gone keeps its row and flattens to `user: null`, exactly as `flattenChannelMember` does
    // for a missing membership, rather than dropping the member out of the roster and out of the
    // `count(*) over (…)` above it.
    //
    // This is defence in depth, not a live repair, and the distinction is why the sibling reads do
    // NOT carry it. `users.deleted_at` has exactly one writer — `UsersService.deleteUser` — and it
    // calls `removeMember` FIRST, which hard-DELETEs the `organization_members` row. Every member
    // read in chat, this one and the relational ones alike, reaches `users` only THROUGH that row,
    // so a soft-deleted user is already unreachable from a channel roster and the two shapes cannot
    // currently disagree about a name. The sibling reads (`chat-channels.service.ts`,
    // `chat-channel-members-implementation.ts`) use `CHANNEL_MEMBER_MEMBERSHIP_WITH`, where `user`
    // is a Drizzle `one` relation and `with:` takes no `where` — expressing the same predicate there
    // means selecting `deleted_at` into the projection and suppressing it in the flattener, which
    // buys nothing while the state is unreachable and puts a column the client contract forbids one
    // spread away from the wire.
    .leftJoin(users, and(eq(users.id, organizationMembers.userId), isNull(users.deletedAt)))
    // No `archivedAt IS NULL` here. `chat_channel_members.archived_at` is the
    // CALLER'S OWN inbox state, not a membership lifecycle — archiving a chat sets it
    // on your row and leaves you a member. Filtering on it dropped the caller's row
    // out of the preview of every channel they had archived, so `GET
    // /chat/channels/archived` answered rows whose `members` was short by exactly the
    // reader. On a self-DM, where the caller is the only member, `members` came back
    // empty and the row rendered "??" / "Unknown" with `memberCount: 0`, while the
    // same conversation opened under its correct name (CHAT-004). It also meant an
    // archived row's favourite, mute, role and notification controls read defaults,
    // because every one of those is on the caller's own member row.
    .where(and(eq(chatChannelMembers.orgId, orgId), inArray(chatChannelMembers.channelId, channelIds)))
    .as("ranked_channel_members");

  const rows = await db.select().from(ranked).where(lte(ranked.memberRank, CHANNEL_LIST_MEMBER_PREVIEW));

  for (const row of rows) {
    const page = result.get(row.channelId) ?? { members: [], memberCount: Number(row.memberCount) };
    page.members.push({
      id: row.id,
      channelId: row.channelId,
      role: row.role,
      mutedUntil: row.mutedUntil,
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
