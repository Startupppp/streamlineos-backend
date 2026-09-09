import { and, eq } from "drizzle-orm";
import request from "supertest";
import { chatMessages } from "src/db/schema";
import {
  createChatWorld,
  type ChatWorld,
  type HomeAlias,
} from "test/chat/chat-seeded-world";

describe("[seeded-e2e] Chat message edit and delete", () => {
  let world: ChatWorld;

  function auth(token: string): string {
    return `Bearer ${token}`;
  }

  async function sendAs(alias: HomeAlias, content: string): Promise<number> {
    const response = await request(world.server)
      .post(`/chat/channels/${String(world.privateChannelId)}/messages`)
      .set("Authorization", auth(world.tokenFor(alias)))
      .send({ content });
    expect(response.status).toBe(201);
    return Number(response.body?.id);
  }

  async function sendToPublicAs(alias: HomeAlias, content: string): Promise<number> {
    const response = await request(world.server)
      .post(`/chat/channels/${String(world.publicChannelId)}/messages`)
      .set("Authorization", auth(world.tokenFor(alias)))
      .send({ content });
    expect(response.status).toBe(201);
    return Number(response.body?.id);
  }

  async function readRow(messageId: number) {
    const [row] = await world.seeded.seedDb
      .select({
        content: chatMessages.content,
        isDeleted: chatMessages.isDeleted,
        isEdited: chatMessages.isEdited,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.orgId, world.home.orgId),
          eq(chatMessages.id, messageId),
        ),
      );
    return row;
  }

  beforeAll(async () => {
    world = await createChatWorld();
  }, 300_000);

  afterAll(async () => {
    if (world) await world.close();
  }, 180_000);

  it("ALLOW — the author edits their own message: 200, and the stored row carries the new content", async () => {
    const messageId = await sendAs("channelMember", "the original wording");

    const response = await request(world.server)
      .patch(
        `/chat/channels/${String(world.privateChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ content: "the corrected wording" });

    expect(response.status).toBe(200);
    const row = await readRow(messageId);
    expect(row?.content).toBe("the corrected wording");
    expect(row?.isEdited).toBe(true);
  });

  it("DENY — a different member of the same channel cannot edit it: 403, and the content is unchanged", async () => {
    const messageId = await sendAs("channelMember", "not yours to change");

    const response = await request(world.server)
      .patch(
        `/chat/channels/${String(world.privateChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({ content: "rewritten by someone else" });

    expect(response.status).toBe(403);
    expect((await readRow(messageId))?.content).toBe("not yours to change");
  });

  it("DENY — the org owner cannot edit another member's message either: 403", async () => {
    const messageId = await sendAs("channelMember", "owners do not rewrite history");

    const response = await request(world.server)
      .patch(
        `/chat/channels/${String(world.privateChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.tokenFor("owner")))
      .send({ content: "rewritten by the owner" });

    expect(response.status).toBe(403);
    expect((await readRow(messageId))?.content).toBe("owners do not rewrite history");
  });

  it("DENY — an org member outside the PRIVATE channel cannot edit: 404, never 403", async () => {
    const messageId = await sendAs("channelMember", "outside the channel");

    const response = await request(world.server)
      .patch(
        `/chat/channels/${String(world.privateChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.tokenFor("outsider")))
      .send({ content: "rewritten from outside the channel" });

    expect(response.status).toBe(404);
    expect((await readRow(messageId))?.content).toBe("outside the channel");
  });

  it("CONTROL — the same non-member editing a message in the PUBLIC channel gets 403, not 404", async () => {
    const messageId = await sendToPublicAs("channelAdmin", "public and visible");

    const response = await request(world.server)
      .patch(
        `/chat/channels/${String(world.publicChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.tokenFor("outsider")))
      .send({ content: "rewritten from outside a public channel" });

    expect(response.status).toBe(403);
    expect((await readRow(messageId))?.content).toBe("public and visible");
  });

  it("CONTROL — a member of the PUBLIC channel still edits their own message: 200", async () => {
    const messageId = await sendToPublicAs("channelMember", "mine to correct");

    const response = await request(world.server)
      .patch(
        `/chat/channels/${String(world.publicChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ content: "corrected in public" });

    expect(response.status).toBe(200);
    expect((await readRow(messageId))?.content).toBe("corrected in public");
  });

  it("CROSS-TENANT — a member of the other organisation editing this message gets 404", async () => {
    const messageId = await sendAs("channelMember", "cross-tenant edit target");

    const response = await request(world.server)
      .patch(
        `/chat/channels/${String(world.privateChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.strangerToken))
      .send({ content: "rewritten from another tenant" });

    expect(response.status).toBe(404);
    expect((await readRow(messageId))?.content).toBe("cross-tenant edit target");
  });

  it("REFUSE — editing through a channel id the message does not belong to gets 404", async () => {
    const messageId = await sendAs("channelMember", "addressed through the wrong channel");

    const response = await request(world.server)
      .patch(
        `/chat/channels/${String(world.publicChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ content: "rewritten through the wrong channel" });

    expect(response.status).toBe(404);
    expect((await readRow(messageId))?.content).toBe(
      "addressed through the wrong channel",
    );
  });

  it("ALLOW — the author soft-deletes their own message: 200, and the row is marked deleted", async () => {
    const messageId = await sendAs("channelMember", "delete me");

    const response = await request(world.server)
      .delete(
        `/chat/channels/${String(world.privateChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(200);
    const row = await readRow(messageId);
    expect(row?.isDeleted).toBe(true);
    expect(row?.content).toBeNull();
  });

  it("DENY — a non-author, non-owner member of the channel cannot delete it: 403, and the row survives", async () => {
    const messageId = await sendAs("channelMember", "survives a stranger's delete");

    const response = await request(world.server)
      .delete(
        `/chat/channels/${String(world.privateChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.tokenFor("channelAdmin")));

    expect(response.status).toBe(403);
    const row = await readRow(messageId);
    expect(row?.isDeleted).toBe(false);
    expect(row?.content).toBe("survives a stranger's delete");
  });

  it("DENY — an org member outside the PRIVATE channel cannot delete: 404, and the row survives", async () => {
    const messageId = await sendAs("channelMember", "survives an outsider's delete");

    const response = await request(world.server)
      .delete(
        `/chat/channels/${String(world.privateChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.tokenFor("outsider")));

    expect(response.status).toBe(404);
    const row = await readRow(messageId);
    expect(row?.isDeleted).toBe(false);
    expect(row?.content).toBe("survives an outsider's delete");
  });

  it("CONTROL — the same non-member deleting a message in the PUBLIC channel gets 403, not 404", async () => {
    const messageId = await sendToPublicAs("channelAdmin", "public delete target");

    const response = await request(world.server)
      .delete(
        `/chat/channels/${String(world.publicChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.tokenFor("outsider")));

    expect(response.status).toBe(403);
    expect((await readRow(messageId))?.isDeleted).toBe(false);
  });

  it("ALLOW — the org owner, being a member of the channel, deletes another member's message: 200", async () => {
    const messageId = await sendAs("channelMember", "moderated by the org owner");

    const response = await request(world.server)
      .delete(
        `/chat/channels/${String(world.privateChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.tokenFor("owner")));

    expect(response.status).toBe(200);
    expect((await readRow(messageId))?.isDeleted).toBe(true);
  });

  it("CROSS-TENANT — a member of the other organisation deleting this message gets 404", async () => {
    const messageId = await sendAs("channelMember", "cross-tenant delete target");

    const response = await request(world.server)
      .delete(
        `/chat/channels/${String(world.privateChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.strangerToken));

    expect(response.status).toBe(404);
    expect((await readRow(messageId))?.isDeleted).toBe(false);
  });

  it("REFUSE — deleting through a channel id the message does not belong to gets 404", async () => {
    const messageId = await sendAs("channelMember", "wrong channel on delete");

    const response = await request(world.server)
      .delete(
        `/chat/channels/${String(world.publicChannelId)}/messages/${String(messageId)}`,
      )
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(404);
    expect((await readRow(messageId))?.isDeleted).toBe(false);
  });
});
