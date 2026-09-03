/**
 * The one wire shape for a chat channel member.
 *
 * `chat_channel_members` joins to `users` through `organization_members`, and every read path used
 * to ship that join verbatim: `with: { membership: { with: { user } } }` puts the identity two
 * levels down, under a table name that is a tenancy detail the chat client has no business knowing.
 * The client's own declared type has always said `user` and `userId` at the top level, so
 * `member.user` was `undefined` on every response — `find((m) => m.user?.id !== me)` matched the
 * first row it saw, DIRECT headers rendered "Unknown", the favourites filter never matched and the
 * channel-admin controls never appeared. A `apiClient.get<Channel>` cast let the compiler vouch for
 * all of it.
 *
 * So the join is flattened here, once, and every route that emits a member goes through it: the
 * detail route, the paginated member list, the entity-channel read and the bounded list preview.
 * `CHANNEL_MEMBER_WIRE_KEYS` is the contract those routes are held to.
 */

export interface ChannelMemberUser {
  id: string;
  name: string | null;
  image: string | null;
  email?: string | null;
}

export interface ChannelMemberWire {
  id: number;
  channelId: number;
  userId: string | null;
  role: string;
  lastReadAt: Date | null;
  joinedAt: Date | null;
  mutedUntil: Date | null;
  archivedAt: Date | null;
  isFavorite: boolean;
  notificationPreference: string;
  user: ChannelMemberUser | null;
}

/**
 * Every key a member carries on the wire, and nothing else.
 *
 * `orgId` and `membershipId` are deliberately absent: the caller's tenant is already the only one
 * it can read and the membership id is an internal join key, so both were payload the client never
 * read. The list preview omits `user.email` — it is optional on the wire for that reason — because
 * eight rows of it per channel across a 50-channel page is the payload the preview exists to cut.
 */
export const CHANNEL_MEMBER_WIRE_KEYS = [
  "archivedAt",
  "channelId",
  "id",
  "isFavorite",
  "joinedAt",
  "lastReadAt",
  "mutedUntil",
  "notificationPreference",
  "role",
  "user",
  "userId",
] as const;

/**
 * The columns a member row selects. Passing this to `columns:` is what keeps `orgId` and
 * `membershipId` off the wire rather than trusting a downstream `delete`.
 */
export const CHANNEL_MEMBER_COLUMNS = {
  id: true,
  channelId: true,
  role: true,
  lastReadAt: true,
  joinedAt: true,
  mutedUntil: true,
  archivedAt: true,
  isFavorite: true,
  notificationPreference: true,
} as const;

/** The membership sub-select the flattener consumes. Kept beside it so the two cannot drift. */
export const CHANNEL_MEMBER_MEMBERSHIP_WITH = {
  columns: { userId: true },
  with: { user: { columns: { id: true, name: true, image: true, email: true } } },
} as const;

interface NestedMemberRow {
  membership?: {
    userId?: string | null;
    user?: ChannelMemberUser | null;
  } | null;
}

/**
 * Lift `membership.userId` and `membership.user` to the top level and drop the join wrapper.
 *
 * A member whose `organization_members` row is gone flattens to `userId: null, user: null` rather
 * than to a missing key, so a consumer reading `m.user?.id` gets the same answer either way.
 */
export function flattenChannelMember<T extends NestedMemberRow>(
  row: T,
): Omit<T, "membership"> & { userId: string | null; user: ChannelMemberUser | null } {
  const { membership, ...rest } = row;
  return {
    ...rest,
    userId: membership?.userId ?? null,
    user: membership?.user ?? null,
  };
}
