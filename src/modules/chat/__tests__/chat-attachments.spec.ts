import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ChatAttachmentsService } from "../chat-attachments.service";
import type { StorageService } from "../../storage/storage.service";
import type { ChatChannelMembersService } from "../chat-channel-members.service";
import { validateMagicBytes } from "../../storage/file-signatures";
import { StorageMultipartService } from "../../storage/storage-multipart.service";

/**
 * Denial semantics:
 *   - private channel non-member → 404 (hides channel existence)
 *   - public channel non-member  → 403 (confirms channel exists, denies access)
 * Every denial is paired with a control that proves the test bites.
 */

const ORG = "org-a";
const OTHER_ORG = "org-b";
const USER = "user-a";
const CHANNEL_ID = 1;
const ATTACHMENT_ID = 10;
const FILE_KEY = "chat/org-a/file.pdf";
const SIGNED_URL = "https://r2.example.com/signed?X-Amz-Signature=abc";

const VALID_ROW = { fileKey: FILE_KEY };

function makeDb(rows: unknown[] = []) {
  const mock = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  return mock as unknown as Db;
}

function makeMembers(opts: { error?: unknown } = {}) {
  return {
    assertChannelMembership: opts.error
      ? jest.fn().mockRejectedValue(opts.error)
      : jest.fn().mockResolvedValue(undefined),
  } as unknown as ChatChannelMembersService;
}

function makeStorage() {
  return {
    getFileUrl: jest.fn().mockResolvedValue(SIGNED_URL),
  } as unknown as StorageService;
}

function makeService(db: Db, members: ChatChannelMembersService, storage: StorageService) {
  return new ChatAttachmentsService(db, storage, members);
}

describe("ChatAttachmentsService.getSignedUrl", () => {
  describe("membership denial", () => {
    it("DENY: non-member of a PRIVATE channel gets 404, storage is never called", async () => {
      const storage = makeStorage();
      const service = makeService(
        makeDb([VALID_ROW]),
        makeMembers({ error: new NotFoundException("Channel not found") }),
        storage,
      );

      await expect(service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(storage.getFileUrl).not.toHaveBeenCalled();
    });

    it("CONTROL: member of the same private channel gets a signed URL", async () => {
      const storage = makeStorage();
      const service = makeService(makeDb([VALID_ROW]), makeMembers(), storage);

      const result = await service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG);
      expect(result).toEqual({ url: SIGNED_URL });
    });

    it("DENY: non-member of a PUBLIC channel gets 403, storage is never called", async () => {
      const storage = makeStorage();
      const service = makeService(
        makeDb([VALID_ROW]),
        makeMembers({ error: new ForbiddenException("You are not a member of this channel") }),
        storage,
      );

      await expect(service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(storage.getFileUrl).not.toHaveBeenCalled();
    });

    it("CONTROL: member of the same public channel gets a signed URL", async () => {
      const storage = makeStorage();
      const service = makeService(makeDb([VALID_ROW]), makeMembers(), storage);

      const result = await service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG);
      expect(result.url).toBe(SIGNED_URL);
      expect(storage.getFileUrl).toHaveBeenCalledWith(ORG, FILE_KEY, 3600);
    });
  });

  describe("cross-organization isolation", () => {
    it("DENY: attachment row absent for another org returns 404, storage not called", async () => {
      const storage = makeStorage();
      const service = makeService(
        makeDb([]),
        makeMembers(),
        storage,
      );

      await expect(
        service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, OTHER_ORG),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.getFileUrl).not.toHaveBeenCalled();
    });

    it("CONTROL: the same attachment id for the correct org succeeds", async () => {
      const storage = makeStorage();
      const service = makeService(makeDb([VALID_ROW]), makeMembers(), storage);

      const result = await service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG);
      expect(result.url).toBe(SIGNED_URL);
    });
  });

  describe("signed URL parameters", () => {
    it("passes orgId and fileKey to StorageService and returns the url", async () => {
      const storage = makeStorage();
      const service = makeService(makeDb([VALID_ROW]), makeMembers(), storage);

      await service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG);

      expect(storage.getFileUrl).toHaveBeenCalledWith(ORG, FILE_KEY, 3600);
    });
  });

  describe("tenant key scoping", () => {
    it("(a) signed URL uses the caller orgId as the storage tenant, not a guess from the key", async () => {
      const storage = makeStorage();
      const service = makeService(makeDb([VALID_ROW]), makeMembers(), storage);

      await service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG);

      const [calledOrgId] = (storage.getFileUrl as jest.Mock).mock.calls[0] as [string, string, number];
      expect(calledOrgId).toBe(ORG);
    });

    it("(b) DENY: a cross-tenant query (no row found) means storage is never reached", async () => {
      const storage = makeStorage();
      const service = makeService(makeDb([]), makeMembers(), storage);

      await expect(
        service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, OTHER_ORG),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.getFileUrl).not.toHaveBeenCalled();
    });

    it("CONTROL: the correct org gets the signed URL", async () => {
      const storage = makeStorage();
      const service = makeService(makeDb([VALID_ROW]), makeMembers(), storage);

      const result = await service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG);
      expect(result.url).toBe(SIGNED_URL);
      expect(storage.getFileUrl).toHaveBeenCalledTimes(1);
    });
  });
});

describe("download — short-lived URL lifetime", () => {
  it("signed URL TTL is exactly 3600 seconds so possession outlives no more than one hour", async () => {
    const storage = makeStorage();
    const service = makeService(makeDb([VALID_ROW]), makeMembers(), storage);

    await service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG);

    const call = (storage.getFileUrl as jest.Mock).mock.calls[0] as [string, string, number];
    expect(call[2]).toBe(3600);
  });

  it("DENY: a user whose channel membership was revoked cannot obtain a signed URL", async () => {
    const storage = makeStorage();
    const revokedError = new ForbiddenException("Membership revoked");
    const service = makeService(
      makeDb([VALID_ROW]),
      makeMembers({ error: revokedError }),
      storage,
    );

    await expect(
      service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.getFileUrl).not.toHaveBeenCalled();
  });
});

describe("upload lifecycle — magic-byte MIME validation", () => {
  it("accepts a JPEG buffer with the correct magic bytes", () => {
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(20).fill(0)]);
    expect(validateMagicBytes(jpegBuffer, "image/jpeg")).toBe(true);
  });

  it("DENY: rejects a buffer with PNG magic bytes but JPEG declared type", () => {
    const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const pngBuffer = Buffer.from([...pngMagic, ...Array(20).fill(0)]);
    expect(validateMagicBytes(pngBuffer, "image/jpeg")).toBe(false);
  });

  it("DENY: rejects an HTML file masquerading as a PDF", () => {
    const htmlBuffer = Buffer.from("<html>malicious</html>", "utf8");
    expect(validateMagicBytes(htmlBuffer, "application/pdf")).toBe(false);
  });

  it("CONTROL: a valid PDF buffer passes magic-byte check", () => {
    const pdfMagic = [0x25, 0x50, 0x44, 0x46];
    const pdfBuffer = Buffer.from([...pdfMagic, ...Array(20).fill(0)]);
    expect(validateMagicBytes(pdfBuffer, "application/pdf")).toBe(true);
  });
});

describe("multipart upload — idempotent completion", () => {
  function makeStorageForMultipart() {
    const sendFn = jest.fn().mockResolvedValue({});
    const mockClient = { send: sendFn };
    const mockStorageService = {
      placementForOrg: jest.fn().mockResolvedValue({
        bucketName: "test-bucket",
        client: mockClient,
      }),
    } as unknown as StorageService;
    return { mockStorageService, sendFn };
  }

  it("calling complete twice with the same key and uploadId is idempotent — both calls succeed", async () => {
    const { mockStorageService, sendFn } = makeStorageForMultipart();
    const multipart = new StorageMultipartService(mockStorageService);
    const parts = [{ partNumber: 1, eTag: '"abc123"' }];

    await multipart.complete(ORG, FILE_KEY, "upload-id-1", parts);
    await multipart.complete(ORG, FILE_KEY, "upload-id-1", parts);

    expect(sendFn).toHaveBeenCalledTimes(2);
  });
});
