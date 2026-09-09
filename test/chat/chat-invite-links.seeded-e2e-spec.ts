import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import request from "supertest";
import { chatChannelInviteLinks, chatChannelMembers, chatChannels } from "src/db/schema";
import { encryptSecret } from "src/common/security/secret-encryption.util";
import { createChatWorld, type ChatWorld } from "test/chat/chat-seeded-world";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function insertInviteLink(
  db: ChatWorld["seeded"]["seedDb"],
  orgId: string,
  channelId: number,
  opts: {
    tokenHash: string;
    tokenEncrypted: string;
    revokedAt?: Date | null;
    expiresAt?: Date | null;
    maxUses?: number | null;
    useCount?: number;
  },
) {
  await db.insert(chatChannelInviteLinks).values({
    orgId,
    channelId,
    token: null,
    tokenHash: opts.tokenHash,
    tokenEncrypted: opts.tokenEncrypted,
    revokedAt: opts.revokedAt ?? null,
    expiresAt: opts.expiresAt ?? null,
    maxUses: opts.maxUses ?? null,
    useCount: opts.useCount ?? 0,
  });
}

async function purgeInviteLinks(db: ChatWorld["seeded"]["seedDb"], orgId: string) {
  await db.delete(chatChannelInviteLinks).where(eq(chatChannelInviteLinks.orgId, orgId));
}

describe("[seeded-e2e] Chat invite links", () => {
  let world: ChatWorld;

  function auth(token: string) {
    return `Bearer ${token}`;
  }

  function mintPath(channelId: number) {
    return `/chat/channels/${String(channelId)}/invite-link`;
  }

  function joinPath(token: string) {
    return `/chat/invite-links/${token}/join`;
  }

  async function inviteLinkCount(channelId: number) {
    const rows = await world.seeded.seedDb
      .select({ id: chatChannelInviteLinks.id })
      .from(chatChannelInviteLinks)
      .where(eq(chatChannelInviteLinks.channelId, channelId));
    return rows.length;
  }

  async function membershipRow(channelId: number, membershipId: number) {
    const [row] = await world.seeded.seedDb
      .select({ id: chatChannelMembers.id })
      .from(chatChannelMembers)
      .where(
        and(
          eq(chatChannelMembers.orgId, world.home.orgId),
          eq(chatChannelMembers.channelId, channelId),
          eq(chatChannelMembers.membershipId, membershipId),
        ),
      );
    return row ?? null;
  }

  async function linkUseCount(tokenHash: string) {
    const [row] = await world.seeded.seedDb
      .select({ useCount: chatChannelInviteLinks.useCount })
      .from(chatChannelInviteLinks)
      .where(eq(chatChannelInviteLinks.tokenHash, tokenHash));
    return row?.useCount ?? null;
  }

  beforeAll(async () => {
    world = await createChatWorld();
  }, 300_000);

  afterAll(async () => {
    if (world) {
      await purgeInviteLinks(world.seeded.seedDb, world.home.orgId);
      await purgeInviteLinks(world.seeded.seedDb, world.neighbour.orgId);
      await world.close();
    }
  }, 180_000);

  describe("MINT / REGENERATE access control", () => {
    it("a non-admin channel member calling mint is refused 403 and no link is created", async () => {
      const before = await inviteLinkCount(world.publicChannelId);
      const response = await request(world.server)
        .post(mintPath(world.publicChannelId))
        .set("Authorization", auth(world.tokenFor("channelMember")))
        .send({});
      expect(response.status).toBe(403);
      expect(await inviteLinkCount(world.publicChannelId)).toBe(before);
    });

    it("a non-member calling mint on the PRIVATE channel is refused 404 and no link is created", async () => {
      const before = await inviteLinkCount(world.privateChannelId);
      const response = await request(world.server)
        .post(mintPath(world.privateChannelId))
        .set("Authorization", auth(world.tokenFor("outsider")))
        .send({});
      expect(response.status).toBe(404);
      expect(await inviteLinkCount(world.privateChannelId)).toBe(before);
    });
  });

  describe("JOIN — valid token (public channel)", () => {
    let activeToken: string;
    let activeTokenHash: string;

    beforeAll(async () => {
      await purgeInviteLinks(world.seeded.seedDb, world.home.orgId);
      const mintRes = await request(world.server)
        .post(mintPath(world.publicChannelId))
        .set("Authorization", auth(world.tokenFor("channelAdmin")))
        .send({});
      expect(mintRes.status).toBe(200);
      activeToken = mintRes.body.token as string;
      activeTokenHash = hashToken(activeToken);
    });

    beforeEach(async () => {
      await world.seeded.seedDb
        .delete(chatChannelMembers)
        .where(
          and(
            eq(chatChannelMembers.orgId, world.home.orgId),
            eq(chatChannelMembers.channelId, world.publicChannelId),
            eq(chatChannelMembers.membershipId, world.membershipIdFor("outsider")),
          ),
        );
    });

    it("ALLOW — a valid token lets an org member join → 200 and membership row is created", async () => {
      const before = await world.memberCount(world.publicChannelId);
      const response = await request(world.server)
        .post(joinPath(activeToken))
        .set("Authorization", auth(world.tokenFor("outsider")));

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(await world.memberCount(world.publicChannelId)).toBe(before + 1);
      expect(await membershipRow(world.publicChannelId, world.membershipIdFor("outsider"))).not.toBeNull();
      expect(await linkUseCount(activeTokenHash)).toBe(1);
    });

    it("ALLOW (idempotent) — the same member joining twice → 200, still exactly one row, use_count incremented only once", async () => {
      await request(world.server)
        .post(joinPath(activeToken))
        .set("Authorization", auth(world.tokenFor("outsider")));
      const beforeCount = await world.memberCount(world.publicChannelId);
      const beforeUseCount = await linkUseCount(activeTokenHash);

      const response = await request(world.server)
        .post(joinPath(activeToken))
        .set("Authorization", auth(world.tokenFor("outsider")));

      expect(response.status).toBe(200);
      expect(await world.memberCount(world.publicChannelId)).toBe(beforeCount);
      expect(await linkUseCount(activeTokenHash)).toBe(beforeUseCount);
    });
  });

  describe("JOIN — denial cases", () => {
    const REVOKED_TOKEN = "aabbccddeeff00112233445566778899aabbccddeeff0011";
    const EXPIRED_TOKEN = "bbccddee00ff1122334455667788990011bbccddee00ff11";
    const EXHAUSTED_TOKEN = "ccddeeff11002233445566778899001122ccddeeff110022";

    const revokedHash = hashToken(REVOKED_TOKEN);
    const expiredHash = hashToken(EXPIRED_TOKEN);
    const exhaustedHash = hashToken(EXHAUSTED_TOKEN);

    beforeAll(async () => {
      await purgeInviteLinks(world.seeded.seedDb, world.home.orgId);

      await insertInviteLink(world.seeded.seedDb, world.home.orgId, world.publicChannelId, {
        tokenHash: revokedHash,
        tokenEncrypted: encryptSecret(REVOKED_TOKEN),
        revokedAt: new Date(Date.now() - 60_000),
      });

      await insertInviteLink(world.seeded.seedDb, world.home.orgId, world.privateChannelId, {
        tokenHash: expiredHash,
        tokenEncrypted: encryptSecret(EXPIRED_TOKEN),
        expiresAt: new Date(Date.now() - 60_000),
      });

      await insertInviteLink(world.seeded.seedDb, world.home.orgId, world.publicChannelId, {
        tokenHash: exhaustedHash,
        tokenEncrypted: encryptSecret(EXHAUSTED_TOKEN),
        maxUses: 1,
        useCount: 1,
      });
    });

    it("DENY — revoked token → 404, no membership row created", async () => {
      const before = await world.memberCount(world.publicChannelId);
      const response = await request(world.server)
        .post(joinPath(REVOKED_TOKEN))
        .set("Authorization", auth(world.tokenFor("outsider")));
      expect(response.status).toBe(404);
      expect(await world.memberCount(world.publicChannelId)).toBe(before);
    });

    it("DENY — expired token → 404, no membership row created", async () => {
      const before = await world.memberCount(world.privateChannelId);
      const response = await request(world.server)
        .post(joinPath(EXPIRED_TOKEN))
        .set("Authorization", auth(world.tokenFor("outsider")));
      expect(response.status).toBe(404);
      expect(await world.memberCount(world.privateChannelId)).toBe(before);
    });

    it("DENY — exhausted token (use_count >= max_uses) → 404, no membership row created", async () => {
      const before = await world.memberCount(world.publicChannelId);
      const response = await request(world.server)
        .post(joinPath(EXHAUSTED_TOKEN))
        .set("Authorization", auth(world.tokenFor("outsider")));
      expect(response.status).toBe(404);
      expect(await world.memberCount(world.publicChannelId)).toBe(before);
    });

    it("404 body is byte-identical across revoked, expired and exhausted — no oracle", async () => {
      const [r1, r2, r3] = await Promise.all([
        request(world.server)
          .post(joinPath(REVOKED_TOKEN))
          .set("Authorization", auth(world.tokenFor("channelMember"))),
        request(world.server)
          .post(joinPath(EXPIRED_TOKEN))
          .set("Authorization", auth(world.tokenFor("channelMember"))),
        request(world.server)
          .post(joinPath(EXHAUSTED_TOKEN))
          .set("Authorization", auth(world.tokenFor("channelMember"))),
      ]);
      expect(r1?.status).toBe(404);
      expect(r2?.status).toBe(404);
      expect(r3?.status).toBe(404);
      const body1 = JSON.stringify(r1?.body);
      expect(JSON.stringify(r2?.body)).toBe(body1);
      expect(JSON.stringify(r3?.body)).toBe(body1);
    });
  });

  describe("JOIN — archived channel", () => {
    let archivedChannelToken: string;

    beforeAll(async () => {
      await purgeInviteLinks(world.seeded.seedDb, world.home.orgId);
      const mintRes = await request(world.server)
        .post(mintPath(world.publicChannelId))
        .set("Authorization", auth(world.tokenFor("channelAdmin")))
        .send({});
      expect(mintRes.status).toBe(200);
      archivedChannelToken = mintRes.body.token as string;

      await world.seeded.seedDb
        .update(chatChannels)
        .set({ isArchived: true })
        .where(eq(chatChannels.id, world.publicChannelId));
    });

    afterAll(async () => {
      await world.seeded.seedDb
        .update(chatChannels)
        .set({ isArchived: false })
        .where(eq(chatChannels.id, world.publicChannelId));
    });

    it("DENY — archived channel → 404, no membership row created", async () => {
      const before = await world.memberCount(world.publicChannelId);
      const response = await request(world.server)
        .post(joinPath(archivedChannelToken))
        .set("Authorization", auth(world.tokenFor("outsider")));
      expect(response.status).toBe(404);
      expect(await world.memberCount(world.publicChannelId)).toBe(before);
    });
  });

  describe("CROSS-TENANT isolation", () => {
    it("a member of the other org redeeming this org's token → 404, no row created", async () => {
      await purgeInviteLinks(world.seeded.seedDb, world.home.orgId);
      const mintRes = await request(world.server)
        .post(mintPath(world.publicChannelId))
        .set("Authorization", auth(world.tokenFor("channelAdmin")))
        .send({});
      expect(mintRes.status).toBe(200);
      const token = mintRes.body.token as string;

      const before = await world.memberCount(world.publicChannelId);
      const response = await request(world.server)
        .post(joinPath(token))
        .set("Authorization", auth(world.strangerToken));

      expect(response.status).toBe(404);
      expect(await world.memberCount(world.publicChannelId)).toBe(before);
    });
  });
});
