import { Readable } from "stream";
import { S3Client } from "@aws-sdk/client-s3";
import { clearRegionRegistry } from "../../common/region/region-registry";
import type { MediaCompressionService } from "../../common/media/media-compression.service";
import { StorageService, type StorageConfig } from "./storage.service";

/*
 * KB media is written into R2_KB_BUCKET_NAME through uploadFile's bucket override.
 * Until this spec existed the delete path took no override, so wherever that variable
 * is set and differs from R2_BUCKET_NAME every KB delete addressed the DEFAULT bucket.
 * S3 answers a delete of an absent key with success, so the caller was told the object
 * was gone while it stayed in the KB bucket forever — an orphan nothing could find.
 *
 * The assertions below never reason about S3 semantics. Every command is captured off
 * S3Client.prototype.send and the delete's Bucket is compared to the Bucket the upload
 * actually used, so an override that stops reaching the delete fails here.
 */

const DEFAULT_BUCKET = "default-files";
const KB_BUCKET = "kb-files";

const config: StorageConfig = {
  R2_REGION: "auto",
  R2_BUCKET_NAME: DEFAULT_BUCKET,
  R2_ACCESS_KEY_ID: "test-key",
  R2_SECRET_ACCESS_KEY: "test-secret",
  R2_ENDPOINT: "https://default.r2.example",
  NEXT_PUBLIC_R2_PUBLIC_URL: "https://files.example",
};

interface Sent {
  command: string;
  bucket: string;
  key: string;
}

function captureS3(bodyFor: () => unknown = () => undefined): {
  sent: Sent[];
  spy: jest.SpyInstance;
} {
  const sent: Sent[] = [];
  const spy = jest
    .spyOn(S3Client.prototype, "send")
    .mockImplementation(async (cmd: unknown) => {
      const command = (cmd as { constructor: { name: string } }).constructor.name;
      const input = (cmd as { input: Record<string, unknown> }).input;
      sent.push({
        command,
        bucket: String(input["Bucket"] ?? ""),
        key: String(input["Key"] ?? ""),
      });
      return {
        Body: bodyFor(),
        ContentLength: 3,
        ContentType: "image/webp",
      };
    });
  return { sent, spy };
}

function service(): StorageService {
  return new StorageService({} as MediaCompressionService, config, { isKeyBlocked: async () => false });
}

function bucketOf(sent: Sent[], command: string): string | undefined {
  return sent.find((s) => s.command === command)?.bucket;
}

beforeEach(() => {
  clearRegionRegistry();
  jest.restoreAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
  clearRegionRegistry();
});

describe("StorageService — bucket override symmetry between write and delete", () => {
  it("deletes from the bucket the upload used when a KB bucket override is supplied", async () => {
    const { sent } = captureS3();
    const svc = service();

    const uploaded = await svc.uploadFile(
      "org-a",
      Buffer.from("kb"),
      "kb-media/org-a",
      "diagram.webp",
      "image/webp",
      KB_BUCKET,
    );
    await svc.deleteFile("org-a", uploaded.key, KB_BUCKET);

    const put = bucketOf(sent, "PutObjectCommand");
    const del = bucketOf(sent, "DeleteObjectCommand");

    expect(put).toBe(KB_BUCKET);
    expect(del).toBe(put);
    expect(del).not.toBe(DEFAULT_BUCKET);
    expect(sent.find((s) => s.command === "DeleteObjectCommand")?.key).toBe(
      uploaded.key,
    );
  });

  it("still deletes from the default bucket when no override is supplied", async () => {
    const { sent } = captureS3();
    const svc = service();

    const uploaded = await svc.uploadFile(
      "org-a",
      Buffer.from("x"),
      "uploads",
      "plain.bin",
      "application/octet-stream",
    );
    await svc.deleteFile("org-a", uploaded.key);

    expect(bucketOf(sent, "PutObjectCommand")).toBe(DEFAULT_BUCKET);
    expect(bucketOf(sent, "DeleteObjectCommand")).toBe(DEFAULT_BUCKET);
  });

  it("deleteFileIfPresent forwards the override to the delete it issues", async () => {
    const { sent } = captureS3();

    await service().deleteFileIfPresent("org-a", "kb-media/org-a/x.webp", KB_BUCKET);

    expect(bucketOf(sent, "DeleteObjectCommand")).toBe(KB_BUCKET);
  });

  it("uploadFileStream and deleteFile agree on the bucket", async () => {
    const { sent } = captureS3();
    const svc = service();

    const uploaded = await svc.uploadFileStream(
      "org-a",
      Readable.from([Buffer.from("abc")]),
      3,
      "kb-sources/org-a",
      "manual.pdf",
      "application/pdf",
      KB_BUCKET,
    );
    await svc.deleteFile("org-a", uploaded.key, KB_BUCKET);

    expect(bucketOf(sent, "PutObjectCommand")).toBe(KB_BUCKET);
    expect(bucketOf(sent, "DeleteObjectCommand")).toBe(KB_BUCKET);
  });

  it("uploadToKey and deleteFile agree on the bucket", async () => {
    const { sent } = captureS3();
    const svc = service();

    await svc.uploadToKey("org-a", Buffer.from("z"), "kb/k", "image/webp", KB_BUCKET);
    await svc.deleteFile("org-a", "kb/k", KB_BUCKET);

    expect(bucketOf(sent, "PutObjectCommand")).toBe(KB_BUCKET);
    expect(bucketOf(sent, "DeleteObjectCommand")).toBe(KB_BUCKET);
  });
});

describe("StorageService — bucket override symmetry on every reader", () => {
  it("fileExists probes the overridden bucket, not the default one", async () => {
    const { sent } = captureS3();

    await service().fileExists("org-a", "kb-media/org-a/x.webp", KB_BUCKET);

    expect(bucketOf(sent, "HeadObjectCommand")).toBe(KB_BUCKET);
  });

  it("describeObject heads the overridden bucket", async () => {
    const { sent } = captureS3();

    await service().describeObject("org-a", "kb-media/org-a/x.webp", KB_BUCKET);

    expect(bucketOf(sent, "HeadObjectCommand")).toBe(KB_BUCKET);
  });

  it("getFileStream reads from the overridden bucket", async () => {
    const { sent } = captureS3(() => Readable.from([Buffer.from("abc")]));

    await service().getFileStream("org-a", "kb-sources/org-a/manual.pdf", KB_BUCKET);

    expect(bucketOf(sent, "GetObjectCommand")).toBe(KB_BUCKET);
  });

  it("readObjectPrefix ranges over the overridden bucket", async () => {
    const { sent } = captureS3(() => Readable.from([Buffer.from("abc")]));

    await service().readObjectPrefix("org-a", "kb-sources/org-a/manual.pdf", 3, KB_BUCKET);

    expect(bucketOf(sent, "GetObjectCommand")).toBe(KB_BUCKET);
  });

  it("getFileUrl signs against the overridden bucket", async () => {
    const url = await service().getFileUrl(
      "org-a",
      "kb-media/org-a/x.webp",
      60,
      KB_BUCKET,
    );

    expect(url).toContain(KB_BUCKET);
    expect(url).not.toContain(DEFAULT_BUCKET);
  });

  it("getFileUrl without an override still signs against the default bucket", async () => {
    const url = await service().getFileUrl("org-a", "uploads/x.bin", 60);

    expect(url).toContain(DEFAULT_BUCKET);
  });
});
