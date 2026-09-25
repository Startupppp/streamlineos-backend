import { Readable } from "stream";
import { S3Client } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import { clearRegionRegistry } from "../../common/region/region-registry";
import type { MediaCompressionService } from "../../common/media/media-compression.service";
import { StorageService, type StorageConfig } from "../storage/storage.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  ...jest.requireActual("../../common/tenant/run-in-tenant-transaction"),
  runInNewTenantTransaction: async (
    db: unknown,
    _orgId: string,
    fn: (tx: unknown) => Promise<unknown>,
  ) => fn(db),
}));

import { KbSourcesService } from "./wiki/kb-sources.service";
import { KbMediaService } from "./wiki/kb-media.service";
import { KbPageTrashService } from "./wiki/kb-page-trash.service";
import { attemptPageAttachmentPurge } from "./wiki/kb-page-attachment-purge";
import { KbSourceAdapter } from "./retrieval/kb-content-adapter";
import { KbAttachmentIndexingService } from "./retrieval/kb-attachment-indexing.service";

/*
 * Every KB object that travels through R2_KB_BUCKET_NAME is written with a bucket
 * override and, until this spec existed, read and deleted without one. That cannot
 * surface as an error: an S3-compatible DELETE of a key that is absent answers
 * SUCCESS, so the caller is told the object is gone while it survives in the KB
 * bucket with the row that named it already deleted.
 *
 * So nothing below reasons about S3 semantics. Every command is captured off
 * S3Client.prototype.send, and each assertion compares the Bucket the delete or the
 * read addressed against the Bucket the UPLOAD in the same test actually used. The
 * upload is performed by the real service that owns it, not by the test, so an
 * override that stops reaching either end fails here.
 */

const auth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
};

const DEFAULT_BUCKET = "default-files";
const KB_BUCKET = "kb-files";
const ORG = "org-1";

const config = {
  R2_REGION: "auto",
  R2_BUCKET_NAME: DEFAULT_BUCKET,
  R2_ACCESS_KEY_ID: "test-key",
  R2_SECRET_ACCESS_KEY: "test-secret",
  R2_ENDPOINT: "https://default.r2.example",
  NEXT_PUBLIC_R2_PUBLIC_URL: "https://files.example",
  R2_KB_BUCKET_NAME: KB_BUCKET,
} satisfies StorageConfig & { R2_KB_BUCKET_NAME: string };

interface Sent {
  command: string;
  bucket: string;
  key: string;
}

function captureS3(bodyFor: () => unknown = () => Readable.from(["hello"])): Sent[] {
  const sent: Sent[] = [];
  jest.spyOn(S3Client.prototype, "send").mockImplementation(async (cmd: unknown) => {
    const command = (cmd as { constructor: { name: string } }).constructor.name;
    const input = (cmd as { input: Record<string, unknown> }).input;
    sent.push({
      command,
      bucket: String(input["Bucket"] ?? ""),
      key: String(input["Key"] ?? ""),
    });
    return { Body: bodyFor(), ContentLength: 5, ContentType: "text/plain" };
  });
  return sent;
}

function attachmentRows<T>(rows: T[]): PromiseLike<T[]> & {
  orderBy: () => PromiseLike<T[]>;
  limit: (n: number) => PromiseLike<T[]>;
} {
  const chain = {
    orderBy: () => chain,
    limit: (n: number) => attachmentRows(rows.slice(0, n)),
    then: <R,>(resolve: (value: T[]) => R) => Promise.resolve(rows).then(resolve),
  };
  return chain as PromiseLike<T[]> & {
    orderBy: () => PromiseLike<T[]>;
    limit: (n: number) => PromiseLike<T[]>;
  };
}

function only(sent: Sent[], command: string): Sent {
  const match = sent.filter((s) => s.command === command);
  expect(match).toHaveLength(1);
  return match[0] as Sent;
}

function storage(): StorageService {
  return new StorageService({} as MediaCompressionService, config, { isKeyBlocked: async () => false });
}

function thenable<T>(rows: T, extra: Record<string, unknown> = {}) {
  return Object.assign(Promise.resolve(rows), extra);
}

const USER = { orgId: ORG, userId: "user-1" } as unknown as CurrentUserContext;

const textFile = {
  mimetype: "text/plain",
  buffer: Buffer.from("some indexable text"),
  originalname: "notes.txt",
  size: 19,
};

const indexing = () => ({
  indexSource: jest.fn().mockResolvedValue(1),
  removeSourceChunks: jest.fn().mockResolvedValue(undefined),
  indexPageDocument: jest.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  clearRegionRegistry();
  jest.restoreAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
  clearRegionRegistry();
});

describe("KB sources — the delete addresses the bucket the upload used", () => {
  function sourcesDb(removed: Record<string, unknown>[]) {
    // `createNote`/`createFile` write the row and its `kb.content.index` outbox event in one
    // transaction, so the stub has to invoke the callback — a bare jest.fn() would silently
    // void every assertion inside it (root CLAUDE.md §11).
    const inserter = { values: () => ({ returning: async () => [{ id: 1 }] }) };
    const tx = { insert: () => inserter };
    return {
      transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      insert: () => inserter,
      update: () => ({
        set: () => ({
          where: () => thenable(removed, { returning: async () => removed }),
        }),
      }),
    };
  }

  it("deletes a KB source from the KB bucket its upload wrote to, not the default one", async () => {
    const sent = captureS3();
    const store = storage();
    const removed: Record<string, unknown>[] = [];
    const svc = new KbSourcesService(
      sourcesDb(removed) as never,
      store,
      indexing() as never,
      config as never,
      {} as never,
      auth as never,
    );

    await svc.createFile(USER, textFile as never);
    const put = only(sent, "PutObjectCommand");
    removed.push({ kind: "file", fileKey: put.key });

    await svc.remove(ORG, 1);

    const del = only(sent, "DeleteObjectCommand");
    expect(put.bucket).toBe(KB_BUCKET);
    expect(del.bucket).toBe(put.bucket);
    expect(del.bucket).not.toBe(DEFAULT_BUCKET);
    expect(del.key).toBe(put.key);
  });

  it("reads a KB source back from the bucket its upload wrote to", async () => {
    const sent = captureS3();
    const store = storage();
    const svc = new KbSourcesService(
      sourcesDb([]) as never,
      store,
      indexing() as never,
      config as never,
      {} as never,
      auth as never,
    );

    await svc.createFile(USER, textFile as never);
    const put = only(sent, "PutObjectCommand");

    const adapterDb = {
      query: {
        kbSources: {
          findFirst: async () => ({
            id: 1,
            kind: "file",
            noteText: null,
            fileKey: put.key,
            mimeType: "text/plain",
            status: "ready",
            deletedAt: null,
          }),
        },
      },
      // The adapter now settles the source's terminal status, so it writes as well as reads.
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    const adapter = new KbSourceAdapter(
      adapterDb as never,
      indexing() as never,
      store,
      config as never,
    );

    await adapter.handle(ORG, 1);

    const get = only(sent, "GetObjectCommand");
    expect(put.bucket).toBe(KB_BUCKET);
    expect(get.bucket).toBe(put.bucket);
    expect(get.bucket).not.toBe(DEFAULT_BUCKET);
    expect(get.key).toBe(put.key);
  });
});

describe("KB page attachments — the cascade purge addresses the bucket the upload used", () => {
  const audit = () => ({ log: jest.fn() });
  const avScanner = () => ({ scan: jest.fn().mockResolvedValue({ status: "clean" }) });

  async function uploadMedia(store: StorageService, db: unknown): Promise<void> {
    const media = new KbMediaService(
      db as never,
      store,
      audit() as never,
      indexing() as never,
      config as never,
      avScanner() as never,
    );
    await media.upload(textFile as never, USER);
  }

  it("purges the object from the KB bucket KbMediaService uploaded it into", async () => {
    const sent = captureS3();
    const store = storage();
    const uploadTx = { execute: jest.fn().mockResolvedValue([]) };
    const db = {
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      transaction: async (fn: (t: typeof uploadTx) => Promise<unknown>) => fn(uploadTx),
    };

    await uploadMedia(store, db);
    const put = only(sent, "PutObjectCommand");

    const result = await attemptPageAttachmentPurge(
      db as never,
      store,
      ORG,
      [put.key],
      config.R2_KB_BUCKET_NAME,
    );

    const del = only(sent, "DeleteObjectCommand");
    expect(result).toEqual({ confirmed: 1, failed: 0 });
    expect(put.bucket).toBe(KB_BUCKET);
    expect(del.bucket).toBe(put.bucket);
    expect(del.bucket).not.toBe(DEFAULT_BUCKET);
    expect(del.key).toBe(put.key);
  });

  it("KbPageTrashService.hardDelete carries R2_KB_BUCKET_NAME the whole way to the DELETE", async () => {
    const sent = captureS3();
    const store = storage();

    const uploadTx = { execute: jest.fn().mockResolvedValue([]) };
    const uploadDb = {
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      transaction: async (fn: (t: typeof uploadTx) => Promise<unknown>) => fn(uploadTx),
    };
    await uploadMedia(store, uploadDb);
    const put = only(sent, "PutObjectCommand");

    const tx = {
      execute: jest.fn().mockResolvedValue([{ id: 10 }]),
      delete: jest.fn(() => ({ where: async () => [] })),
    };
    const treeDb = {
      query: {
        kbPages: { findFirst: async () => ({ id: 10, title: "P" }) },
        kbPagePurgeLedger: { findFirst: async () => undefined },
      },
      transaction: async (fn: (t: unknown) => unknown) => fn(tx),
      select: () => ({ from: () => ({ where: () => attachmentRows([{ fileKey: put.key }]) }) }),
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async () => undefined,
          onConflictDoNothing: async () => undefined,
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      delete: () => ({ where: async () => [] }),
    };

    const tree = new KbPageTrashService(
      treeDb as never,
      audit() as never,
      store,
      config as never,
      auth as never,
      { restore: jest.fn().mockResolvedValue({ id: 10 }) } as never,
    );

    await tree.hardDelete(USER, 10);

    const del = only(sent, "DeleteObjectCommand");
    expect(del.bucket).toBe(put.bucket);
    expect(del.bucket).toBe(KB_BUCKET);
    expect(del.key).toBe(put.key);
  });
});

/*
 * The control, and the reason it is here rather than a fourth fix: kb_page_attachments
 * rows carry a fileKey the client obtained from POST /storage/upload, which writes with NO
 * override. The read is therefore already symmetric with its upload, and threading the KB
 * bucket into it would 404 the read wherever the two buckets differ. This test fails if
 * someone "completes" the change by adding an override here.
 */
describe("KB article attachments — the read stays on the bucket /storage/upload wrote to", () => {
  it("reads an article attachment from the default bucket, matching its upload", async () => {
    const sent = captureS3(() => Readable.from(["   "]));
    const store = storage();

    const uploaded = await store.uploadFile(
      ORG,
      Buffer.from("   "),
      "uploads",
      "handbook.txt",
      "text/plain",
    );
    const put = only(sent, "PutObjectCommand");

    // `indexAttachment` resolves the attachment and its page's acl_revision in one
    // joined select, so the stub answers that chain rather than a relational findFirst.
    const attachmentRow = {
      pageId: 3,
      fileKey: uploaded.key,
      mimeType: "text/plain",
      fileName: "handbook.txt",
      deletedAt: null,
      pageAclRevision: 4,
      pageDeletedAt: null,
    };
    const db = {
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: () => ({ limit: async () => [attachmentRow] }),
          }),
        }),
      }),
      delete: () => ({ where: async () => undefined }),
    };
    const svc = new KbAttachmentIndexingService(
      db as never,
      { isEmbeddingConfigured: () => true } as never,
      store,
      {
        loadCheckpoints: async () => new Map<number, number[]>(),
        saveCheckpoints: async () => undefined,
      } as never,
    );

    await svc.indexAttachment(ORG, 7);

    const get = only(sent, "GetObjectCommand");
    expect(put.bucket).toBe(DEFAULT_BUCKET);
    expect(get.bucket).toBe(put.bucket);
    expect(get.bucket).not.toBe(KB_BUCKET);
    expect(get.key).toBe(uploaded.key);
  });
});
