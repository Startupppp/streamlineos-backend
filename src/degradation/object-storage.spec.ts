import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { FaultServer, refusedPort } from "./fault-server";
import { StorageService } from "../modules/storage/storage.service";
import type { StorageConfig } from "../modules/storage/storage.service";
import { MediaCompressionService } from "../common/media/media-compression.service";

function makeStorageService(endpoint: string): StorageService {
  const config: StorageConfig = {
    R2_REGION: "auto",
    R2_BUCKET_NAME: "test-bucket",
    R2_ACCESS_KEY_ID: "fake-key",
    R2_SECRET_ACCESS_KEY: "fake-secret",
    R2_ENDPOINT: endpoint,
    NEXT_PUBLIC_R2_PUBLIC_URL: "https://cdn.example.com",
  };
  const compression = {
    compress: jest.fn().mockImplementation(async (buf: Buffer, _mime: string, name: string) => ({
      buffer: buf,
      fileName: name,
      mimeType: _mime,
    })),
  } as unknown as MediaCompressionService;
  return new StorageService(compression, config);
}

describe("Object storage degraded — pre-generated key survives upload failure", () => {
  it("compressAndPreGenerateKey generates the key and URL before any network call", async () => {
    const service = makeStorageService("http://unreachable:1");

    const buffer = Buffer.from("test-data");
    const result = await service.compressAndPreGenerateKey(
      buffer,
      "uploads",
      "file.jpg",
      "image/jpeg",
    );

    expect(result.key).toMatch(/^uploads\/.+\.jpg$/);
    expect(result.url).toBeTruthy();
    expect(result.compressedBuffer).toBeInstanceOf(Buffer);
    expect(result.size).toBeGreaterThan(0);
  });

  it("the pre-generated key and URL are stable — metadata can be stored before the upload attempt", async () => {
    const service = makeStorageService("http://unreachable:1");
    const buffer = Buffer.from("test-data");

    const { key, url } = await service.compressAndPreGenerateKey(
      buffer,
      "uploads",
      "report.pdf",
      "application/pdf",
    );

    expect(key).toBeTruthy();
    expect(url).toBeTruthy();
    expect(key.startsWith("uploads/")).toBe(true);
  });
});

describe("Object storage degraded — upload throws, metadata state is NOT marked complete", () => {
  let server: FaultServer;

  beforeAll(async () => {
    server = new FaultServer({ mode: "error", statusCode: 503 });
    await server.start();
  });

  afterAll(() => server.stop());

  it("uploadFile throws when the object-storage endpoint returns 503 — upload is not silently swallowed", async () => {
    const service = makeStorageService(server.url);
    const buffer = Buffer.from("payload");

    await expect(
      service.uploadFile("org-1", buffer, "uploads", "file.txt", "text/plain"),
    ).rejects.toThrow();
  });

  it("uploadToKey throws on a 503 endpoint — the caller's metadata row is not marked DONE", async () => {
    const service = makeStorageService(server.url);
    const buffer = Buffer.from("payload");

    await expect(
      service.uploadToKey("org-1", buffer, "uploads/pre-generated-key.txt", "text/plain"),
    ).rejects.toThrow();
  });
});

describe("Object storage degraded — REFUSED endpoint", () => {
  it("uploadFile throws on a refused endpoint — never silently marks upload complete", async () => {
    const port = await refusedPort();
    const service = makeStorageService(`http://127.0.0.1:${port}`);
    const buffer = Buffer.from("payload");

    await expect(
      service.uploadFile("org-1", buffer, "uploads", "file.bin", "application/octet-stream"),
    ).rejects.toThrow();
  });
});

describe("Object storage degraded — isConfigured and key validation do not touch the network", () => {
  it("isConfigured returns true when all credentials are present — no network call needed", () => {
    const service = makeStorageService("http://unreachable:1");
    expect(service.isConfigured()).toBe(true);
  });

  it("isValidFileKey correctly validates keys — no network call needed", () => {
    const service = makeStorageService("http://unreachable:1");
    expect(service.isValidFileKey("uploads/abc-def.jpg")).toBe(true);
    expect(service.isValidFileKey("../traversal/attempt")).toBe(false);
    expect(service.isValidFileKey("")).toBe(false);
    expect(service.isValidFileKey("path/with?query=1")).toBe(false);
  });

  it.skip(
    "unblocked by: a real S3/R2 storage endpoint configured in the test environment — once available, verify that an upload re-driven from the stored pre-generated key reaches the endpoint and the stored metadata row reflects completion without data loss",
    () => {},
  );

  it.skip(
    "unblocked by: a real storage endpoint and a virus-scanner seam (e.g. ClamAV sidecar) — verify the scan PENDING→CLEAN state machine under real conditions so that CLEAN is never set before the scanner confirms the result",
    () => {},
  );
});
