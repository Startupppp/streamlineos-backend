import { and, eq } from "drizzle-orm";
import request from "supertest";
import { chatChannelMembers } from "src/db/schema";
import {
  createChatWorld,
  type ChatWorld,
  type HomeAlias,
} from "test/chat/chat-seeded-world";

describe("[seeded-e2e] Chat channel membership administration", () => {
  let world: ChatWorld;

  function auth(token: string): string {
    return `Bearer ${token}`;
  }

  function membersPath(channelId: number): string {
    return `/chat/channels/${String(channelId)}/members`;
  }

  async function channelMemberRow(channelId: number, alias: HomeAlias) {
    const [row] = await world.seeded.seedDb
      .select({ id: chatChannelMembers.id, role: chatChannelMembers.role })
      .from(chatChannelMembers)
      .where(
        and(
          eq(chatChannelMembers.orgId, world.home.orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, world.membershipIdFor(alias)),
        ),
      );
    return row ?? null;
  }

  beforeAll(async () => {
    world = await createChatWorld();
  }, 300_000);

  afterAll(async () => {
    if (world) await world.close();
  }, 180_000);

  it("fixture check — the seeded roster is admin plus one member in each channel", async () => {
    expect((await channelMemberRow(world.privateChannelId, "channelAdmin"))?.role).toBe("ADMIN");
    expect((await channelMemberRow(world.publicChannelId, "channelMember"))?.role).toBe("MEMBER");
    expect(await channelMemberRow(world.publicChannelId, "outsider")).toBeNull();
  });

  it("ADD — a non-member of the PRIVATE channel gets 404 and adds nobody", async () => {
    const before = await world.memberCount(world.privateChannelId);

    const response = await request(world.server)
      .post(membersPath(world.privateChannelId))
      .set("Authorization", auth(world.tokenFor("removed")))
      .send({ userId: world.userIdFor("outsider") });

    expect(response.status).toBe(404);
    expect(await world.memberCount(world.privateChannelId)).toBe(before);
  });

  it("ADD — a non-member of the PUBLIC channel gets 403 and adds nobody", async () => {
    const before = await world.memberCount(world.publicChannelId);

    const response = await request(world.server)
      .post(membersPath(world.publicChannelId))
      .set("Authorization", auth(world.tokenFor("removed")))
      .send({ userId: world.userIdFor("outsider") });

    expect(response.status).toBe(403);
    expect(await world.memberCount(world.publicChannelId)).toBe(before);
  });

  it("ADD — a member of the other organisation gets 404 and adds nobody", async () => {
    const before = await world.memberCount(world.privateChannelId);

    const response = await request(world.server)
      .post(membersPath(world.privateChannelId))
      .set("Authorization", auth(world.strangerToken))
      .send({ userId: world.strangerUserId });

    expect(response.status).toBe(404);
    expect(await world.memberCount(world.privateChannelId)).toBe(before);
  });

  it("ADD — a plain channel member is refused 403 and adds nobody", async () => {
    const before = await world.memberCount(world.publicChannelId);

    const response = await request(world.server)
      .post(membersPath(world.publicChannelId))
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ userId: world.userIdFor("outsider") });

    expect(response.status).toBe(403);
    expect(await world.memberCount(world.publicChannelId)).toBe(before);
    expect(await channelMemberRow(world.publicChannelId, "outsider")).toBeNull();
  });

  it("ADD — the channel admin adds a member: 200 and the row appears as MEMBER", async () => {
    const before = await world.memberCount(world.publicChannelId);

    const response = await request(world.server)
      .post(membersPath(world.publicChannelId))
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({ userId: world.userIdFor("outsider") });

    expect(response.status).toBe(200);
    expect(await world.memberCount(world.publicChannelId)).toBe(before + 1);
    expect((await channelMemberRow(world.publicChannelId, "outsider"))?.role).toBe("MEMBER");
  });

  it("ADD — adding the same person twice is 409 and adds no second row", async () => {
    const before = await world.memberCount(world.publicChannelId);

    const response = await request(world.server)
      .post(membersPath(world.publicChannelId))
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({ userId: world.userIdFor("outsider") });

    expect(response.status).toBe(409);
    expect(await world.memberCount(world.publicChannelId)).toBe(before);
  });

  it("ROLE — a plain channel member is refused 403 and the stored role is unchanged", async () => {
    const response = await request(world.server)
      .patch(`${membersPath(world.publicChannelId)}/${world.userIdFor("outsider")}/role`)
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ role: "ADMIN" });

    expect(response.status).toBe(403);
    expect((await channelMemberRow(world.publicChannelId, "outsider"))?.role).toBe("MEMBER");
  });

  it("ROLE — a non-member of the PRIVATE channel is refused 404 and the stored role is unchanged", async () => {
    const response = await request(world.server)
      .patch(`${membersPath(world.privateChannelId)}/${world.userIdFor("channelMember")}/role`)
      .set("Authorization", auth(world.tokenFor("removed")))
      .send({ role: "ADMIN" });

    expect(response.status).toBe(404);
    expect((await channelMemberRow(world.privateChannelId, "channelMember"))?.role).toBe("MEMBER");
  });

  it("ROLE — a non-member of the PUBLIC channel is refused 403, not 404", async () => {
    const response = await request(world.server)
      .patch(`${membersPath(world.publicChannelId)}/${world.userIdFor("outsider")}/role`)
      .set("Authorization", auth(world.tokenFor("removed")))
      .send({ role: "ADMIN" });

    expect(response.status).toBe(403);
    expect((await channelMemberRow(world.publicChannelId, "outsider"))?.role).toBe("MEMBER");
  });

  it("ROLE — a member of the other organisation is refused 404 and the stored role is unchanged", async () => {
    const response = await request(world.server)
      .patch(`${membersPath(world.privateChannelId)}/${world.userIdFor("channelMember")}/role`)
      .set("Authorization", auth(world.strangerToken))
      .send({ role: "ADMIN" });

    expect(response.status).toBe(404);
    expect((await channelMemberRow(world.privateChannelId, "channelMember"))?.role).toBe("MEMBER");
  });

  it("ROLE — the channel admin promotes a member: 200 and the stored role becomes ADMIN", async () => {
    const response = await request(world.server)
      .patch(`${membersPath(world.publicChannelId)}/${world.userIdFor("outsider")}/role`)
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({ role: "ADMIN" });

    expect(response.status).toBe(200);
    expect((await channelMemberRow(world.publicChannelId, "outsider"))?.role).toBe("ADMIN");
  });

  it("REMOVE — a plain member removing someone else is refused 403 and the row survives", async () => {
    const response = await request(world.server)
      .delete(`${membersPath(world.publicChannelId)}/${world.userIdFor("channelAdmin")}`)
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(403);
    expect(await channelMemberRow(world.publicChannelId, "channelAdmin")).not.toBeNull();
  });

  it("REMOVE — a plain member removing themselves is allowed: 200 and their row is gone", async () => {
    const response = await request(world.server)
      .delete(`${membersPath(world.publicChannelId)}/${world.userIdFor("channelMember")}`)
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(200);
    expect(await channelMemberRow(world.publicChannelId, "channelMember")).toBeNull();
  });

  it("REMOVE — the channel admin removes another member: 200 and their row is gone", async () => {
    const response = await request(world.server)
      .delete(`${membersPath(world.publicChannelId)}/${world.userIdFor("outsider")}`)
      .set("Authorization", auth(world.tokenFor("channelAdmin")));

    expect(response.status).toBe(200);
    expect(await channelMemberRow(world.publicChannelId, "outsider")).toBeNull();
  });

  it("REMOVE — a non-member of the PRIVATE channel gets 404 and the target row survives", async () => {
    const response = await request(world.server)
      .delete(`${membersPath(world.privateChannelId)}/${world.userIdFor("channelMember")}`)
      .set("Authorization", auth(world.tokenFor("removed")));

    expect(response.status).toBe(404);
    expect(await channelMemberRow(world.privateChannelId, "channelMember")).not.toBeNull();
  });

  it("REMOVE — a member of the other organisation gets 404 and the target row survives", async () => {
    const response = await request(world.server)
      .delete(`${membersPath(world.privateChannelId)}/${world.userIdFor("channelMember")}`)
      .set("Authorization", auth(world.strangerToken));

    expect(response.status).toBe(404);
    expect(await channelMemberRow(world.privateChannelId, "channelMember")).not.toBeNull();
  });

  it("JOIN — a non-member joins the PUBLIC channel: 200 and a row appears", async () => {
    const response = await request(world.server)
      .post(`/chat/channels/${String(world.publicChannelId)}/join`)
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(200);
    expect((await channelMemberRow(world.publicChannelId, "channelMember"))?.role).toBe("MEMBER");
  });

  it("JOIN — joining again is 200 and adds no second row", async () => {
    const before = await world.memberCount(world.publicChannelId);

    const response = await request(world.server)
      .post(`/chat/channels/${String(world.publicChannelId)}/join`)
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(200);
    expect(await world.memberCount(world.publicChannelId)).toBe(before);
  });

  it("JOIN — the PRIVATE channel answers 404 and admits nobody", async () => {
    const before = await world.memberCount(world.privateChannelId);

    const response = await request(world.server)
      .post(`/chat/channels/${String(world.privateChannelId)}/join`)
      .set("Authorization", auth(world.tokenFor("outsider")));

    expect(response.status).toBe(404);
    expect(await world.memberCount(world.privateChannelId)).toBe(before);
    expect(await channelMemberRow(world.privateChannelId, "outsider")).toBeNull();
  });

  it("JOIN — a member of the other organisation gets 404 and admits nobody", async () => {
    const before = await world.memberCount(world.publicChannelId);

    const response = await request(world.server)
      .post(`/chat/channels/${String(world.publicChannelId)}/join`)
      .set("Authorization", auth(world.strangerToken));

    expect(response.status).toBe(404);
    expect(await world.memberCount(world.publicChannelId)).toBe(before);
  });

  it("LEAVE — a member leaves their own channel: 200 and their row is gone", async () => {
    const response = await request(world.server)
      .post(`/chat/channels/${String(world.publicChannelId)}/leave`)
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(200);
    expect(await channelMemberRow(world.publicChannelId, "channelMember")).toBeNull();
  });

  it("LEAVE — a non-member of the PUBLIC channel gets 403", async () => {
    const response = await request(world.server)
      .post(`/chat/channels/${String(world.publicChannelId)}/leave`)
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(403);
  });

  it("LEAVE — a non-member of the PRIVATE channel gets 404 and nobody is removed", async () => {
    const before = await world.memberCount(world.privateChannelId);

    const response = await request(world.server)
      .post(`/chat/channels/${String(world.privateChannelId)}/leave`)
      .set("Authorization", auth(world.tokenFor("outsider")));

    expect(response.status).toBe(404);
    expect(await world.memberCount(world.privateChannelId)).toBe(before);
  });

  it("LEAVE — a member of the other organisation gets 404 and nobody is removed", async () => {
    const before = await world.memberCount(world.privateChannelId);

    const response = await request(world.server)
      .post(`/chat/channels/${String(world.privateChannelId)}/leave`)
      .set("Authorization", auth(world.strangerToken));

    expect(response.status).toBe(404);
    expect(await world.memberCount(world.privateChannelId)).toBe(before);
  });
});
