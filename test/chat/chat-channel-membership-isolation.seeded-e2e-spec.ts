import { eq } from "drizzle-orm";
import request from "supertest";
import { chatChannels, chatChannelMembers, chatMessages } from "src/db/schema";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * Channel membership is the object-level authorization gate for chat. The RBAC layer
 * (`chat:channels:read`, `chat:messages:write`) controls whether a user can read and
 * write in chat at all; it does not control which specific channels they may enter.
 * Membership in `chat_channel_members` is the second gate.
 *
 * This file asks three questions in the database, not in mocks:
 *
 *   allow        an insider (a channel member) can read and post to their channel
 *   deny         an outsider who holds `chat:channels:read` and `chat:messages:write`
 *                but is NOT a member of the private channel is refused at 404 on read
 *                AND at 404 on write — the channel is private, so neither verb may
 *                confirm that it exists
 *   cross-tenant a member of org B using org A's channel id gets 404 on read and 404 on
 *                write — the tenant predicate in `assertChannelMember` finds no channel
 *                in org B, and a cross-tenant miss is a miss
 *   integrity    after every refused write the `chat_messages` row count for that channel
 *                is re-read from the database and has not changed — the assertion no
 *                mocked spec can make
 *
 * WHAT THIS FILE DOES *NOT* PROVE. The `chat_channels` and `chat_channel_members` tables
 * carry RLS policies. Deleting the `eq(chatChannelMembers.orgId, orgId)` predicate from
 * `ChatChannelMembersImplementation.getChannel` may still leave this file green if the policy
 * supplies the tenant predicate independently. The attribution of the channel-read refusal
 * belongs to the service's own SQL — a unit test that compiles the query and asserts the
 * predicate is the right complement. The RBAC leg is what this file can attribute on its
 * own: narrowing the `chat:channels:read` grant to a less-permissive key turns the DENY
 * read case green-to-red here and nowhere else. The write count assertion does attribute
 * the service's membership guard: `ChatMessagesService.send` calls `assertChannelMember`
 * and throws before any INSERT, so a passing count assertion proves that guard fired.
 */
describe("[seeded-e2e] Chat channel membership — allow, deny and cross-tenant", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let homeChannelId = 0;
  let homeChannelMemberId = 0;
  let insiderToken = "";
  let outsiderToken = "";
  let neighbourToken = "";
  let server: unknown;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("insider", {
        permissionKeys: ["chat:channels:read", "chat:messages:write"],
      })
      .addMember("outsider", {
        permissionKeys: ["chat:channels:read", "chat:messages:write"],
      })
      .build();
    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .addMember("member", {
        permissionKeys: ["chat:channels:read", "chat:messages:write"],
      })
      .build();

    const [channelRow] = await seeded.seedDb
      .insert(chatChannels)
      .values({
        orgId: home.orgId,
        name: "secret-private-channel",
        type: "PRIVATE",
        isPrivate: true,
      })
      .returning({ id: chatChannels.id });
    homeChannelId = channelRow?.id ?? 0;

    const [memberRow] = await seeded.seedDb
      .insert(chatChannelMembers)
      .values({
        orgId: home.orgId,
        channelId: homeChannelId,
        membershipId: home.members.insider.membershipId,
      })
      .returning({ id: chatChannelMembers.id });
    homeChannelMemberId = memberRow?.id ?? 0;

    insiderToken = await signSeededToken(
      seeded,
      home.members.insider.userId,
      home.orgId,
    );
    outsiderToken = await signSeededToken(
      seeded,
      home.members.outsider.userId,
      home.orgId,
    );
    neighbourToken = await signSeededToken(
      seeded,
      neighbour.members.member.userId,
      neighbour.orgId,
    );
  }, 180_000);

  afterAll(async () => {
    if (homeChannelId > 0) {
      await seeded.seedDb
        .delete(chatMessages)
        .where(eq(chatMessages.channelId, homeChannelId));
      await seeded.seedDb
        .delete(chatChannelMembers)
        .where(eq(chatChannelMembers.channelId, homeChannelId));
      await seeded.seedDb
        .delete(chatChannels)
        .where(eq(chatChannels.id, homeChannelId));
    }
    if (home) await home.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  async function messageCount(): Promise<number> {
    const rows = await seeded.seedDb
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.channelId, homeChannelId));
    return rows.length;
  }

  it("fixture check — channel and two orgs are distinct, insider membership row exists", () => {
    expect(homeChannelId).toBeGreaterThan(0);
    expect(homeChannelMemberId).toBeGreaterThan(0);
    expect(home.orgId).not.toBe(neighbour.orgId);
  });

  it("ALLOW — the insider reads their private channel", async () => {
    const response = await request(server as never)
      .get(`/chat/channels/${String(homeChannelId)}`)
      .set("Authorization", `Bearer ${insiderToken}`);

    expect(response.status).toBe(200);
  });

  it("DENY (object-level read) — an outsider in the same org cannot see the private channel", async () => {
    const response = await request(server as never)
      .get(`/chat/channels/${String(homeChannelId)}`)
      .set("Authorization", `Bearer ${outsiderToken}`);

    expect(response.status).toBe(404);
  });

  it("CROSS-TENANT read — a member of another org cannot see the channel", async () => {
    const response = await request(server as never)
      .get(`/chat/channels/${String(homeChannelId)}`)
      .set("Authorization", `Bearer ${neighbourToken}`);

    expect(response.status).toBe(404);
  });

  it("DENY (object-level write) — an outsider cannot post to the private channel, and no message row is written", async () => {
    const before = await messageCount();

    const response = await request(server as never)
      .post(`/chat/channels/${String(homeChannelId)}/messages`)
      .set("Authorization", `Bearer ${outsiderToken}`)
      .send({ content: "intrusion attempt" });

    expect(response.status).toBe(404);
    expect(await messageCount()).toBe(before);
  });

  it("CROSS-TENANT write — a neighbour member cannot post to the channel, and the row count is unchanged", async () => {
    const before = await messageCount();

    const response = await request(server as never)
      .post(`/chat/channels/${String(homeChannelId)}/messages`)
      .set("Authorization", `Bearer ${neighbourToken}`)
      .send({ content: "cross-tenant intrusion" });

    expect(response.status).toBe(404);
    expect(await messageCount()).toBe(before);
  });

  it("ALLOW (write) — the insider can post to their channel, and exactly one row appears", async () => {
    const before = await messageCount();

    const response = await request(server as never)
      .post(`/chat/channels/${String(homeChannelId)}/messages`)
      .set("Authorization", `Bearer ${insiderToken}`)
      .send({ content: "hello from the inside" });

    expect(response.status).toBe(201);
    expect(await messageCount()).toBe(before + 1);
  });
});
