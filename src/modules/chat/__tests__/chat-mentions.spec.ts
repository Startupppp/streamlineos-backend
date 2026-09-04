import { MENTION_RECIPIENT_CAP, resolveMentionedUserIds } from "../chat-mentions";

const ALEX = "user-alex";
const ALEXANDER = "user-alexander";
const SENDER = "user-sender";

const rosterMembers = [
  { userId: ALEX, name: "Alex" },
  { userId: ALEXANDER, name: "Alexander" },
  { userId: SENDER, name: "Sam" },
];

function makeDb(members: { userId: string; name: string }[]) {
  const findMany = jest.fn().mockResolvedValue(
    members.map((m, i) => ({ membershipId: i + 1, membership: { userId: m.userId } })),
  );
  const limit = jest.fn().mockResolvedValue([]);
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnValue({ limit }),
    }),
    query: {
      chatChannelMembers: { findMany },
    },
  };
  return { db: db as never, findMany, limit };
}

describe("resolveMentionedUserIds", () => {
  it("notifies exactly the person the composer picked", async () => {
    const { db, limit } = makeDb(rosterMembers);
    limit.mockResolvedValueOnce([{ userId: ALEX }]);
    expect(await resolveMentionedUserIds(db, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "hi @Alex", mentionedUserIds: [ALEX],
    })).toEqual([ALEX]);
  });

  it("does not notify someone whose name merely contains the mention", async () => {
    const { db, limit } = makeDb(rosterMembers);
    limit.mockResolvedValueOnce([{ userId: ALEX }]);
    const ids = await resolveMentionedUserIds(db, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "hi @Alex", mentionedUserIds: [ALEX],
    });
    expect(ids).not.toContain(ALEXANDER);
  });

  it("notifies nobody when the text names someone but no identity was sent", async () => {
    const { db } = makeDb(rosterMembers);
    expect(await resolveMentionedUserIds(db, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "hi @Alex",
    })).toEqual([]);
  });

  it("ignores an identity that is not a member of the channel", async () => {
    const { db, limit } = makeDb(rosterMembers);
    limit.mockResolvedValueOnce([]); // DB returns nobody — ghost is not in the channel
    expect(await resolveMentionedUserIds(db, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "hi @Ghost", mentionedUserIds: ["user-ghost"],
    })).toEqual([]);
  });

  it("never notifies the sender", async () => {
    const { db, limit } = makeDb(rosterMembers);
    limit.mockResolvedValueOnce([{ userId: SENDER }]); // DB returns sender (they are a member)
    expect(await resolveMentionedUserIds(db, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "talking to myself @Sam", mentionedUserIds: [SENDER],
    })).toEqual([]);
  });

  it("notifies the whole channel for @everyone when no identities are sent at all", async () => {
    const { db } = makeDb(rosterMembers);
    const ids = await resolveMentionedUserIds(db, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "@everyone standup",
    });
    expect(ids.sort()).toEqual([ALEX, ALEXANDER].sort());
  });

  it("still notifies the whole channel for @everyone", async () => {
    const { db } = makeDb(rosterMembers);
    const ids = await resolveMentionedUserIds(db, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "@everyone standup", mentionedUserIds: [],
    });
    expect(ids.sort()).toEqual([ALEX, ALEXANDER].sort());
  });

  it("treats @channel and @here the same as @everyone", async () => {
    const { db: db1 } = makeDb(rosterMembers);
    const { db: db2 } = makeDb(rosterMembers);
    expect((await resolveMentionedUserIds(db1, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "@channel ping", mentionedUserIds: [],
    })).sort()).toEqual([ALEX, ALEXANDER].sort());
    expect((await resolveMentionedUserIds(db2, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "@here ping", mentionedUserIds: [],
    })).sort()).toEqual([ALEX, ALEXANDER].sort());
  });

  it("notifies each of two picked people exactly once", async () => {
    const { db, limit } = makeDb(rosterMembers);
    limit.mockResolvedValueOnce([{ userId: ALEX }, { userId: ALEXANDER }]);
    const ids = await resolveMentionedUserIds(db, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "@Alex @Alexander review", mentionedUserIds: [ALEX, ALEXANDER, ALEX],
    });
    expect(ids.sort()).toEqual([ALEX, ALEXANDER].sort());
  });
});

describe("explicit-mention path does not fetch the full roster (Defect 2 guard)", () => {
  it("uses the select path (not findMany) for explicit mentions — bite: reverts to findMany if fix is removed", async () => {
    const { db, findMany, limit } = makeDb(rosterMembers);
    limit.mockResolvedValueOnce([{ userId: ALEX }]);

    await resolveMentionedUserIds(db, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "hi @Alex", mentionedUserIds: [ALEX],
    });

    expect(findMany).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it("applies MENTION_RECIPIENT_CAP on the select path", async () => {
    const { db, limit } = makeDb(rosterMembers);
    limit.mockResolvedValueOnce([{ userId: ALEX }]);

    await resolveMentionedUserIds(db, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "hi @Alex", mentionedUserIds: [ALEX],
    });

    expect(limit).toHaveBeenCalledWith(MENTION_RECIPIENT_CAP);
  });
});

describe("the @everyone expansion is bounded", () => {
  const OVERSIZE = MENTION_RECIPIENT_CAP + 50;

  function bigRoster() {
    return Array.from({ length: OVERSIZE }, (_, i) => ({
      userId: `user-${i}`,
      name: `Member ${i}`,
    }));
  }

  function dbFor(members: { userId: string; name: string }[]) {
    const findMany = jest
      .fn()
      .mockResolvedValue(
        members.map((m, i) => ({ membershipId: i + 1, membership: { userId: m.userId } })),
      );
    const limit = jest.fn().mockResolvedValue([]);
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnValue({ limit }),
      }),
      query: { chatChannelMembers: { findMany } },
    };
    return { db: db as never, findMany, limit };
  }

  it("caps the recipient list at the same 200 the explicit path is capped at", async () => {
    const { db } = dbFor(bigRoster());
    const ids = await resolveMentionedUserIds(db, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "@everyone ship it",
    });

    expect(bigRoster().length).toBeGreaterThan(MENTION_RECIPIENT_CAP);
    expect(ids).toHaveLength(MENTION_RECIPIENT_CAP);
  });

  it("bounds the READ too, not just the returned array", async () => {
    const { db, findMany } = dbFor(bigRoster());
    await resolveMentionedUserIds(db, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "@channel ship it",
    });

    const args = findMany.mock.calls[0]?.[0] as { limit?: number } | undefined;
    expect(args?.limit).toBe(MENTION_RECIPIENT_CAP);
  });

  it("orders the read so the cap is deterministic rather than scan order", async () => {
    const { db, findMany } = dbFor(bigRoster());
    await resolveMentionedUserIds(db, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: "@here ship it",
    });

    const args = findMany.mock.calls[0]?.[0] as { orderBy?: unknown[] } | undefined;
    expect(args?.orderBy).toBeDefined();
    expect(args?.orderBy).toHaveLength(1);
  });

  it("resolves an explicitly-named member at any roster position via membership lookup", async () => {
    const roster = bigRoster();
    const deep = roster[OVERSIZE - 10];
    if (deep === undefined) throw new Error("roster fixture is empty");

    const { db, findMany, limit } = dbFor(roster);
    limit.mockResolvedValueOnce([{ userId: deep.userId }]);

    const ids = await resolveMentionedUserIds(db, {
      orgId: "org-1", channelId: 1, senderId: SENDER,
      content: `hey @${deep.name}`, mentionedUserIds: [deep.userId],
    });

    expect(ids).toEqual([deep.userId]);
    expect(findMany).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledTimes(1);
  });
});
