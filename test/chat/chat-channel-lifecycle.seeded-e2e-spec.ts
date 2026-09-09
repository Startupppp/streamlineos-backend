import { and, eq } from "drizzle-orm";
import request from "supertest";
import { chatChannelMembers, chatChannels } from "src/db/schema";
import { createChatWorld, type ChatWorld } from "test/chat/chat-seeded-world";

const CREATED_CHANNEL_NAME = "seeded-created-public";

type StateRoute = readonly [string, Record<string, string> | null];

interface CreatedChannelMember {
  readonly userId: string | null;
  readonly role: string;
  readonly user: { readonly id: string } | null;
}

interface CreatedChannel {
  readonly id: number;
  readonly members?: readonly CreatedChannelMember[];
}

interface ChannelMembersPage {
  readonly members?: readonly CreatedChannelMember[];
  readonly nextCursor?: number | null;
}

const PER_USER_STATE_ROUTES: readonly StateRoute[] = [
  ["archive", null],
  ["unarchive", null],
  ["mute", { duration: "1h" }],
  ["unmute", null],
  ["favorite", null],
  ["unfavorite", null],
];

describe("[seeded-e2e] Chat channel creation and per-user channel state", () => {
  let world: ChatWorld;

  function auth(token: string): string {
    return `Bearer ${token}`;
  }

  function post(channelId: number, action: string, token: string, body: Record<string, string> | null) {
    const call = request(world.server)
      .post(`/chat/channels/${String(channelId)}/${action}`)
      .set("Authorization", auth(token));
    return body === null ? call.send() : call.send(body);
  }

  async function privateChannelName(): Promise<string | undefined> {
    const [row] = await world.seeded.seedDb
      .select({ name: chatChannels.name })
      .from(chatChannels)
      .where(
        and(
          eq(chatChannels.orgId, world.home.orgId),
          eq(chatChannels.id, world.privateChannelId),
        ),
      );
    return row?.name;
  }

  async function channelCount(): Promise<number> {
    const rows = await world.seeded.seedDb
      .select({ id: chatChannels.id })
      .from(chatChannels)
      .where(eq(chatChannels.orgId, world.home.orgId));
    return rows.length;
  }

  beforeAll(async () => {
    world = await createChatWorld();
  }, 300_000);

  afterAll(async () => {
    if (world) await world.close();
  }, 180_000);

  it("CREATE — a normal PUBLIC create is 201 and adds exactly one channel", async () => {
    const before = await channelCount();

    const response = await request(world.server)
      .post("/chat/channels")
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({
        type: "PUBLIC",
        name: CREATED_CHANNEL_NAME,
        memberIds: [world.userIdFor("channelMember")],
      });

    expect(await channelCount()).toBe(before + 1);
    expect(response.status).toBe(201);
  });

  it("CREATE — the 201 body carries the roster its response contract declares, creator as ADMIN", async () => {
    const response = await request(world.server)
      .post("/chat/channels")
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({
        type: "PRIVATE",
        name: "seeded-created-roster",
        memberIds: [world.userIdFor("channelMember")],
      });

    expect(response.status).toBe(201);
    const created: CreatedChannel = response.body;
    expect(Array.isArray(created.members)).toBe(true);
    const members = created.members ?? [];
    expect(members).toHaveLength(2);

    const creator = members.find((m) => m.userId === world.userIdFor("channelAdmin"));
    expect(creator?.role).toBe("ADMIN");
    expect(creator?.user?.id).toBe(world.userIdFor("channelAdmin"));

    const invitee = members.find((m) => m.userId === world.userIdFor("channelMember"));
    expect(invitee?.role).toBe("MEMBER");
  });

  it("CREATE — a self DM answers 201 with the creator on its roster", async () => {
    const response = await request(world.server)
      .post("/chat/channels")
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({ type: "DIRECT", targetUserId: world.userIdFor("channelAdmin") });

    expect(response.status).toBe(201);
    const created: CreatedChannel = response.body;
    expect(created.members).toHaveLength(1);
    expect(created.members?.[0]?.userId).toBe(world.userIdFor("channelAdmin"));
  });

  it("CREATE — re-requesting that DM answers 200 with the same roster shape, never a bare row", async () => {
    const response = await request(world.server)
      .post("/chat/channels")
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({ type: "DIRECT", targetUserId: world.userIdFor("channelAdmin") });

    expect(response.status).toBe(200);
    const existing: CreatedChannel = response.body;
    expect(existing.members).toHaveLength(1);
    expect(existing.members?.[0]?.userId).toBe(world.userIdFor("channelAdmin"));
  });

  it("CREATE — the creator of that channel is stored as its ADMIN and the invitee as MEMBER", async () => {
    const [created] = await world.seeded.seedDb
      .select({ id: chatChannels.id })
      .from(chatChannels)
      .where(
        and(
          eq(chatChannels.orgId, world.home.orgId),
          eq(chatChannels.name, CREATED_CHANNEL_NAME),
        ),
      );
    expect(created?.id).toBeGreaterThan(0);

    const rows = await world.seeded.seedDb
      .select({
        membershipId: chatChannelMembers.membershipId,
        role: chatChannelMembers.role,
      })
      .from(chatChannelMembers)
      .where(
        and(
          eq(chatChannelMembers.orgId, world.home.orgId),
          eq(chatChannelMembers.channelId, created?.id ?? 0),
        ),
      );

    const roleByMembership = new Map(rows.map((row) => [row.membershipId, row.role]));
    expect(roleByMembership.get(world.membershipIdFor("channelAdmin"))).toBe("ADMIN");
    expect(roleByMembership.get(world.membershipIdFor("channelMember"))).toBe("MEMBER");
  });

  it("CREATE — a body naming a record through entityType/entityId is 400 and creates nothing", async () => {
    const before = await channelCount();

    const response = await request(world.server)
      .post("/chat/channels")
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({
        type: "PUBLIC",
        name: "seeded-record-channel",
        memberIds: [world.userIdFor("channelMember")],
        entityType: "ticket",
        entityId: "42",
      });

    expect(response.status).toBe(400);
    expect(await channelCount()).toBe(before);
  });

  it("CREATE — a memberIds entry from another organisation is 404 and creates nothing", async () => {
    const before = await channelCount();

    const response = await request(world.server)
      .post("/chat/channels")
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({
        type: "PRIVATE",
        name: "seeded-cross-tenant-channel",
        memberIds: [world.strangerUserId],
      });

    expect(response.status).toBe(404);
    expect(await channelCount()).toBe(before);
  });

  it("CREATE — an empty memberIds list is rejected 400 and creates nothing", async () => {
    const before = await channelCount();

    const response = await request(world.server)
      .post("/chat/channels")
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({ type: "PUBLIC", name: "seeded-empty-roster", memberIds: [] });

    expect(response.status).toBe(400);
    expect(await channelCount()).toBe(before);
  });

  for (const [action, body] of PER_USER_STATE_ROUTES) {
    it(`ALLOW — a channel member calls ${action} on their private channel: 200`, async () => {
      const response = await post(
        world.privateChannelId,
        action,
        world.tokenFor("channelMember"),
        body,
      );
      expect(response.status).toBe(200);
    });

    it(`DENY — a non-member calls ${action} on the PRIVATE channel: 404`, async () => {
      const response = await post(
        world.privateChannelId,
        action,
        world.tokenFor("outsider"),
        body,
      );
      expect(response.status).toBe(404);
    });

    it(`DENY — a non-member calls ${action} on the PUBLIC channel: 403`, async () => {
      const response = await post(
        world.publicChannelId,
        action,
        world.tokenFor("outsider"),
        body,
      );
      expect(response.status).toBe(403);
    });

    it(`CROSS-TENANT — the other organisation calls ${action} on this private channel: 404`, async () => {
      const response = await post(
        world.privateChannelId,
        action,
        world.strangerToken,
        body,
      );
      expect(response.status).toBe(404);
    });
  }

  it("ALLOW — a channel member reads the channel detail: 200", async () => {
    const response = await request(world.server)
      .get(`/chat/channels/${String(world.privateChannelId)}`)
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(200);
  });

  it("ALLOW — a channel member reads the member list: 200, and a short page carries nextCursor: null", async () => {
    const response = await request(world.server)
      .get(`/chat/channels/${String(world.privateChannelId)}/members`)
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(200);
    const page: ChannelMembersPage = response.body;
    expect(page.members?.length).toBeGreaterThan(0);
    expect(Object.keys(response.body)).toContain("nextCursor");
    expect(page.nextCursor).toBeNull();
  });

  it("DENY — a non-member reading the private channel detail gets 404", async () => {
    const response = await request(world.server)
      .get(`/chat/channels/${String(world.privateChannelId)}`)
      .set("Authorization", auth(world.tokenFor("outsider")));

    expect(response.status).toBe(404);
  });

  it("DENY — a non-member reading the private member list gets 404", async () => {
    const response = await request(world.server)
      .get(`/chat/channels/${String(world.privateChannelId)}/members`)
      .set("Authorization", auth(world.tokenFor("outsider")));

    expect(response.status).toBe(404);
  });

  it("CROSS-TENANT — the other organisation reading this channel detail gets 404", async () => {
    const response = await request(world.server)
      .get(`/chat/channels/${String(world.privateChannelId)}`)
      .set("Authorization", auth(world.strangerToken));

    expect(response.status).toBe(404);
  });

  it("CROSS-TENANT — the other organisation reading this member list gets 404", async () => {
    const response = await request(world.server)
      .get(`/chat/channels/${String(world.privateChannelId)}/members`)
      .set("Authorization", auth(world.strangerToken));

    expect(response.status).toBe(404);
  });

  it("UPDATE — a non-member of the PRIVATE channel is refused 404 and the name is unchanged", async () => {
    const response = await request(world.server)
      .patch(`/chat/channels/${String(world.privateChannelId)}`)
      .set("Authorization", auth(world.tokenFor("outsider")))
      .send({ name: "renamed-by-a-non-member" });

    expect(response.status).toBe(404);
    expect(await privateChannelName()).toBe("seeded-private-channel");
  });

  it("UPDATE — a non-member of the PUBLIC channel is refused 403, not 404", async () => {
    const response = await request(world.server)
      .patch(`/chat/channels/${String(world.publicChannelId)}`)
      .set("Authorization", auth(world.tokenFor("outsider")))
      .send({ name: "renamed-by-a-non-member" });

    expect(response.status).toBe(403);
  });

  it("UPDATE — the other organisation is refused 404 and the name is unchanged", async () => {
    const response = await request(world.server)
      .patch(`/chat/channels/${String(world.privateChannelId)}`)
      .set("Authorization", auth(world.strangerToken))
      .send({ name: "renamed-from-another-tenant" });

    expect(response.status).toBe(404);
    expect(await privateChannelName()).toBe("seeded-private-channel");
  });

  it("DENY — a plain member cannot rename the channel: 403", async () => {
    const response = await request(world.server)
      .patch(`/chat/channels/${String(world.privateChannelId)}`)
      .set("Authorization", auth(world.tokenFor("channelMember")))
      .send({ name: "renamed-by-a-plain-member" });

    expect(response.status).toBe(403);
    expect(await privateChannelName()).toBe("seeded-private-channel");
  });

  it("ALLOW — the channel admin renames the channel: 200 and the stored name changes", async () => {
    const response = await request(world.server)
      .patch(`/chat/channels/${String(world.privateChannelId)}`)
      .set("Authorization", auth(world.tokenFor("channelAdmin")))
      .send({ name: "renamed-by-the-channel-admin" });

    expect(response.status).toBe(200);
    expect(await privateChannelName()).toBe("renamed-by-the-channel-admin");
  });
});
