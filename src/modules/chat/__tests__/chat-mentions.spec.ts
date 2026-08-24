import { resolveMentionedUserIds } from "../chat-mentions";

const ALEX = "user-alex";
const ALEXANDER = "user-alexander";
const SENDER = "user-sender";

function makeDb(members: { userId: string; name: string }[]) {
  return {
    query: {
      chatChannelMembers: {
        findMany: jest.fn().mockResolvedValue(members.map((m) => ({ userId: m.userId }))),
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
