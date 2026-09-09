import { and, eq } from "drizzle-orm";
import request from "supertest";
import { chatAttachments, chatMessages } from "src/db/schema";
import { createChatWorld, type ChatWorld } from "test/chat/chat-seeded-world";
import { FileQuarantineService } from "src/modules/storage/file-quarantine.service";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";

interface ChannelFilePage {
  readonly files?: readonly { readonly id: number }[];
}

describe("[seeded-e2e] Chat attachments", () => {
  let world: ChatWorld;
  let privateAttachmentId = 0;
  let privateFileKey = "";
  let publicAttachmentId = 0;
  let doomedMessageId = 0;
  let doomedAttachmentId = 0;

  function auth(token: string): string {
    return `Bearer ${token}`;
  }

  function signedUrlPath(channelId: number, attachmentId: number): string {
    return `/chat/channels/${String(channelId)}/attachments/${String(attachmentId)}`;
  }

  async function sendWithAttachment(
    channelId: number,
    token: string,
    fileName: string,
  ): Promise<{ messageId: number; attachmentId: number; fileKey: string }> {
    const fileKey = `${world.home.orgId}/chat/${fileName}`;
    const response = await request(world.server)
      .post(`/chat/channels/${String(channelId)}/messages`)
      .set("Authorization", auth(token))
      .send({
        content: `carrying ${fileName}`,
        attachments: [
          {
            fileName,
            fileUrl: "",
            fileKey,
            fileSize: 1024,
            mimeType: "text/plain",
          },
        ],
      });
    expect(response.status).toBe(201);
    const messageId = Number(response.body?.id);
    const [row] = await world.seeded.seedDb
      .select({ id: chatAttachments.id })
      .from(chatAttachments)
      .where(
        and(
          eq(chatAttachments.orgId, world.home.orgId),
          eq(chatAttachments.messageId, messageId),
        ),
      );
    if (!row) throw new Error("[chat-attachments] the attachment row was not written");
    return { messageId, attachmentId: row.id, fileKey };
  }

  beforeAll(async () => {
    world = await createChatWorld();

    const inPrivate = await sendWithAttachment(
      world.privateChannelId,
      world.tokenFor("channelMember"),
      "private-note.txt",
    );
    privateAttachmentId = inPrivate.attachmentId;
    privateFileKey = inPrivate.fileKey;

    const inPublic = await sendWithAttachment(
      world.publicChannelId,
      world.tokenFor("channelAdmin"),
      "public-note.txt",
    );
    publicAttachmentId = inPublic.attachmentId;

    const doomed = await sendWithAttachment(
      world.privateChannelId,
      world.tokenFor("channelMember"),
      "doomed-note.txt",
    );
    doomedMessageId = doomed.messageId;
    doomedAttachmentId = doomed.attachmentId;
    await world.seeded.seedDb
      .update(chatMessages)
      .set({ isDeleted: true, content: null })
      .where(
        and(
          eq(chatMessages.orgId, world.home.orgId),
          eq(chatMessages.id, doomedMessageId),
        ),
      );
  }, 300_000);

  afterAll(async () => {
    if (world) await world.close();
  }, 180_000);

  it("fixture check — three attachment rows exist and one owning message is soft-deleted", () => {
    expect(privateAttachmentId).toBeGreaterThan(0);
    expect(publicAttachmentId).toBeGreaterThan(0);
    expect(doomedAttachmentId).toBeGreaterThan(0);
    expect(privateFileKey.startsWith(`${world.home.orgId}/chat/`)).toBe(true);
  });

  it("ALLOW — a channel member lists the channel's files and sees the attachment: 200", async () => {
    const response = await request(world.server)
      .get(`/chat/channels/${String(world.privateChannelId)}/files`)
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(200);
    const page: ChannelFilePage = response.body;
    expect((page.files ?? []).map((file) => file.id)).toContain(privateAttachmentId);
  });

  it("ALLOW — a channel member passes the attachment gate and reaches the object store", async () => {
    const response = await request(world.server)
      .get(signedUrlPath(world.privateChannelId, privateAttachmentId))
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).not.toBe(404);
    expect(response.status).not.toBe(403);
    expect([200, 503]).toContain(response.status);
  });

  it("DENY — a non-member of the private channel gets 404", async () => {
    const response = await request(world.server)
      .get(signedUrlPath(world.privateChannelId, privateAttachmentId))
      .set("Authorization", auth(world.tokenFor("outsider")));

    expect(response.status).toBe(404);
  });

  it("DENY — a removed member of the private channel gets 404", async () => {
    const response = await request(world.server)
      .get(signedUrlPath(world.privateChannelId, privateAttachmentId))
      .set("Authorization", auth(world.tokenFor("removed")));

    expect(response.status).toBe(404);
  });

  it("DENY — a non-member of the public channel gets 403", async () => {
    const response = await request(world.server)
      .get(signedUrlPath(world.publicChannelId, publicAttachmentId))
      .set("Authorization", auth(world.tokenFor("outsider")));

    expect(response.status).toBe(403);
  });

  it("CROSS-TENANT — a member of the other organisation gets 404", async () => {
    const response = await request(world.server)
      .get(signedUrlPath(world.privateChannelId, privateAttachmentId))
      .set("Authorization", auth(world.strangerToken));

    expect(response.status).toBe(404);
  });

  it("REFUSE — an attachment addressed through another channel's id gets 404", async () => {
    const response = await request(world.server)
      .get(signedUrlPath(world.publicChannelId, privateAttachmentId))
      .set("Authorization", auth(world.tokenFor("channelAdmin")));

    expect(response.status).toBe(404);
  });

  it("REFUSE — a member gets 404 once the owning message is soft-deleted", async () => {
    const response = await request(world.server)
      .get(signedUrlPath(world.privateChannelId, doomedAttachmentId))
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(404);
  });

  it("REFUSE — the soft-deleted message's file no longer appears in the channel file list", async () => {
    const response = await request(world.server)
      .get(`/chat/channels/${String(world.privateChannelId)}/files`)
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).toBe(200);
    const page: ChannelFilePage = response.body;
    expect((page.files ?? []).map((file) => file.id)).not.toContain(doomedAttachmentId);
  });

  it("DENY — the channel file list is 404 for a non-member of the private channel", async () => {
    const response = await request(world.server)
      .get(`/chat/channels/${String(world.privateChannelId)}/files`)
      .set("Authorization", auth(world.tokenFor("outsider")));

    expect(response.status).toBe(404);
  });

  it("CROSS-TENANT — the channel file list is 404 for a member of the other organisation", async () => {
    const response = await request(world.server)
      .get(`/chat/channels/${String(world.privateChannelId)}/files`)
      .set("Authorization", auth(world.strangerToken));

    expect(response.status).toBe(404);
  });

  it("REFUSE — a tracked chat attachment key is not downloadable through GET /storage/download", async () => {
    const response = await request(world.server)
      .get("/storage/download")
      .query({ key: privateFileKey })
      .set("Authorization", auth(world.tokenFor("channelMember")));

    expect(response.status).not.toBe(200);
    expect([404, 503]).toContain(response.status);
  });

  it("CROSS-TENANT — the chat attachment key is not downloadable by the other organisation either", async () => {
    const response = await request(world.server)
      .get("/storage/download")
      .query({ key: privateFileKey })
      .set("Authorization", auth(world.strangerToken));

    expect(response.status).not.toBe(200);
    expect([404, 503]).toContain(response.status);
  });

  describe("QUARANTINE — chat signed-URL path refuses a key recorded in the quarantine table", () => {
    let quarantinedAttachmentId = 0;
    let quarantinedFileKey = "";
    let quarantineRecordId = "";

    beforeAll(async () => {
      const sent = await sendWithAttachment(
        world.privateChannelId,
        world.tokenFor("channelMember"),
        "quarantine-test.txt",
      );
      quarantinedAttachmentId = sent.attachmentId;
      quarantinedFileKey = sent.fileKey;

      const appDb = world.seeded.app.get<Db>(DRIZZLE);
      const quarantine = world.seeded.app.get(FileQuarantineService);

      quarantineRecordId = await runInNewTenantTransaction(appDb, world.home.orgId, () =>
        quarantine.begin({
          orgId: world.home.orgId,
          storageKey: quarantinedFileKey,
          filename: "quarantine-test.txt",
          mimeType: "text/plain",
          fileSizeBytes: 1024,
          sha256: "cafebabe".repeat(8),
          uploadedBy: world.userIdFor("channelMember"),
        }),
      );
    }, 60_000);

    afterAll(async () => {
      if (quarantineRecordId) {
        const appDb = world.seeded.app.get<Db>(DRIZZLE);
        const quarantine = world.seeded.app.get(FileQuarantineService);
        await runInNewTenantTransaction(appDb, world.home.orgId, () =>
          quarantine.softDelete(quarantineRecordId),
        );
      }
    }, 60_000);

    it("DENY — a channel member is refused 404 for an attachment whose key is pending_scan in quarantine", async () => {
      expect(quarantinedAttachmentId).toBeGreaterThan(0);

      const response = await request(world.server)
        .get(signedUrlPath(world.privateChannelId, quarantinedAttachmentId))
        .set("Authorization", auth(world.tokenFor("channelMember")));

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ message: "File not found" });
    });
  });
});
