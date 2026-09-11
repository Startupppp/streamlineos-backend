import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { ChatAttachmentsService } from "../chat-attachments.service";
import { ChatChannelMembersService } from "../chat-channel-members.service";
import type { StorageService } from "../../storage/storage.service";
import { validateMagicBytes } from "../../storage/file-signatures";
import { StorageMultipartService } from "../../storage/storage-multipart.service";

const dialect = new PgDialect();

const ORG = "org-a";
const OTHER_ORG = "org-b";
const USER = "user-a";
const CHANNEL_ID = 1;
const OTHER_CHANNEL_ID = 2;
const ATTACHMENT_ID = 10;
const MEMBERSHIP_ID = 77;
const FILE_KEY = `${ORG}/chat/2f1c9d0e-4a7b-4c1e-9f3a-8b6d5e2c1a09-file.pdf`;
const SIGNED_URL = "https://r2.example.com/signed?X-Amz-Signature=abc";

const REQUIRED_BINDINGS = [
  "chat_attachments.id",
  "chat_attachments.org_id",
  "chat_messages.org_id",
  "chat_messages.channel_id",
  "chat_messages.is_deleted",
] as const;

type Row = Readonly<Record<string, unknown>>;

function liveAttachment(overrides: Row = {}): Row {
  return {
    "chat_attachments.id": ATTACHMENT_ID,
    "chat_attachments.org_id": ORG,
    "chat_messages.org_id": ORG,
    "chat_messages.channel_id": CHANNEL_ID,
    "chat_messages.is_deleted": false,
    ...overrides,
  };
}

function equalityBindings(where: SQL): Map<string, unknown> {
  const { sql: text, params } = dialect.sqlToQuery(where);
  const bindings = new Map<string, unknown>();
  const pattern = /"(\w+)"\."(\w+)"\s*=\s*\$(\d+)/gi;
  let match = pattern.exec(text);
  while (match !== null) {
    bindings.set(`${match[1]}.${match[2]}`, params[Number(match[3]) - 1]);
    match = pattern.exec(text);
  }
  return bindings;
}

interface SelectChain {
  from: () => SelectChain;
  innerJoin: () => SelectChain;
  where: (predicate: SQL) => SelectChain;
  limit: () => Promise<Array<{ fileKey: string }>>;
}

interface Harness {
  readonly service: ChatAttachmentsService;
  readonly storage: StorageService;
  readonly predicate: () => SQL;
  readonly queried: () => boolean;
}

function makeHarness(opts: {
  row?: Row;
  channel?: { id: number; isPrivate: boolean } | null;
  orgMembership?: { id: number } | null;
  channelMember?: { role: string } | null;
} = {}): Harness {
  const row = opts.row === undefined ? liveAttachment() : opts.row;
  let captured: SQL | undefined;

  const chain: SelectChain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (predicate: SQL) => {
      captured = predicate;
      return chain;
    },
    limit: () => {
      if (captured === undefined)
        throw new Error("the attachment read ran with no WHERE predicate");
      const bindings = equalityBindings(captured);
      if (bindings.size === 0)
        throw new Error(`the attachment read binds no column: ${dialect.sqlToQuery(captured).sql}`);
      for (const [column, value] of bindings)
        if (row[column] !== value) return Promise.resolve([]);
      return Promise.resolve([{ fileKey: FILE_KEY }]);
    },
  };

  const selectFn = jest.fn(() => chain);
  const db = {
    select: selectFn,
    query: {
      chatChannels: {
        findFirst: jest.fn().mockResolvedValue(
          opts.channel === undefined ? { id: CHANNEL_ID, isPrivate: true } : opts.channel,
        ),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(
          opts.orgMembership === undefined ? { id: MEMBERSHIP_ID } : opts.orgMembership,
        ),
      },
      chatChannelMembers: {
        findFirst: jest.fn().mockResolvedValue(
          opts.channelMember === undefined ? { role: "MEMBER" } : opts.channelMember,
        ),
      },
    },
  } as unknown as Db;

  const unusedCollaborator = (name: string) =>
    new Proxy(
      {},
      {
        get() {
          throw new Error(`${name} must not be reached while signing an attachment`);
        },
      },
    );

  const members = new ChatChannelMembersService(
    db,
    unusedCollaborator("CacheService") as never,
    unusedCollaborator("EntityReferenceService") as never,
    unusedCollaborator("AblyService") as never,
  );

  const storage = {
    getFileUrl: jest.fn().mockResolvedValue(SIGNED_URL),
  } as unknown as StorageService;

  return {
    service: new ChatAttachmentsService(db, storage, members),
    storage,
    predicate: () => {
      if (captured === undefined) throw new Error("no predicate was compiled");
      return captured;
    },
    queried: () => selectFn.mock.calls.length > 0,
  };
}

describe("ChatAttachmentsService.getSignedUrl — the predicate is the authorization", () => {
  it("CONTROL: a current member of the channel gets a 1-hour signed URL", async () => {
    const harness = makeHarness();

    const result = await harness.service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG);

    expect(result).toEqual({ url: SIGNED_URL });
    expect(harness.storage.getFileUrl).toHaveBeenCalledWith(ORG, FILE_KEY, 3600);
  });

  it("CONTROL: the compiled WHERE constrains every column the denials depend on", async () => {
    const harness = makeHarness();

    await harness.service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG);

    const bindings = equalityBindings(harness.predicate());
    for (const column of REQUIRED_BINDINGS) expect(bindings.has(column)).toBe(true);
    expect(bindings.get("chat_attachments.id")).toBe(ATTACHMENT_ID);
    expect(bindings.get("chat_attachments.org_id")).toBe(ORG);
    expect(bindings.get("chat_messages.org_id")).toBe(ORG);
    expect(bindings.get("chat_messages.channel_id")).toBe(CHANNEL_ID);
    expect(bindings.get("chat_messages.is_deleted")).toBe(false);
  });
});

describe("cross-organization isolation — org_id is bound, not merely present", () => {
  it("DENY: a caller in another org binds its own org and the row does not match", async () => {
    const harness = makeHarness();

    await expect(
      harness.service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, OTHER_ORG),
    ).rejects.toBeInstanceOf(NotFoundException);

    const bindings = equalityBindings(harness.predicate());
    expect(bindings.get("chat_attachments.org_id")).toBe(OTHER_ORG);
    expect(bindings.get("chat_messages.org_id")).toBe(OTHER_ORG);
    expect(harness.storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("DENY: an attachment posted in a different channel of the same org is not reachable", async () => {
    const harness = makeHarness();

    await expect(
      harness.service.getSignedUrl(OTHER_CHANNEL_ID, ATTACHMENT_ID, USER, ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("DENY: another attachment id in the same channel is not reachable", async () => {
    const harness = makeHarness();

    await expect(
      harness.service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID + 1, USER, ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.storage.getFileUrl).not.toHaveBeenCalled();
  });
});

describe("channel membership — denial comes from a missing row, not a stubbed throw", () => {
  it("DENY: a removed member of a PRIVATE channel gets 404 and the attachment is never read", async () => {
    const harness = makeHarness({
      channel: { id: CHANNEL_ID, isPrivate: true },
      channelMember: null,
    });

    await expect(
      harness.service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.queried()).toBe(false);
    expect(harness.storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("DENY: a removed member of a PUBLIC channel gets 403 and the attachment is never read", async () => {
    const harness = makeHarness({
      channel: { id: CHANNEL_ID, isPrivate: false },
      channelMember: null,
    });

    await expect(
      harness.service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.queried()).toBe(false);
    expect(harness.storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("DENY: a caller whose organization membership is gone gets 403 before any attachment read", async () => {
    const harness = makeHarness({ orgMembership: null });

    await expect(
      harness.service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.queried()).toBe(false);
  });

  it("DENY: a channel that does not exist in this org gets 404", async () => {
    const harness = makeHarness({ channel: null });

    await expect(
      harness.service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.queried()).toBe(false);
  });

  it("CONTROL: restoring the membership row restores the signed URL", async () => {
    const harness = makeHarness({
      channel: { id: CHANNEL_ID, isPrivate: true },
      channelMember: { role: "MEMBER" },
    });

    const result = await harness.service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG);

    expect(result.url).toBe(SIGNED_URL);
  });
});

describe("a deleted message's attachment is no longer signable", () => {
  it("DENY: once the message is soft-deleted the attachment 404s", async () => {
    const harness = makeHarness({
      row: liveAttachment({ "chat_messages.is_deleted": true }),
    });

    await expect(
      harness.service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.storage.getFileUrl).not.toHaveBeenCalled();
  });

  it("DENY: the predicate itself pins is_deleted to false", async () => {
    const harness = makeHarness({
      row: liveAttachment({ "chat_messages.is_deleted": true }),
    });

    await expect(
      harness.service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG),
    ).rejects.toBeInstanceOf(NotFoundException);

    const rendered = dialect.sqlToQuery(harness.predicate()).sql;
    expect(rendered).toMatch(/"chat_messages"\."is_deleted"\s*=\s*\$/i);
    expect(equalityBindings(harness.predicate()).get("chat_messages.is_deleted")).toBe(false);
  });

  it("CONTROL: the same attachment on a live message still signs, so the guard is not denying everything", async () => {
    const harness = makeHarness({ row: liveAttachment() });

    const result = await harness.service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG);

    expect(result.url).toBe(SIGNED_URL);
  });
});

describe("signed URL lifetime", () => {
  it("possession outlives no more than one hour", async () => {
    const harness = makeHarness();

    await harness.service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG);

    const call = (harness.storage.getFileUrl as jest.Mock).mock.calls[0] as [string, string, number];
    expect(call[2]).toBe(3600);
  });

  it("the storage tenant is the caller's org, not a guess parsed from the key", async () => {
    const harness = makeHarness();

    await harness.service.getSignedUrl(CHANNEL_ID, ATTACHMENT_ID, USER, ORG);

    const [calledOrgId] = (harness.storage.getFileUrl as jest.Mock).mock.calls[0] as [string, string, number];
    expect(calledOrgId).toBe(ORG);
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
