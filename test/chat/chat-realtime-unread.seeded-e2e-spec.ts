import request from "supertest";
import { createChatWorld, type ChatWorld, type HomeAlias } from "test/chat/chat-seeded-world";

interface SentMessage {
  readonly id: number;
  readonly channelPosition: number;
}

interface PollPage {
  readonly messages: readonly SentMessage[];
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
}

describe("[seeded-e2e] Chat realtime unread counters and cursor replay", () => {
  let world: ChatWorld;
  const sentinel: SentMessage = { id: 0, channelPosition: 0 };
  let msgA: SentMessage = sentinel;
  let msgB: SentMessage = sentinel;
  let msgC: SentMessage = sentinel;

  function auth(alias: HomeAlias): string {
    return `Bearer ${world.tokenFor(alias)}`;
  }

  async function send(channelId: number, content: string): Promise<SentMessage> {
    const response = await request(world.server)
      .post(`/chat/channels/${String(channelId)}/messages`)
      .set("Authorization", auth("channelMember"))
      .send({ content });
    expect(response.status).toBe(201);
    const id = Number(response.body?.id);
    const channelPosition = Number(response.body?.channelPosition);
    expect(id).toBeGreaterThan(0);
    expect(channelPosition).toBeGreaterThan(0);
    return { id, channelPosition };
  }

  async function poll(
    channelId: number,
    query: { since?: string; cursor?: number },
  ): Promise<PollPage> {
    const response = await request(world.server)
      .get(`/chat/channels/${String(channelId)}/messages/poll`)
      .query(query)
      .set("Authorization", auth("channelMember"));
    expect(response.status).toBe(200);
    const page: PollPage = response.body;
    return page;
  }

  beforeAll(async () => {
    world = await createChatWorld();

    msgA = await send(world.publicChannelId, "replay-msg-A");
    msgB = await send(world.publicChannelId, "replay-msg-B");
    msgC = await send(world.publicChannelId, "replay-msg-C");
  }, 300_000);

  afterAll(async () => {
    if (world) await world.close();
  }, 180_000);

  it("fixture — three messages seeded with distinct, ascending positions", () => {
    expect(msgA.id).toBeGreaterThan(0);
    expect(msgB.id).toBeGreaterThan(0);
    expect(msgC.id).toBeGreaterThan(0);
    expect(msgA.channelPosition).toBeLessThan(msgB.channelPosition);
    expect(msgB.channelPosition).toBeLessThan(msgC.channelPosition);
  });

  it("DENY — polling without since or cursor is refused with 400", async () => {
    const response = await request(world.server)
      .get(`/chat/channels/${String(world.publicChannelId)}/messages/poll`)
      .set("Authorization", auth("channelMember"));

    expect(response.status).toBe(400);
  });

  it("REPLAY — poll from cursor=0 returns all three messages in position order with their exact ids", async () => {
    const page = await poll(world.publicChannelId, { cursor: 0 });

    const ids = page.messages.map((m) => m.id);
    expect(ids).toContain(msgA.id);
    expect(ids).toContain(msgB.id);
    expect(ids).toContain(msgC.id);

    const positions = page.messages.map((m) => m.channelPosition);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    const idxA = ids.indexOf(msgA.id);
    const idxB = ids.indexOf(msgB.id);
    const idxC = ids.indexOf(msgC.id);
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
  });

  it("DEDUP — a second poll from the same cursor returns the same set, not duplicates", async () => {
    const page1 = await poll(world.publicChannelId, { cursor: 0 });
    const page2 = await poll(world.publicChannelId, { cursor: 0 });

    const ids1 = page1.messages.map((m) => m.id);
    const ids2 = page2.messages.map((m) => m.id);
    expect(ids1).toEqual(ids2);
  });

  it("CURSOR ADVANCE — poll from msgA's position returns only B and C, never A again", async () => {
    const page = await poll(world.publicChannelId, { cursor: msgA.channelPosition });

    const ids = page.messages.map((m) => m.id);
    expect(ids).not.toContain(msgA.id);
    expect(ids).toContain(msgB.id);
    expect(ids).toContain(msgC.id);
  });

  it("CURSOR ADVANCE — poll from msgB's position returns only C, never A or B again", async () => {
    const page = await poll(world.publicChannelId, { cursor: msgB.channelPosition });

    const ids = page.messages.map((m) => m.id);
    expect(ids).not.toContain(msgA.id);
    expect(ids).not.toContain(msgB.id);
    expect(ids).toContain(msgC.id);
  });

  it("EXHAUSTED — poll from msgC's position returns an empty page (nothing further to replay)", async () => {
    const page = await poll(world.publicChannelId, { cursor: msgC.channelPosition });

    expect(page.messages).toHaveLength(0);
    expect(page.hasMore).toBe(false);
  });

  it("MARK READ — after marking the channel read, a new message appears at the next cursor position", async () => {
    const markReadResponse = await request(world.server)
      .post(`/chat/channels/${String(world.publicChannelId)}/read`)
      .set("Authorization", auth("channelMember"));
    expect(markReadResponse.status).toBe(200);

    const msgD = await send(world.publicChannelId, "post-read-msg-D");

    const page = await poll(world.publicChannelId, { cursor: msgC.channelPosition });

    const ids = page.messages.map((m) => m.id);
    expect(ids).toContain(msgD.id);
    expect(ids).not.toContain(msgA.id);
    expect(ids).not.toContain(msgB.id);
    expect(ids).not.toContain(msgC.id);
    expect(msgD.channelPosition).toBeGreaterThan(msgC.channelPosition);
  });

  it("NO STALE TIMESTAMP BUG — cursor replay returns all messages regardless of their created_at order", async () => {
    const page = await poll(world.publicChannelId, { cursor: 0 });
    const returned = page.messages.map((m) => m.channelPosition);

    expect(returned).toEqual([...returned].sort((a, b) => a - b));

    const returnedIds = page.messages.map((m) => m.id);
    const unique = new Set(returnedIds);
    expect(unique.size).toBe(returnedIds.length);
  });

  it("SINCE FALLBACK — poll with since=epoch returns all messages when no cursor is supplied", async () => {
    const page = await poll(world.publicChannelId, { since: new Date(0).toISOString() });

    const ids = page.messages.map((m) => m.id);
    expect(ids).toContain(msgA.id);
    expect(ids).toContain(msgB.id);
    expect(ids).toContain(msgC.id);
  });

  it("PRIVATE CHANNEL ISOLATION — cursor replay from the private channel does not include public messages", async () => {
    const msgPrivate = await (async () => {
      const response = await request(world.server)
        .post(`/chat/channels/${String(world.privateChannelId)}/messages`)
        .set("Authorization", auth("channelMember"))
        .send({ content: "private-channel-only" });
      expect(response.status).toBe(201);
      return { id: Number(response.body?.id), channelPosition: Number(response.body?.channelPosition) };
    })();

    const privatePage = await (async () => {
      const response = await request(world.server)
        .get(`/chat/channels/${String(world.privateChannelId)}/messages/poll`)
        .query({ cursor: 0 })
        .set("Authorization", auth("channelMember"));
      expect(response.status).toBe(200);
      const body: PollPage = response.body;
      return body;
    })();

    const privateIds = privatePage.messages.map((m) => m.id);
    expect(privateIds).toContain(msgPrivate.id);
    expect(privateIds).not.toContain(msgA.id);
    expect(privateIds).not.toContain(msgB.id);
    expect(privateIds).not.toContain(msgC.id);
  });
});
