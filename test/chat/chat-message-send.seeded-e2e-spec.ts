import request from "supertest";
import { createChatWorld, type ChatWorld } from "test/chat/chat-seeded-world";

const PRIVATE_SENTINEL = "sentinel-private-channel-content-do-not-leak";

interface ListedMessage {
  readonly id: number;
  readonly replyToId: number | null;
}

interface MessagePage {
  readonly messages?: readonly ListedMessage[];
}

describe("[seeded-e2e] Chat send and thread replies", () => {
  let world: ChatWorld;
  let privateMessageId = 0;
  let publicMessageId = 0;
  let replyMessageId = 0;

  function auth(token: string): string {
    return `Bearer ${token}`;
  }

  beforeAll(async () => {
    world = await createChatWorld();

    const seedPrivate = await request(world.server)
      .post(`/chat/channels/${String(world.privateChannelId)}/messages`)
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ content: PRIVATE_SENTINEL });
    privateMessageId = Number(seedPrivate.body?.id);

    const seedPublic = await request(world.server)
      .post(`/chat/channels/${String(world.publicChannelId)}/messages`)
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({ content: "public thread parent" });
    publicMessageId = Number(seedPublic.body?.id);
  }, 300_000);

  afterAll(async () => {
    if (world) await world.close();
  }, 180_000);

  it("fixture check — two distinct orgs, a private and a public channel, and two seeded parents", () => {
    expect(world.home.orgId).not.toBe(world.neighbour.orgId);
    expect(world.privateChannelId).toBeGreaterThan(0);
    expect(world.publicChannelId).toBeGreaterThan(0);
    expect(privateMessageId).toBeGreaterThan(0);
    expect(publicMessageId).toBeGreaterThan(0);
    expect(world.removedMembershipRowExisted).toBe(true);
  });

  it("ALLOW — a channel member sends to the private channel: 201 and exactly one new row", async () => {
    const before = await world.messageCount(world.privateChannelId);

    const response = await request(world.server)
      .post(`/chat/channels/${String(world.privateChannelId)}/messages`)
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ content: "hello from a real member" });

    expect(response.status).toBe(201);
    expect(await world.messageCount(world.privateChannelId)).toBe(before + 1);
  });

  it("ALLOW — a channel member sends to the public channel: 201 and exactly one new row", async () => {
    const before = await world.messageCount(world.publicChannelId);

    const response = await request(world.server)
      .post(`/chat/channels/${String(world.publicChannelId)}/messages`)
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ content: "hello from a public member" });

    expect(response.status).toBe(201);
    expect(await world.messageCount(world.publicChannelId)).toBe(before + 1);
  });

  it("DENY — an org member who is not in the private channel is refused 404 and writes no row", async () => {
    const before = await world.messageCount(world.privateChannelId);

    const response = await request(world.server)
      .post(`/chat/channels/${String(world.privateChannelId)}/messages`)
      .set("Authorization", auth(world.tokenFor("outsider")))
      .send({ content: "intrusion by a non-member" });

    expect(response.status).toBe(404);
    expect(await world.messageCount(world.privateChannelId)).toBe(before);
  });

  it("CONTROL — the same non-member posting to the PUBLIC channel is refused 403, not 404", async () => {
    const before = await world.messageCount(world.publicChannelId);

    const response = await request(world.server)
      .post(`/chat/channels/${String(world.publicChannelId)}/messages`)
      .set("Authorization", auth(world.tokenFor("outsider")))
      .send({ content: "intrusion into a discoverable channel" });

    expect(response.status).toBe(403);
    expect(await world.messageCount(world.publicChannelId)).toBe(before);
  });

  it("DENY — a member removed from the channel is refused 404 and writes no row", async () => {
    const before = await world.messageCount(world.privateChannelId);

    const response = await request(world.server)
      .post(`/chat/channels/${String(world.privateChannelId)}/messages`)
      .set("Authorization", auth(world.tokenFor("removed")))
      .send({ content: "intrusion after removal" });

    expect(response.status).toBe(404);
    expect(await world.messageCount(world.privateChannelId)).toBe(before);
  });

  it("CROSS-TENANT — a member of the other organisation is refused 404 and writes no row", async () => {
    const before = await world.messageCount(world.privateChannelId);

    const response = await request(world.server)
      .post(`/chat/channels/${String(world.privateChannelId)}/messages`)
      .set("Authorization", auth(world.strangerToken))
      .send({ content: "cross-tenant intrusion" });

    expect(response.status).toBe(404);
    expect(await world.messageCount(world.privateChannelId)).toBe(before);
  });

  it("CROSS-TENANT — the other organisation posting to this PUBLIC channel is 404, never 403", async () => {
    const before = await world.messageCount(world.publicChannelId);

    const response = await request(world.server)
      .post(`/chat/channels/${String(world.publicChannelId)}/messages`)
      .set("Authorization", auth(world.strangerToken))
      .send({ content: "cross-tenant intrusion into a public channel" });

    expect(response.status).toBe(404);
    expect(await world.messageCount(world.publicChannelId)).toBe(before);
  });

  it("ALLOW — a reply to a parent in the same channel is created: 201", async () => {
    const before = await world.messageCount(world.publicChannelId);

    const response = await request(world.server)
      .post(
        `/chat/channels/${String(world.publicChannelId)}/messages/${String(publicMessageId)}/thread`,
      )
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ content: "a reply in the same channel" });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ replyToId: publicMessageId });
    replyMessageId = Number(response.body?.id);
    expect(replyMessageId).toBeGreaterThan(0);
    expect(await world.messageCount(world.publicChannelId)).toBe(before + 1);
  });

  it("REFUSE — replyToId naming a message in another channel of the same org is 404 and leaks no content", async () => {
    const before = await world.messageCount(world.publicChannelId);

    const response = await request(world.server)
      .post(`/chat/channels/${String(world.publicChannelId)}/messages`)
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ content: "borrowing a parent from elsewhere", replyToId: privateMessageId });

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(PRIVATE_SENTINEL);
    expect(await world.messageCount(world.publicChannelId)).toBe(before);
  });

  it("REFUSE — the thread route with a parent in another channel of the same org is 404 and leaks no content", async () => {
    const before = await world.messageCount(world.publicChannelId);

    const response = await request(world.server)
      .post(
        `/chat/channels/${String(world.publicChannelId)}/messages/${String(privateMessageId)}/thread`,
      )
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ content: "borrowing a thread parent from elsewhere" });

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(PRIVATE_SENTINEL);
    expect(await world.messageCount(world.publicChannelId)).toBe(before);
  });

  it("CONTRACT — listing a channel that now contains a reply returns 200", async () => {
    const response = await request(world.server)
      .get(`/chat/channels/${String(world.publicChannelId)}/messages`)
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(200);
    const page: MessagePage = response.body;
    const listed = page.messages ?? [];
    expect(listed.map((message) => message.id)).toContain(replyMessageId);
    expect(listed.map((message) => message.replyToId)).toContain(publicMessageId);
  });

  it("CONTRACT — polling a channel that now contains a reply returns 200", async () => {
    const response = await request(world.server)
      .get(`/chat/channels/${String(world.publicChannelId)}/messages/poll`)
      .query({ since: new Date(0).toISOString() })
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(200);
    const page: MessagePage = response.body;
    const polled = page.messages ?? [];
    expect(polled.map((message) => message.id)).toContain(replyMessageId);
    expect(polled.map((message) => message.replyToId)).toContain(publicMessageId);
  });

  it("DENY — polling without 'since' or 'cursor' is refused", async () => {
    const response = await request(world.server)
      .get(`/chat/channels/${String(world.publicChannelId)}/messages/poll`)
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(400);
  });

  it("CONTRACT — the thread page for a parent with replies returns 200", async () => {
    const response = await request(world.server)
      .get(
        `/chat/channels/${String(world.publicChannelId)}/messages/${String(publicMessageId)}/thread`,
      )
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(200);
  });
});
