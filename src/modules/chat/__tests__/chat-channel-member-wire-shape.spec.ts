import { ChatChannelMembersImplementation } from "../chat-channel-members-implementation";
import { loadChannelMemberPreview } from "../chat-channel-member-preview";
import {
  CHANNEL_LIST_MEMBER_WIRE_KEYS,
  CHANNEL_MEMBER_WIRE_KEYS,
  flattenChannelMember,
} from "../chat-channel-member-shape";
import { type Db } from "../../../db/drizzle.module";

/**
 * The payload shape, asserted on what the read paths RETURN — not on what a caller declares.
 *
 * `hooks/api/chat-core-read.ts` reads the detail route through `apiClient.get<Channel>(...)`, a cast.
 * The client's `ChannelMember` has always declared `user` and `userId` at the top level; every read
 * path shipped them two levels down under `membership`, because that is how the
 * `chat_channel_members -> organization_members -> users` join comes back from Drizzle. Nothing
 * could catch it: the cast made the compiler vouch for the declaration, and a typecheck of either
 * repo passed. So `channel.members.find((m) => m.user?.id !== me)` compared `undefined` to the
 * caller's id, matched the FIRST member of a DIRECT channel, read `.user` off it and got
 * `undefined` — every DIRECT header rendered "Unknown", the favourites filter matched nothing and
 * the channel-admin controls never appeared.
 *
 * These drive the real methods with a database double that answers in the NESTED shape the driver
 * actually produces, and assert the FLAT shape comes out — so the emission sites, not a type
 * alias, are what is under test.
 */

const ORG = "org-1";
const CHANNEL = 7;
const ME = "user-me";
const OTHER = "user-other";

const WIRE_KEYS = [...CHANNEL_MEMBER_WIRE_KEYS];

function nestedMemberRow(userId: string, over: Record<string, unknown> = {}) {
  return {
    id: userId === ME ? 1 : 2,
    channelId: CHANNEL,
    role: "MEMBER",
    lastReadAt: null,
    joinedAt: null,
    mutedUntil: null,
    archivedAt: null,
    isFavorite: false,
    notificationPreference: "DEFAULT",
    membership: {
      userId,
      user: { id: userId, name: userId === ME ? "Me" : "Ada Lovelace", image: null, email: `${userId}@test.com` },
    },
    ...over,
  };
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

function makeDb(memberRows: ReturnType<typeof nestedMemberRow>[]) {
  const channelWithMembers = {
    id: CHANNEL,
    orgId: ORG,
    name: "Me & Ada Lovelace",
    type: "DIRECT",
    isPrivate: true,
    members: memberRows,
  };
  return {
    query: {
      chatChannels: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({ id: CHANNEL, isPrivate: true })
          .mockResolvedValueOnce(channelWithMembers),
      },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      chatChannelMembers: {
        findFirst: jest.fn().mockResolvedValue({ role: "MEMBER" }),
        findMany: jest.fn().mockResolvedValue(memberRows),
      },
    },
  } as unknown as Db;
}

function makePreviewDb(rows: unknown[]) {
  const subqueryChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "leftJoin", "where", "orderBy", "groupBy", "limit"])
      chain[m] = jest.fn(() => chain);
    chain.as = jest.fn(() => ({ memberRank: { rankColumn: true } }));
    return chain;
  };
  const outerChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = jest.fn(() => chain);
    chain.where = jest.fn(() => chain);
    chain.then = (resolve: (v: unknown[]) => unknown) => resolve(rows);
    return chain;
  };
  return {
    select: jest.fn((projection?: unknown) => (projection === undefined ? outerChain() : subqueryChain())),
  } as unknown as Db;
}

function previewRow(userId: string, id: number) {
  return {
    id,
    channelId: CHANNEL,
    role: "MEMBER",
    mutedUntil: null,
    isFavorite: false,
    notificationPreference: "DEFAULT",
    membershipUserId: userId,
    userId,
    userName: userId === ME ? "Me" : "Ada Lovelace",
    userImage: null,
    memberCount: 2,
    memberRank: id,
  };
}

function build(db: Db) {
  return new ChatChannelMembersImplementation(
    db,
    { resolve: jest.fn() } as never,
  );
}

describe("chat channel member — one wire shape across every read path", () => {
  it("GET /chat/channels/:id puts the user at the top level, not under membership", async () => {
    const db = makeDb([nestedMemberRow(ME), nestedMemberRow(OTHER)]);
    const channel = await build(db).getChannel(CHANNEL, ME, ORG);

    const member = channel?.members[0];
    expect(member).toBeDefined();
    expect(sortedKeys(member as object)).toEqual(WIRE_KEYS);
    expect(member).not.toHaveProperty("membership");
    expect(member?.user?.id).toBe(ME);
    expect(member?.userId).toBe(ME);
  });

  it("GET /chat/channels/:id/members emits the identical key set", async () => {
    const db = makeDb([nestedMemberRow(ME), nestedMemberRow(OTHER)]);
    const { members } = await build(db).listMembers(CHANNEL, ME, ORG);

    expect(members).toHaveLength(2);
    for (const member of members) {
      expect(sortedKeys(member)).toEqual(WIRE_KEYS);
      expect(member).not.toHaveProperty("membership");
    }
  });

  it("the bounded list preview emits only the list subset of keys — detail-only fields are absent", async () => {
    const db = makePreviewDb([previewRow(ME, 1), previewRow(OTHER, 2)]);
    const page = (await loadChannelMemberPreview(db, ORG, [CHANNEL], 1)).get(CHANNEL);
    const LIST_KEYS = [...CHANNEL_LIST_MEMBER_WIRE_KEYS].sort();

    expect(page?.members).toHaveLength(2);
    for (const member of page?.members ?? []) {
      expect(sortedKeys(member)).toEqual(LIST_KEYS);
      expect(member).not.toHaveProperty("membership");
      expect(member).not.toHaveProperty("lastReadAt");
      expect(member).not.toHaveProperty("joinedAt");
      expect(member).not.toHaveProperty("archivedAt");
    }
  });

  it("the list preview still withholds the address the detail route carries", async () => {
    const db = makePreviewDb([previewRow(OTHER, 2)]);
    const previewMember = (await loadChannelMemberPreview(db, ORG, [CHANNEL], 1)).get(CHANNEL)?.members[0];
    const detailMember = (await build(makeDb([nestedMemberRow(OTHER)])).getChannel(CHANNEL, ME, ORG))?.members[0];

    expect(Object.keys(previewMember?.user ?? {})).not.toContain("email");
    expect(detailMember?.user?.email).toBe(`${OTHER}@test.com`);
  });

  it("keeps the tenant key and the internal join id off the wire entirely", async () => {
    const db = makeDb([nestedMemberRow(ME)]);
    const member = (await build(db).getChannel(CHANNEL, ME, ORG))?.members[0];

    expect(member).not.toHaveProperty("orgId");
    expect(member).not.toHaveProperty("membershipId");
  });

  it("a member whose user row is gone flattens to nulls, never to a missing key", () => {
    const flattened = flattenChannelMember({ id: 3, channelId: CHANNEL, membership: null });
    expect(flattened.user).toBeNull();
    expect(flattened.userId).toBeNull();
    expect("user" in flattened).toBe(true);
  });
});

/**
 * The consumer predicate, run against the real payload.
 *
 * `features/chat/use-message-panel-data.ts` resolves a DIRECT channel's header with
 * `members.find((m) => m.user?.id !== currentUserId)?.user`, falling back to "Unknown". The first
 * case is the bug as it shipped; the rest are the fix. Without the nested-shape case this file
 * would pass just as happily against the broken payload.
 */
describe("chat channel member — the DIRECT header predicate against the real payload", () => {
  const resolveOther = (members: { user?: { id: string; name: string | null } | null }[]) =>
    members.find((m) => m.user?.id !== ME)?.user;

  it("BITE: the pre-fix nested payload resolves the header to Unknown", () => {
    const nested = [nestedMemberRow(ME), nestedMemberRow(OTHER)] as unknown as Parameters<typeof resolveOther>[0];
    expect(resolveOther(nested)?.name ?? "Unknown").toBe("Unknown");
  });

  it("the detail route's payload resolves the header to the other party's real name", async () => {
    const db = makeDb([nestedMemberRow(ME), nestedMemberRow(OTHER)]);
    const channel = await build(db).getChannel(CHANNEL, ME, ORG);

    expect(resolveOther(channel?.members ?? [])?.name ?? "Unknown").toBe("Ada Lovelace");
  });

  it("the list preview's payload resolves it to the same name", async () => {
    const db = makePreviewDb([previewRow(ME, 1), previewRow(OTHER, 2)]);
    const page = (await loadChannelMemberPreview(db, ORG, [CHANNEL], 1)).get(CHANNEL);

    expect(resolveOther(page?.members ?? [])?.name ?? "Unknown").toBe("Ada Lovelace");
  });

  it("the caller's own row is findable, so favourites and admin controls resolve", async () => {
    const db = makeDb([nestedMemberRow(ME, { isFavorite: true, role: "ADMIN" }), nestedMemberRow(OTHER)]);
    const channel = await build(db).getChannel(CHANNEL, ME, ORG);
    const mine = channel?.members.find((m) => m.user?.id === ME);

    expect(mine?.isFavorite).toBe(true);
    expect(mine?.role).toBe("ADMIN");
  });
});
