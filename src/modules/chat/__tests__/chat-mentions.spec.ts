import { MENTION_RECIPIENT_CAP, resolveMentionedUserIds } from "../chat-mentions";

const ALEX = "user-alex";
const ALEXANDER = "user-alexander";
const SENDER = "user-sender";

function makeDb(members: { userId: string; name: string }[]) {
  return {
    query: {
      chatChannelMembers: {
        findMany: jest.fn().mockResolvedValue(
          members.map((m, i) => ({ membershipId: i + 1, membership: { userId: m.userId } })),
        ),
      },
    },
  };
}

const roster = [
  { userId: ALEX, name: "Alex" },
  { userId: ALEXANDER, name: "Alexander" },
  { userId: SENDER, name: "Sam" },
];

const resolve = (content: string, mentionedUserIds?: string[]) =>
  resolveMentionedUserIds(makeDb(roster) as never, {
    orgId: "org-1",
    channelId: 1,
    senderId: SENDER,
    content,
    mentionedUserIds,
  });

describe("resolveMentionedUserIds", () => {
  it("notifies exactly the person the composer picked", async () => {
    expect(await resolve("hi @Alex", [ALEX])).toEqual([ALEX]);
  });

  it("does not notify someone whose name merely contains the mention", async () => {
    expect(await resolve("hi @Alex", [ALEX])).not.toContain(ALEXANDER);
  });

  it("notifies nobody when the text names someone but no identity was sent", async () => {
    expect(await resolve("hi @Alex")).toEqual([]);
  });

  it("ignores an identity that is not a member of the channel", async () => {
    expect(await resolve("hi @Ghost", ["user-ghost"])).toEqual([]);
  });

  it("never notifies the sender", async () => {
    expect(await resolve("talking to myself @Sam", [SENDER])).toEqual([]);
  });

  it("notifies the whole channel for @everyone when no identities are sent at all", async () => {
    const ids = await resolve("@everyone standup");
    expect(ids.sort()).toEqual([ALEX, ALEXANDER].sort());
  });

  it("still notifies the whole channel for @everyone", async () => {
    const ids = await resolve("@everyone standup", []);
    expect(ids.sort()).toEqual([ALEX, ALEXANDER].sort());
  });

  it("treats @channel and @here the same as @everyone", async () => {
    expect((await resolve("@channel ping", [])).sort()).toEqual([ALEX, ALEXANDER].sort());
    expect((await resolve("@here ping", [])).sort()).toEqual([ALEX, ALEXANDER].sort());
  });

  it("notifies each of two picked people exactly once", async () => {
    const ids = await resolve("@Alex @Alexander review", [ALEX, ALEXANDER, ALEX]);
    expect(ids.sort()).toEqual([ALEX, ALEXANDER].sort());
  });
});

/**
 * `@everyone` used to return one recipient per channel member with no ceiling, while the
 * composer's explicit list has always been capped at 200 by `sendMessageSchema`. One intent,
 * two ceilings — and the uncapped one is the one an ordinary member can trigger by typing
 * five characters into an org-wide channel. Every downstream fanout multiplies by this set.
 */
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
    return { db: { query: { chatChannelMembers: { findMany } } }, findMany };
  }

  it("caps the recipient list at the same 200 the explicit path is capped at", async () => {
    const { db } = dbFor(bigRoster());
    const ids = await resolveMentionedUserIds(db as never, {
      orgId: "org-1",
      channelId: 1,
      senderId: SENDER,
      content: "@everyone ship it",
    });

    expect(bigRoster().length).toBeGreaterThan(MENTION_RECIPIENT_CAP);
    expect(ids).toHaveLength(MENTION_RECIPIENT_CAP);
  });

  it("bounds the READ too, not just the returned array", async () => {
    const { db, findMany } = dbFor(bigRoster());
    await resolveMentionedUserIds(db as never, {
      orgId: "org-1",
      channelId: 1,
      senderId: SENDER,
      content: "@channel ship it",
    });

    // Slicing after the fact still pulls the whole roster into the process, which is
    // the cost that actually hurts on an org-wide channel.
    const args = findMany.mock.calls[0]?.[0] as { limit?: number } | undefined;
    expect(args?.limit).toBe(MENTION_RECIPIENT_CAP);
  });

  it("orders the read so the cap is deterministic rather than scan order", async () => {
    const { db, findMany } = dbFor(bigRoster());
    await resolveMentionedUserIds(db as never, {
      orgId: "org-1",
      channelId: 1,
      senderId: SENDER,
      content: "@here ship it",
    });

    const args = findMany.mock.calls[0]?.[0] as { orderBy?: unknown[] } | undefined;
    expect(args?.orderBy).toBeDefined();
    expect(args?.orderBy).toHaveLength(1);
  });

  it("does NOT truncate the read for an explicitly named person deep in the roster", async () => {
    // Bounding one path by breaking the other is not a fix: a member at position 240
    // that the composer picked by name must still be resolved.
    const roster = bigRoster();
    const deep = roster[OVERSIZE - 10];
    if (deep === undefined) throw new Error("roster fixture is empty");
    const { db, findMany } = dbFor(roster);

    const ids = await resolveMentionedUserIds(db as never, {
      orgId: "org-1",
      channelId: 1,
      senderId: SENDER,
      content: `hey @${deep.name}`,
      mentionedUserIds: [deep.userId],
    });

    expect(ids).toEqual([deep.userId]);
    const args = findMany.mock.calls[0]?.[0] as { limit?: number } | undefined;
    expect(args?.limit).toBeUndefined();
  });
});
