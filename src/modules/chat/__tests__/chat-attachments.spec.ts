import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ChatAttachmentsService } from "../chat-attachments.service";
import type { StorageService } from "../../storage/storage.service";
import type { ChatChannelMembersService } from "../chat-channel-members.service";

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
