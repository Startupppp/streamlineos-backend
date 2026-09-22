jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
  runInTenantTransaction: (_db: unknown, fn: () => Promise<unknown>) => fn(),
}));

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { S3Client } from "@aws-sdk/client-s3";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { clearRegionRegistry } from "../../../../common/region/region-registry";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import type { MediaCompressionService } from "../../../../common/media/media-compression.service";
import { StorageService, type StorageConfig } from "../../../storage/storage.service";
import { bucketRoleForColumn } from "../../../storage/storage-key-catalog";
import { KbMediaService } from "../../../kb/wiki/kb-media.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { PURGE_ADAPTER_REGISTRY } from "./organization-purge-adapters";

/*
 * The organization purge deletes an object and then asks whether it is gone. Both
 * questions are addressed at a bucket, and until the bucket travelled with the key
 * both were addressed at the DEFAULT one for every key — including the three
 * columns whose objects were uploaded into the KB bucket. An S3-compatible delete
 * of an absent key answers SUCCESS and a HEAD of an absent key answers 404, so the
 * pair reported "deleted and verified absent" about an object it had never
 * touched. The verification is what made it convincing.
 *
 * Nothing below reasons about S3 semantics, because reasoning about them is what
 * hid this. A tiny object store is modelled off S3Client.prototype.send — PUT
 * stores, DELETE removes, HEAD 404s when absent — the KB object is written by the
 * REAL KbMediaService, and the assertion is that after the purge the bucket that
 * upload actually addressed no longer holds the key.
 */

const DEFAULT_BUCKET = "default-files";
const KB_BUCKET = "kb-files";
const ORG = "org-1";
const PURGE_JOB = "purge-job-1";

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

interface FakeStore {
  sent: Sent[];
  holds(bucket: string, key: string): boolean;
}

function missing(): Error {
  const err = new Error("NotFound");
  err.name = "NotFound";
  return err;
}

/** PUT stores, DELETE removes, HEAD 404s when absent — the whole of the S3 contract this depends on. */
function fakeObjectStore(): FakeStore {
  const sent: Sent[] = [];
  const objects = new Map<string, Set<string>>();
  const bucketOf = (bucket: string): Set<string> => {
    const existing = objects.get(bucket);
    if (existing) return existing;
    const created = new Set<string>();
    objects.set(bucket, created);
    return created;
  };

  jest.spyOn(S3Client.prototype, "send").mockImplementation(async (cmd: unknown) => {
    const command = (cmd as { constructor: { name: string } }).constructor.name;
    const input = (cmd as { input: Record<string, unknown> }).input;
    const bucket = String(input["Bucket"] ?? "");
    const key = String(input["Key"] ?? "");
    sent.push({ command, bucket, key });
    if (command === "PutObjectCommand") bucketOf(bucket).add(key);
    else if (command === "DeleteObjectCommand") bucketOf(bucket).delete(key);
    else if (command === "HeadObjectCommand" && !bucketOf(bucket).has(key)) throw missing();
    return {};
  });

  return { sent, holds: (bucket, key) => bucketOf(bucket).has(key) };
}

const USER = { orgId: ORG, userId: "user-1" } as unknown as CurrentUserContext;

async function uploadKbAttachment(store: StorageService): Promise<void> {
  const db = {
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
  };
  const media = new KbMediaService(
    db as never,
    store,
    { log: jest.fn() } as never,
    { indexPageDocument: jest.fn().mockResolvedValue(undefined) } as never,
    config as never,
    { scan: jest.fn().mockResolvedValue({ status: "clean" }) } as never,
  );
  await media.upload(
    {
      mimetype: "text/plain",
      buffer: Buffer.from("attachment bytes"),
      originalname: "diagram.txt",
      size: 16,
    } as never,
    USER,
  );
}

const dialect = new PgDialect();

/**
 * Answers the catalog's two queries the way Postgres would, and — critically —
 * takes each key's bucket from the literal the catalog itself wrote into the
 * UNION branch rather than from anything this spec assumes. Drop the tagging and
 * the rows come back `default`, which is the defect.
 */
function catalogDb(keysByTable: Record<string, string[]>) {
  let unionCalls = 0;
  return {
    execute: jest.fn(async (query: unknown) => {
      const rendered = dialect.sqlToQuery(query as SQL).sql;
      if (rendered.includes("pg_attribute") && rendered.includes("attname"))
        return Object.keys(keysByTable).map((table) => ({ table, column: "file_key" }));

      unionCalls += 1;
      if (unionCalls > 1) return [];
      const rows: Array<Record<string, unknown>> = [];
      for (const branch of rendered.split(" UNION ALL ")) {
        const table = /FROM\s+(\S+)\s+WHERE/.exec(branch)?.[1] ?? "";
        const bucket = /'(default|kb)' AS bucket/.exec(branch)?.[1];
        for (const key of keysByTable[table] ?? []) rows.push({ k: key, bucket });
      }
      return rows;
    }),
    lastUnion: () => unionCalls,
  };
}

function captureBookkeeping(): { rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  const tx = {
    insert: () => ({
      values: (values: Array<Record<string, unknown>>) => {
        rows.push(...values);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  (runInNewTenantTransaction as jest.Mock).mockImplementation(
    (_db: unknown, _orgId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  );
  return { rows };
}

beforeEach(() => {
  clearRegionRegistry();
  jest.restoreAllMocks();
  (runInNewTenantTransaction as jest.Mock).mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
  clearRegionRegistry();
});

describe("storage-key-catalog — which columns name KB-bucket objects", () => {
  it.each([
    ["public.kb_sources", "file_key", "kb"],
    ["public.kb_sources", "file_url", "kb"],
    ["public.kb_page_attachments", "file_key", "kb"],
    ["public.kb_article_attachments", "file_key", "default"],
    ["public.documents", "file_key", "default"],
    ["public.hr_documents", "storage_url", "default"],
  ])("%s.%s resolves to the %s bucket", (table, column, role) => {
    expect(bucketRoleForColumn(table, column)).toBe(role);
  });

  /*
   * The list above is hand-maintained, so it can only stay true while the set of
   * services uploading with the KB bucket override stays the same. This is the
   * ratchet: a third one fails here rather than silently inheriting `default` and
   * surviving its own organisation's purge.
   */
  it("is pinned to the set of services that upload with R2_KB_BUCKET_NAME", () => {
    const root = join(__dirname, "../../../..", "modules");
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && !entry.name.includes(".spec.")) {
          const src = readFileSync(path, "utf8");
          if (src.includes("R2_KB_BUCKET_NAME") && /\.uploadFile(Stream)?\(/.test(src))
            found.push(entry.name);
        }
      }
    };
    walk(root);

    expect(found.sort()).toEqual(["kb-media.service.ts", "kb-sources.service.ts"]);
  });
});

describe("PURGE_ADAPTER_REGISTRY.object_storage — the delete and its verification address the upload's bucket", () => {
  it("removes a KB attachment from the bucket KbMediaService uploaded it into", async () => {
    const s3 = fakeObjectStore();
    const store = new StorageService({} as MediaCompressionService, config, { isKeyBlocked: async () => false });
    await uploadKbAttachment(store);

    const put = s3.sent.find((s) => s.command === "PutObjectCommand");
    expect(put).toBeDefined();
    expect(put?.bucket).toBe(KB_BUCKET);
    expect(s3.holds(KB_BUCKET, put?.key ?? "")).toBe(true);

    captureBookkeeping();
    const db = catalogDb({ "public.kb_page_attachments": [put?.key ?? ""] });

    const result = await PURGE_ADAPTER_REGISTRY.object_storage.confirm(
      ORG,
      PURGE_JOB,
      db as never,
      { port: store, kbBucket: config.R2_KB_BUCKET_NAME },
    );

    expect(result.state).toBe("CONFIRMED");
    // The object is gone from the bucket the upload actually used — not merely
    // reported gone from the one the delete happened to address.
    expect(s3.holds(KB_BUCKET, put?.key ?? "")).toBe(false);

    const del = s3.sent.filter((s) => s.command === "DeleteObjectCommand");
    expect(del).toHaveLength(1);
    expect(del[0]?.bucket).toBe(put?.bucket);

    const head = s3.sent.filter((s) => s.command === "HeadObjectCommand");
    expect(head).toHaveLength(1);
    expect(head[0]?.bucket).toBe(put?.bucket);
  });

  it("keeps a non-KB key on the default bucket (control — the fix is not 'send everything to KB')", async () => {
    const s3 = fakeObjectStore();
    const store = new StorageService({} as MediaCompressionService, config, { isKeyBlocked: async () => false });
    const key = await store.uploadFile(ORG, Buffer.from("x"), "documents", "contract.pdf", "application/pdf");

    expect(s3.sent[0]?.bucket).toBe(DEFAULT_BUCKET);

    captureBookkeeping();
    const db = catalogDb({ "public.documents": [key.key] });

    const result = await PURGE_ADAPTER_REGISTRY.object_storage.confirm(
      ORG,
      PURGE_JOB,
      db as never,
      { port: store, kbBucket: config.R2_KB_BUCKET_NAME },
    );

    expect(result.state).toBe("CONFIRMED");
    expect(s3.holds(DEFAULT_BUCKET, key.key)).toBe(false);
    const del = s3.sent.filter((s) => s.command === "DeleteObjectCommand");
    expect(del).toHaveLength(1);
    expect(del[0]?.bucket).toBe(DEFAULT_BUCKET);
  });

  it("records the bucket on the pending-purge row before the object is deleted", async () => {
    const s3 = fakeObjectStore();
    const store = new StorageService({} as MediaCompressionService, config, { isKeyBlocked: async () => false });
    await uploadKbAttachment(store);
    const put = s3.sent.find((s) => s.command === "PutObjectCommand");

    const defaultKey = await store.uploadFile(ORG, Buffer.from("y"), "documents", "c.pdf", "application/pdf");

    const bookkeeping = captureBookkeeping();
    const db = catalogDb({
      "public.kb_page_attachments": [put?.key ?? ""],
      "public.documents": [defaultKey.key],
    });

    await PURGE_ADAPTER_REGISTRY.object_storage.confirm(ORG, PURGE_JOB, db as never, {
      port: store,
      kbBucket: config.R2_KB_BUCKET_NAME,
    });

    const registered = new Map(
      bookkeeping.rows.map((row) => [String(row["storageKey"]), row["bucket"]]),
    );
    expect(registered.get(put?.key ?? "")).toBe("kb");
    expect(registered.get(defaultKey.key)).toBe("default");
  });

  it("does not report CONFIRMED when the KB object survives the delete", async () => {
    const s3 = fakeObjectStore();
    const store = new StorageService({} as MediaCompressionService, config, { isKeyBlocked: async () => false });
    await uploadKbAttachment(store);
    const put = s3.sent.find((s) => s.command === "PutObjectCommand");

    // A delete that silently does nothing is the failure mode this whole file is
    // about; with the verification aimed at the right bucket it is now visible.
    jest
      .spyOn(store, "deleteFile")
      .mockImplementation(async () => undefined);

    captureBookkeeping();
    const db = catalogDb({ "public.kb_page_attachments": [put?.key ?? ""] });

    const result = await PURGE_ADAPTER_REGISTRY.object_storage.confirm(
      ORG,
      PURGE_JOB,
      db as never,
      { port: store, kbBucket: config.R2_KB_BUCKET_NAME },
    );

    expect(result.state).toBe("FAILED");
    expect(result.detail).toMatch(/still present after delete/);
    expect(s3.holds(KB_BUCKET, put?.key ?? "")).toBe(true);
  });
});
