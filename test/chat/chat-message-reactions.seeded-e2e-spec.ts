import { and, eq } from "drizzle-orm";
import request from "supertest";
import { chatMessageReactions, chatMessages } from "src/db/schema";
import { createChatWorld, type ChatWorld } from "test/chat/chat-seeded-world";

const THUMB = "\u{1F44D}";
const CLAP = "\u{1F44F}";

interface ReactionsBody {
  readonly reactions?: Readonly<Record<string, readonly string[]>>;
}

describe("[seeded-e2e] Chat message reactions", () => {
  let world: ChatWorld;
  let privateMessageId = 0;
  let publicMessageId = 0;
  let deletedMessageId = 0;

  function auth(token: string): string {
    return `Bearer ${token}`;
  }

  function reactionPath(channelId: number, messageId: number): string {
    return `/chat/channels/${String(channelId)}/messages/${String(messageId)}/reactions`;
  }

  async function storedReactionCount(messageId: number, emoji: string): Promise<number> {
    const rows = await world.seeded.seedDb
      .select({ id: chatMessageReactions.id })
      .from(chatMessageReactions)
      .where(
        and(
          eq(chatMessageReactions.orgId, world.home.orgId),
          eq(chatMessageReactions.messageId, messageId),
          eq(chatMessageReactions.emoji, emoji),
        ),
      );
    return rows.length;
  }

  beforeAll(async () => {
    world = await createChatWorld();

    const privateSeed = await request(world.server)
      .post(`/chat/channels/${String(world.privateChannelId)}/messages`)
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ content: "reactable message in the private channel" });
    privateMessageId = Number(privateSeed.body?.id);

    const publicSeed = await request(world.server)
      .post(`/chat/channels/${String(world.publicChannelId)}/messages`)
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({ content: "reactable message in the public channel" });
    publicMessageId = Number(publicSeed.body?.id);

    const doomedSeed = await request(world.server)
      .post(`/chat/channels/${String(world.privateChannelId)}/messages`)
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ content: "about to be deleted" });
    deletedMessageId = Number(doomedSeed.body?.id);
    await world.seeded.seedDb
      .update(chatMessages)
      .set({ isDeleted: true, content: null })
      .where(
        and(
          eq(chatMessages.orgId, world.home.orgId),
          eq(chatMessages.id, deletedMessageId),
        ),
      );
  }, 300_000);

  afterAll(async () => {
    if (world) await world.close();
  }, 180_000);

  it("fixture check — three seeded messages and one of them is soft-deleted", () => {
    expect(privateMessageId).toBeGreaterThan(0);
    expect(publicMessageId).toBeGreaterThan(0);
    expect(deletedMessageId).toBeGreaterThan(0);
  });

  it("ALLOW — a channel member adds a reaction: 200, and the folded map names the actor", async () => {
    const response = await request(world.server)
      .post(reactionPath(world.privateChannelId, privateMessageId))
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ emoji: THUMB });

    expect(response.status).toBe(200);
    const body: ReactionsBody = response.body;
    expect(body.reactions?.[THUMB]).toContain(world.userIdFor("channelMember"));
    expect(await storedReactionCount(privateMessageId, THUMB)).toBe(1);
  });

  it("IDEMPOTENT — adding the same reaction twice is 200 and still exactly one stored row", async () => {
    const response = await request(world.server)
      .post(reactionPath(world.privateChannelId, privateMessageId))
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ emoji: THUMB });

    expect(response.status).toBe(200);
    expect(await storedReactionCount(privateMessageId, THUMB)).toBe(1);
  });

  it("ALLOW — a second member adds the same emoji: 200, and both actors appear", async () => {
    const response = await request(world.server)
      .post(reactionPath(world.privateChannelId, privateMessageId))
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({ emoji: THUMB });

    expect(response.status).toBe(200);
    const body: ReactionsBody = response.body;
    expect(body.reactions?.[THUMB]).toEqual(
      expect.arrayContaining([
        world.userIdFor("channelMember"),
        world.userIdFor("channelAdmin"),
      ]),
    );
    expect(await storedReactionCount(privateMessageId, THUMB)).toBe(2);
  });

  it("ALLOW — a member removes their own reaction: 200, and only their row is gone", async () => {
    const response = await request(world.server)
      .delete(
        `${reactionPath(world.privateChannelId, privateMessageId)}/${encodeURIComponent(THUMB)}`,
      )
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(200);
    const body: ReactionsBody = response.body;
    expect(body.reactions?.[THUMB]).not.toContain(world.userIdFor("channelMember"));
    expect(await storedReactionCount(privateMessageId, THUMB)).toBe(1);
  });

  it("IDEMPOTENT — removing a reaction that is already gone is 200 and changes nothing", async () => {
    const response = await request(world.server)
      .delete(
        `${reactionPath(world.privateChannelId, privateMessageId)}/${encodeURIComponent(THUMB)}`,
      )
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(200);
    expect(await storedReactionCount(privateMessageId, THUMB)).toBe(1);
  });

  it("DENY — a non-member of the PRIVATE channel gets 404 and writes no reaction", async () => {
    const response = await request(world.server)
      .post(reactionPath(world.privateChannelId, privateMessageId))
      .set("Authorization", auth(world.tokenFor("outsider")))
      .send({ emoji: CLAP });

    expect(response.status).toBe(404);
    expect(await storedReactionCount(privateMessageId, CLAP)).toBe(0);
  });

  it("DENY — a removed member of the PRIVATE channel gets 404 and writes no reaction", async () => {
    const response = await request(world.server)
      .post(reactionPath(world.privateChannelId, privateMessageId))
      .set("Authorization", auth(world.tokenFor("removed")))
      .send({ emoji: CLAP });

    expect(response.status).toBe(404);
    expect(await storedReactionCount(privateMessageId, CLAP)).toBe(0);
  });

  it("DENY — a non-member of the PUBLIC channel gets 403 and writes no reaction", async () => {
    const response = await request(world.server)
      .post(reactionPath(world.publicChannelId, publicMessageId))
      .set("Authorization", auth(world.tokenFor("outsider")))
      .send({ emoji: CLAP });

    expect(response.status).toBe(403);
    expect(await storedReactionCount(publicMessageId, CLAP)).toBe(0);
  });

  it("CROSS-TENANT — a member of the other organisation gets 404 and writes no reaction", async () => {
    const response = await request(world.server)
      .post(reactionPath(world.privateChannelId, privateMessageId))
      .set("Authorization", auth(world.strangerToken))
      .send({ emoji: CLAP });

    expect(response.status).toBe(404);
    expect(await storedReactionCount(privateMessageId, CLAP)).toBe(0);
  });

  it("REFUSE — reacting through a channel id the message does not belong to gets 404", async () => {
    const response = await request(world.server)
      .post(reactionPath(world.publicChannelId, privateMessageId))
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ emoji: CLAP });

    expect(response.status).toBe(404);
    expect(await storedReactionCount(privateMessageId, CLAP)).toBe(0);
  });

  it("REFUSE — reacting to a soft-deleted message gets 404", async () => {
    const response = await request(world.server)
      .post(reactionPath(world.privateChannelId, deletedMessageId))
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ emoji: CLAP });

    expect(response.status).toBe(404);
    expect(await storedReactionCount(deletedMessageId, CLAP)).toBe(0);
  });

  it("REFUSE — removing a reaction from a soft-deleted message gets 404", async () => {
    const response = await request(world.server)
      .delete(
        `${reactionPath(world.privateChannelId, deletedMessageId)}/${encodeURIComponent(THUMB)}`,
      )
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(404);
  });
});
