jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(
    async (
      _db: unknown,
      _sweep: string,
      fn: (tx: unknown, orgId: string) => Promise<void>,
    ) => {
      await fn({}, "org-1");
      return { organizations: 1 };
    },
  ),
}));

import { S3Client } from "@aws-sdk/client-s3";
import { clearRegionRegistry } from "../../common/region/region-registry";
import type { MediaCompressionService } from "../../common/media/media-compression.service";
import { StorageService, type StorageConfig } from "../storage/storage.service";
import { KbMediaService } from "../kb/wiki/kb-media.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { CronStorageSweepService } from "./cron-storage-sweep.service";

/*
 * The sweep drains `storage_pending_purge` and then calls markConfirmed, which
 * DELETES the write-ahead row. An S3-compatible delete of a key that is absent
 * answers SUCCESS, so before the bucket travelled with the row a `kb:page:purge`
 * row was confirmed on the strength of a delete that addressed the DEFAULT bucket
 * while the object sat untouched in the KB one — and the row that was the last
 * pointer to it was gone. That is the step that turns a recoverable orphan into an
 * unrecoverable one, so it is the step proved here.
 *
 * Nothing below reasons about S3 semantics. The KB object is uploaded by the real
 * KbMediaService, every command is captured off S3Client.prototype.send, and the
 * sweep's DELETE is compared against the Bucket that upload actually used.
 */

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

function captureS3(): Sent[] {
  const sent: Sent[] = [];
  jest.spyOn(S3Client.prototype, "send").mockImplementation(async (cmd: unknown) => {
    const command = (cmd as { constructor: { name: string } }).constructor.name;
    const input = (cmd as { input: Record<string, unknown> }).input;
    sent.push({
      command,
      bucket: String(input["Bucket"] ?? ""),
      key: String(input["Key"] ?? ""),
    });
    return {};
  });
  return sent;
}

function only(sent: Sent[], command: string): Sent {
  const match = sent.filter((s) => s.command === command);
  expect(match).toHaveLength(1);
  return match[0] as Sent;
}

const USER = { orgId: ORG, userId: "user-1" } as unknown as CurrentUserContext;

async function uploadKbMedia(store: StorageService): Promise<void> {
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

function build(rows: Array<{ id: string; storageKey: string; purpose: string; bucket: string | null }>) {
  const store = new StorageService({} as MediaCompressionService, config, { isKeyBlocked: async () => false });
  const pendingPurge = {
    listForRetry: jest.fn().mockResolvedValue(rows),
    markConfirmed: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new CronStorageSweepService(
    {} as never,
    { sweepAbandonedUploadsForOrgs: jest.fn().mockResolvedValue(0) } as never,
    { listForSweep: jest.fn().mockResolvedValue([]), softDelete: jest.fn() } as never,
    store,
    pendingPurge as never,
    config as never,
  );
  return { svc, store, pendingPurge };
}

beforeEach(() => {
  clearRegionRegistry();
  jest.restoreAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
  clearRegionRegistry();
});

describe("CronStorageSweepService — a row is confirmed only against the bucket its object is in", () => {
  it("deletes a kb:page:purge row from the KB bucket KbMediaService uploaded into, then confirms it", async () => {
    const sent = captureS3();
    const rows: Array<{ id: string; storageKey: string; purpose: string; bucket: string | null }> = [];
    const { svc, store, pendingPurge } = build(rows);

    await uploadKbMedia(store);
    const put = only(sent, "PutObjectCommand");
    rows.push({ id: "pp-kb", storageKey: put.key, purpose: "kb:page:purge", bucket: null });

    const result = await svc.sweep();

    const del = only(sent, "DeleteObjectCommand");
    expect(put.bucket).toBe(KB_BUCKET);
    expect(del.bucket).toBe(put.bucket);
    expect(del.bucket).not.toBe(DEFAULT_BUCKET);
    expect(del.key).toBe(put.key);
    expect(pendingPurge.markConfirmed).toHaveBeenCalledWith(ORG, "pp-kb");
    expect(result.pendingPurgeConfirmed).toBe(1);
    expect(result.pendingPurgeSkipped).toBe(0);
  });

  it("deletes an org-purge row from the default bucket its object was written to", async () => {
    const sent = captureS3();
    const rows: Array<{ id: string; storageKey: string; purpose: string; bucket: string | null }> = [];
    const { svc, store, pendingPurge } = build(rows);

    const uploaded = await store.uploadFile(
      ORG,
      Buffer.from("x"),
      "uploads",
      "invoice.pdf",
      "application/pdf",
    );
    const put = only(sent, "PutObjectCommand");
    rows.push({ id: "pp-org", storageKey: uploaded.key, purpose: "org-purge", bucket: "default" });

    await svc.sweep();

    const del = only(sent, "DeleteObjectCommand");
    expect(put.bucket).toBe(DEFAULT_BUCKET);
    expect(del.bucket).toBe(put.bucket);
    expect(del.key).toBe(uploaded.key);
    expect(pendingPurge.markConfirmed).toHaveBeenCalledWith(ORG, "pp-org");
  });

  it("bites: a purpose with no known bucket issues no delete and confirms nothing", async () => {
    const sent = captureS3();
    const { svc, pendingPurge } = build([
      { id: "pp-unknown", storageKey: "org-1/vault/secret.bin", purpose: "vault:archive", bucket: null },
    ]);

    const result = await svc.sweep();

    expect(sent.filter((s) => s.command === "DeleteObjectCommand")).toHaveLength(0);
    expect(pendingPurge.markConfirmed).not.toHaveBeenCalled();
    expect(pendingPurge.markFailed).not.toHaveBeenCalled();
    expect(result.pendingPurgeSkipped).toBe(1);
    expect(result.pendingPurgeConfirmed).toBe(0);
    expect(result.pendingPurgeFailed).toBe(0);
  });

  it("leaves the row retryable rather than spending an attempt on an unresolvable purpose", async () => {
    const { svc, pendingPurge } = build([
      { id: "pp-unknown", storageKey: "org-1/vault/secret.bin", purpose: "vault:archive", bucket: null },
    ]);
    captureS3();

    await svc.sweep();
    await svc.sweep();

    expect(pendingPurge.listForRetry).toHaveBeenCalledTimes(2);
    expect(pendingPurge.markFailed).not.toHaveBeenCalled();
    expect(pendingPurge.markConfirmed).not.toHaveBeenCalled();
  });
  /*
   * The organization purge writes one purpose, "org-purge", over keys drawn from
   * every file-key column in the schema — three of which name KB-bucket objects.
   * So the purpose cannot resolve the bucket for any of them, and a row of that
   * purpose predating the `bucket` column has nothing left to ask: the row
   * outlives the table its key came from. It is left untouched. Resolving it to
   * "default" would delete nothing, answer SUCCESS, and confirm away the last
   * pointer to a surviving KB object.
   */
  it("bites: an org-purge row with no recorded bucket is unresolvable, not 'default'", async () => {
    const sent = captureS3();
    const { svc, pendingPurge } = build([
      { id: "pp-legacy", storageKey: "org-1/kb-media/legacy.png", purpose: "org-purge", bucket: null },
    ]);

    const result = await svc.sweep();

    expect(sent.filter((s) => s.command === "DeleteObjectCommand")).toHaveLength(0);
    expect(pendingPurge.markConfirmed).not.toHaveBeenCalled();
    expect(pendingPurge.markFailed).not.toHaveBeenCalled();
    expect(result.pendingPurgeSkipped).toBe(1);
  });

  it("deletes an org-purge row recorded as kb from the KB bucket, not the default one", async () => {
    const sent = captureS3();
    const { svc, store, pendingPurge } = build([]);
    const uploaded = await store.uploadFile(
      ORG, Buffer.from("kb bytes"), "kb-media", "d.txt", "text/plain", KB_BUCKET,
    );
    (pendingPurge.listForRetry as jest.Mock).mockResolvedValue([
      { id: "pp-org-kb", storageKey: uploaded.key, purpose: "org-purge", bucket: "kb" },
    ]);

    await svc.sweep();

    const put = only(sent, "PutObjectCommand");
    const del = only(sent, "DeleteObjectCommand");
    expect(put.bucket).toBe(KB_BUCKET);
    expect(del.bucket).toBe(put.bucket);
    expect(del.key).toBe(uploaded.key);
    expect(pendingPurge.markConfirmed).toHaveBeenCalledWith(ORG, "pp-org-kb");
  });
});
