import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { ChatAttachmentsService } from "../chat-attachments.service";

const dialect = new PgDialect();

const ORG = "org-aaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";
const OTHER_ORG = "org-zzzz-yyyy-4xxx-wwww-vvvvvvvvvvvv";
const CHANNEL_ID = 7;
const ATTACHMENT_ID = 99;
const USER_ID = "user-1";
const FILE_KEY = `${ORG}/chat/2f1c9d0e-note.pdf`;

function buildChain(rows: Array<{ fileKey: string }>) {
  let captured: SQL | undefined;
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (w: SQL) => {
      captured = w;
      return chain;
    },
    limit: () => Promise.resolve(rows),
  };
  return {
    db: { select: () => chain } as unknown as Db,
    getWhere: () => {
      if (!captured) throw new Error("where() was not called on the builder chain");
      return captured;
    },
  };
}

interface MakeServiceOpts {
  membershipError?: Error;
  storageError?: Error;
  storageUrl?: string;
}

function makeService(rows: Array<{ fileKey: string }>, opts: MakeServiceOpts = {}) {
  const { db, getWhere } = buildChain(rows);

  const members = {
    assertChannelMembership: jest.fn().mockImplementation(
      (): Promise<void> =>
        opts.membershipError ? Promise.reject(opts.membershipError) : Promise.resolve(),
    ),
  };

  const storage = {
    getFileUrl: jest.fn().mockImplementation(
      (): Promise<string> =>
        opts.storageError
          ? Promise.reject(opts.storageError)
          : Promise.resolve(opts.storageUrl ?? "https://signed.example.com/file"),
    ),
  };

  return {
    service: new ChatAttachmentsService(db, storage as never, members as never),
    getWhere,
    members,
    storage,
  };
}

describe("ChatAttachmentsService.getSignedUrl — WHERE predicate structure", () => {
  it("binds chatMessages.isDeleted = false so a soft-deleted message's attachment is excluded", async () => {
    const { service, getWhere } = makeService([{ fileKey: FILE_KEY }]);
    await service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER_ID, ORG);

    const { sql, params } = dialect.sqlToQuery(getWhere());

    expect(sql).toMatch(/"chat_messages"\."is_deleted"\s*=\s*\$/i);
    expect(params).toContain(false);
  });

  it("binds chatAttachments.orgId to the caller's org so a cross-tenant attachment id returns nothing", async () => {
    const { service, getWhere } = makeService([{ fileKey: FILE_KEY }]);
    await service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER_ID, ORG);

    const { sql, params } = dialect.sqlToQuery(getWhere());

    expect(sql).toMatch(/"chat_attachments"\."org_id"\s*=\s*\$/i);
    expect(params).toContain(ORG);
    expect(params).not.toContain(OTHER_ORG);
  });

  it("binds chatMessages.channelId so a member of another channel cannot read this attachment via its id", async () => {
    const { service, getWhere } = makeService([{ fileKey: FILE_KEY }]);
    await service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER_ID, ORG);

    const { sql, params } = dialect.sqlToQuery(getWhere());

    expect(sql).toMatch(/"chat_messages"\."channel_id"\s*=\s*\$/i);
    expect(params).toContain(CHANNEL_ID);
  });

  it("binds chatMessages.orgId independently of chatAttachments.orgId for defence in depth", async () => {
    const { service, getWhere } = makeService([{ fileKey: FILE_KEY }]);
    await service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER_ID, ORG);

    const { sql, params } = dialect.sqlToQuery(getWhere());

    expect(sql).toMatch(/"chat_messages"\."org_id"\s*=\s*\$/i);
    const orgOccurrences = params.filter((p) => p === ORG);
    expect(orgOccurrences.length).toBeGreaterThanOrEqual(2);
  });
});

describe("ChatAttachmentsService.getSignedUrl — access gates", () => {
  it("DENY — membership gate: the specific NotFoundException from assertChannelMembership propagates before the DB is queried", async () => {
    const membershipError = new NotFoundException("membership-gate-sentinel");
    const { service, storage } = makeService([], { membershipError });

    const thrown = await service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER_ID, ORG).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).message).toBe("membership-gate-sentinel");
    expect(storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("DENY — no row: NotFoundException when the attachment does not belong to this org and channel", async () => {
    const { service } = makeService([]);

    await expect(
      service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER_ID, ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("routes the file key and the 3600s TTL to StorageService.getFileUrl so the quarantine gate inside it runs on the correct key", async () => {
    const { service, storage } = makeService([{ fileKey: FILE_KEY }]);

    await service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER_ID, ORG);

    expect(storage.getFileUrl).toHaveBeenCalledWith(ORG, FILE_KEY, 3600);
  });

  it("DENY — quarantine block: NotFoundException from StorageService.getFileUrl propagates to the caller", async () => {
    const { service } = makeService([{ fileKey: FILE_KEY }], {
      storageError: new NotFoundException("File not found"),
    });

    await expect(
      service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER_ID, ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("ALLOW — a member with a clean key receives the signed URL object", async () => {
    const { service } = makeService([{ fileKey: FILE_KEY }]);

    const result = await service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER_ID, ORG);

    expect(result).toEqual({ url: "https://signed.example.com/file" });
  });
});
