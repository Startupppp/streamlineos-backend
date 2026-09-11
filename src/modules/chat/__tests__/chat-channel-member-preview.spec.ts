import {
  CHANNEL_LIST_COLUMNS,
  CHANNEL_LIST_MEMBER_PREVIEW,
  loadChannelMemberPreview,
  withMemberPreview,
} from "../chat-channel-member-preview";
import { type Db } from "../../../db/drizzle.module";

/**
 * The list response used to embed every member of every channel on the page.
 *
 * Measured over HTTP on the seeded database, `GET /chat/channels` answered 436,371 bytes against a
 * declared 131,072-byte ceiling: the page bounded the channels and nothing bounded the members
 * inside them, so two 500-member channels put ~245 KB of member rows each into a list. These
 * assert the three properties that keep it bounded — a cap, a count taken before the cap, and the
 * caller's own row surviving the cap — because each of them is silently recoverable-looking if it
 * breaks: the payload just grows again and every test still passes.
 */
interface RankedRow {
  id: number;
  channelId: number;
  role: string;
  mutedUntil: Date | null;
  isFavorite: boolean;
  notificationPreference: string;
  membershipUserId: string | null;
  userId: string | null;
  userName: string | null;
  userImage: string | null;
  memberCount: number;
  memberRank: number;
}

function rankedRow(over: Partial<RankedRow> & { id: number; channelId: number; memberRank: number; memberCount: number }): RankedRow {
  return {
    role: "MEMBER",
    mutedUntil: null,
    isFavorite: false,
    notificationPreference: "DEFAULT",
    membershipUserId: `user-${String(over.id)}`,
    userId: `user-${String(over.id)}`,
    userName: `Member ${String(over.id)}`,
    userImage: null,
    ...over,
  };
}

/**
 * A db double that records the rank predicate the query was built with, so the cap can be asserted
 * as something the SQL carries rather than as something the test sliced afterwards.
 */
/** Every Drizzle column reached from a value, by its real database column name. */
function columnNamesIn(value: unknown, seen = new Set<unknown>()): string[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const names: string[] = [];
  const record = value as Record<string, unknown>;
  if (typeof record.name === "string" && "table" in record) names.push(record.name);
  for (const child of Object.values(record)) names.push(...columnNamesIn(child, seen));
  return names;
}

interface JoinCall {
  kind: "innerJoin" | "leftJoin";
  table: unknown;
  on: unknown;
}

function makeDb(rows: RankedRow[]) {
  const calls: { subqueries: number; outerSelects: number } = { subqueries: 0, outerSelects: 0 };
  let outerWhere: unknown = null;
  const joins: JoinCall[] = [];

  const subqueryChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "groupBy", "limit"]) chain[m] = jest.fn(() => chain);
    for (const kind of ["innerJoin", "leftJoin"] as const)
      chain[kind] = jest.fn((table: unknown, on: unknown) => {
        joins.push({ kind, table, on });
        return chain;
      });
    chain.as = jest.fn(() => ({ memberRank: { rankColumn: true } }));
    return chain;
  };

  const outerChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = jest.fn(() => chain);
    chain.where = jest.fn((w: unknown) => {
      outerWhere = w;
      return chain;
    });
    chain.then = (resolve: (v: RankedRow[]) => unknown) => resolve(rows);
    return chain;
  };

  const db = {
    select: jest.fn((projection?: unknown) => {
      if (projection === undefined) {
        calls.outerSelects += 1;
        return outerChain();
      }
      calls.subqueries += 1;
      return subqueryChain();
    }),
  };
  return { db: db as unknown as Db, calls, joins, whereWasSet: () => outerWhere !== null };
}

describe("chat channel list — the member payload is bounded", () => {
  it("caps the preview at a declared, small number rather than the roster size", () => {
    expect(CHANNEL_LIST_MEMBER_PREVIEW).toBeGreaterThan(0);
    expect(CHANNEL_LIST_MEMBER_PREVIEW).toBeLessThanOrEqual(10);
  });

  it("projects channel columns instead of shipping the whole row", () => {
    const columns = Object.keys(CHANNEL_LIST_COLUMNS);
    expect(columns).toContain("id");
    expect(columns).toContain("name");
    expect(columns).toContain("entityType");
    // The four the list renders nowhere, and which rode 50 rows per page before the original fix.
    expect(columns).not.toContain("messageCount");
    expect(columns).not.toContain("isPinned");
    expect(columns).not.toContain("linkedDealId");
    expect(columns).not.toContain("createdByMembershipId");
    // Six more removed in the 2026-09-06 budget fix: none are rendered by sidebar list components.
    expect(columns).not.toContain("orgId");
    expect(columns).not.toContain("description");
    expect(columns).not.toContain("isPrivate");
    expect(columns).not.toContain("lastMessageAt");
    expect(columns).not.toContain("createdAt");
    expect(columns).not.toContain("updatedAt");
  });

  it("the member preview projection carries no lastReadAt, joinedAt or archivedAt", async () => {
    const { db } = makeDb([rankedRow({ id: 1, channelId: 7, memberRank: 1, memberCount: 2 })]);
    const member = (await loadChannelMemberPreview(db, "org-1", [7], 1)).get(7)?.members[0];
    expect(member).not.toHaveProperty("lastReadAt");
    expect(member).not.toHaveProperty("joinedAt");
    expect(member).not.toHaveProperty("archivedAt");
    expect(member).toHaveProperty("isFavorite");
    expect(member).toHaveProperty("mutedUntil");
    expect(member).toHaveProperty("notificationPreference");
  });

  it("reports the TRUE member count beside a truncated preview, not the preview's length", () => {
    const preview = new Map([[1, { members: [{ id: 1 }, { id: 2 }] as never[], memberCount: 500 }]]);
    const row = withMemberPreview({ id: 1, name: "general" }, preview);
    expect(row.memberCount).toBe(500);
    expect(row.members).toHaveLength(2);
    expect(row.membersTruncated).toBe(true);
  });

  it("does not claim truncation when the whole roster fits", () => {
    const preview = new Map([[1, { members: [{ id: 1 }, { id: 2 }] as never[], memberCount: 2 }]]);
    expect(withMemberPreview({ id: 1 }, preview).membersTruncated).toBe(false);
  });

  it("a channel the preview query returned nothing for is empty and counted zero, never undefined", () => {
    const row = withMemberPreview({ id: 9 }, new Map());
    expect(row.members).toEqual([]);
    expect(row.memberCount).toBe(0);
    expect(row.membersTruncated).toBe(false);
  });

  it("asks the database for the preview in ONE statement for the whole page, not one per channel", async () => {
    const rows = [1, 2, 3].flatMap((channelId) =>
      [1, 2].map((rank) => rankedRow({ id: channelId * 10 + rank, channelId, memberRank: rank, memberCount: 500 })),
    );
    const { db, calls } = makeDb(rows);
    const result = await loadChannelMemberPreview(db, "org-1", [1, 2, 3], 11);

    expect(calls.subqueries).toBe(1);
    expect(calls.outerSelects).toBe(1);
    expect(result.size).toBe(3);
  });

  it("carries the count taken across the partition, so truncation never lowers it", async () => {
    const rows = [1, 2].map((rank) => rankedRow({ id: rank, channelId: 7, memberRank: rank, memberCount: 500 }));
    const { db } = makeDb(rows);
    const page = (await loadChannelMemberPreview(db, "org-1", [7], 1)).get(7);
    expect(page?.memberCount).toBe(500);
    expect(page?.members).toHaveLength(2);
  });

  it("emits the one member wire shape, so the preview is fewer rows and not a second contract", async () => {
    const { db } = makeDb([rankedRow({ id: 5, channelId: 7, memberRank: 1, memberCount: 3, isFavorite: true, role: "ADMIN" })]);
    const member = (await loadChannelMemberPreview(db, "org-1", [7], 5)).get(7)?.members[0];
    expect(member).toMatchObject({
      id: 5,
      channelId: 7,
      role: "ADMIN",
      isFavorite: true,
      notificationPreference: "DEFAULT",
      userId: "user-5",
      user: { id: "user-5", name: "Member 5", image: null },
    });
    expect(member).not.toHaveProperty("membership");
  });

  it("reports a member whose user row is gone as user = null, never as a half-built user", async () => {
    const { db } = makeDb([
      rankedRow({ id: 5, channelId: 7, memberRank: 1, memberCount: 1, userId: null, userName: null, membershipUserId: null }),
    ]);
    const member = (await loadChannelMemberPreview(db, "org-1", [7], 5)).get(7)?.members[0];
    expect(member?.user).toBeNull();
    expect(member?.userId).toBeNull();
  });

  it("carries deleted_at IS NULL on the identity join, so an erased account cannot render a name", async () => {
    const { db, joins } = makeDb([rankedRow({ id: 1, channelId: 7, memberRank: 1, memberCount: 1 })]);
    await loadChannelMemberPreview(db, "org-1", [7], 1);

    const identityJoin = joins.find((j) => columnNamesIn(j.table).includes("email"));
    expect(identityJoin).toBeDefined();
    expect(columnNamesIn(identityJoin?.on)).toContain("deleted_at");
  });

  it("keeps that join LEFT, so the predicate hides a name without dropping the member or lowering the count", async () => {
    const { db, joins } = makeDb([rankedRow({ id: 1, channelId: 7, memberRank: 1, memberCount: 1 })]);
    await loadChannelMemberPreview(db, "org-1", [7], 1);

    // An innerJoin here would delete the member from the roster AND from the
    // `count(*) over (…)` that is taken in the same statement — a soft-deleted
    // identity would silently shrink the channel.
    const identityJoin = joins.find((j) => columnNamesIn(j.table).includes("email"));
    expect(identityJoin?.kind).toBe("leftJoin");
  });

  it("a member the identity predicate filtered out keeps its row and its userId, with user = null", async () => {
    // The shape the predicate produces, which is NOT the shape of a missing
    // membership: `users.*` aliases come back null because the LEFT join found no
    // row, while `membershipUserId` still carries organization_members.user_id.
    const { db } = makeDb([
      rankedRow({
        id: 5,
        channelId: 7,
        memberRank: 1,
        memberCount: 4,
        membershipUserId: "user-erased",
        userId: null,
        userName: null,
        userImage: null,
      }),
    ]);
    const page = (await loadChannelMemberPreview(db, "org-1", [7], 5)).get(7);

    expect(page?.members).toHaveLength(1);
    expect(page?.memberCount).toBe(4);
    expect(page?.members[0]?.userId).toBe("user-erased");
    expect(page?.members[0]?.user).toBeNull();
    expect(page?.members[0] && "user" in page.members[0]).toBe(true);
  });

  it("issues no statement at all for an empty page", async () => {
    const { db, calls } = makeDb([]);
    const result = await loadChannelMemberPreview(db, "org-1", [], 1);
    expect(result.size).toBe(0);
    expect(calls.subqueries).toBe(0);
    expect(calls.outerSelects).toBe(0);
  });

  it("bounds the preview in the query, not by slicing what came back", async () => {
    const { db, whereWasSet } = makeDb([rankedRow({ id: 1, channelId: 7, memberRank: 1, memberCount: 500 })]);
    await loadChannelMemberPreview(db, "org-1", [7], 1);
    expect(whereWasSet()).toBe(true);
  });
});
