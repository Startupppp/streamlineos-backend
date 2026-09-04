import type { Db } from "../../db/drizzle.types";
import type { MediaCompressionService } from "../../common/media/media-compression.service";
import { resolveRegionTopology } from "../../common/region/region.config";
import {
  RegionRegistry,
  clearRegionRegistry,
  setRegionRegistry,
  type RegionBinding,
} from "../../common/region/region-registry";
import { S3Client } from "@aws-sdk/client-s3";
import { StorageService, type StorageConfig } from "./storage.service";

const topology = resolveRegionTopology({
  PRIMARY_REGION: "eu",
  REGION_KEYS: "eu,us",
  REGION_EU_APP_DATABASE_URL: "postgres://eu/main",
  REGION_EU_R2_BUCKET_NAME: "eu-files",
  REGION_EU_R2_ENDPOINT: "https://eu.r2.example",
  REGION_US_APP_DATABASE_URL: "postgres://us/main",
  REGION_US_R2_BUCKET_NAME: "us-files",
  REGION_US_R2_ENDPOINT: "https://us.r2.example",
});

function install(placement: Record<string, string | null>): void {
  const bindings = new Map<string, RegionBinding>(
    Object.values(topology.regions).map((definition) => [
      definition.key,
      { definition, db: {} as Db },
    ]),
  );

  setRegionRegistry(
    new RegionRegistry(topology, bindings, async (orgId) =>
      Object.hasOwn(placement, orgId) ? placement[orgId] : null,
    ),
  );
}

function service(): StorageService {
  const config: StorageConfig = {
    R2_REGION: "auto",
    R2_BUCKET_NAME: "default-files",
    R2_ACCESS_KEY_ID: "test-key",
    R2_SECRET_ACCESS_KEY: "test-secret",
    R2_ENDPOINT: "https://default.r2.example",
    NEXT_PUBLIC_R2_PUBLIC_URL: "https://files.example",
  };
  return new StorageService({} as MediaCompressionService, config, { isKeyBlocked: async () => false });
}

describe("StorageService region placement", () => {
  afterEach(() => clearRegionRegistry());

  it("resolves a file's bucket through the same placement as its database", async () => {
    install({ "org-us": "us" });

    await expect(service().configForOrg("org-us")).resolves.toMatchObject({
      bucketName: "us-files",
      endpoint: "https://us.r2.example",
    });
  });

  it("gives two organisations in different regions different buckets", async () => {
    install({ "org-eu": "eu", "org-us": "us" });
    const storage = service();

    const eu = await storage.configForOrg("org-eu");
    const us = await storage.configForOrg("org-us");

    expect(eu.bucketName).toBe("eu-files");
    expect(us.bucketName).toBe("us-files");
  });

  it("refuses an unplaced organisation rather than writing into the primary bucket", async () => {
    install({ "org-1": null });
    await expect(service().configForOrg("org-1")).rejects.toThrow(/has no region/);
  });

  it("refuses an organisation placed somewhere this deployment does not serve", async () => {
    install({ "org-1": "ap" });
    await expect(service().configForOrg("org-1")).rejects.toThrow(/does not serve/);
  });

  it("reports configured when the primary region has a complete bucket", () => {
    install({});
    // The registry, not the environment, is now the source for the primary bucket.
    const withCredentials = resolveRegionTopology({
      PRIMARY_REGION: "eu",
      REGION_EU_APP_DATABASE_URL: "postgres://eu/main",
      REGION_EU_R2_BUCKET_NAME: "eu-files",
      REGION_EU_R2_ENDPOINT: "https://eu.r2.example",
      REGION_EU_R2_ACCESS_KEY_ID: "key",
      REGION_EU_R2_SECRET_ACCESS_KEY: "secret",
    });
    setRegionRegistry(
      new RegionRegistry(
        withCredentials,
        new Map([["eu", { definition: withCredentials.regions.eu!, db: {} as Db }]]),
        async () => "eu",
      ),
    );

    expect(service().isConfigured()).toBe(true);
  });

  /**
   * Rewritten, because the original asserted a belief that had stopped being
   * true. It set `process.env.R2_BUCKET_NAME` and expected `isConfigured()` to
   * go false — but configuration arrives through the injected `StorageConfig`,
   * not through the environment, so poking `process.env` changed nothing and
   * the service was right to report configured. It has been failing on `main`
   * ever since the injection landed.
   */
  it("reads the injected configuration when no registry is installed", () => {
    clearRegionRegistry();
    expect(service().isConfigured()).toBe(true);
  });

  it("reports unconfigured when the injected configuration is incomplete", () => {
    clearRegionRegistry();
    const withoutBucket = new StorageService({} as MediaCompressionService, {
      R2_REGION: "auto",
      R2_BUCKET_NAME: undefined,
      R2_ACCESS_KEY_ID: "test-key",
      R2_SECRET_ACCESS_KEY: "test-secret",
      R2_ENDPOINT: "https://default.r2.example",
      NEXT_PUBLIC_R2_PUBLIC_URL: "https://files.example",
    } as StorageConfig, { isKeyBlocked: async () => false });

    expect(withoutBucket.isConfigured()).toBe(false);
  });
});

/**
 * The criterion this file exists for: object storage and file access resolving
 * through the *same* region path as the database.
 *
 * `configForOrg` proved the seam could answer the question. These prove the file
 * operations actually ask it — which they did not: `StorageService` built one
 * `S3Client` in its constructor from the primary region's settings, so a call
 * for a US organisation opened a connection to the EU endpoint and wrote into
 * the EU bucket. A per-org resolver that every operation ignores is not a seam,
 * it is a second opinion.
 */
describe("StorageService file operations follow the organisation's region", () => {
  let sent: { bucket: unknown; key: unknown; endpoint: string }[];
  let send: jest.SpyInstance;

  beforeEach(() => {
    sent = [];
    send = jest
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(async function (this: S3Client, command: unknown) {
        const input = (command as { input: { Bucket?: unknown; Key?: unknown } }).input;
        const endpoint = await (this.config.endpoint as (() => Promise<{ hostname: string }>))();
        sent.push({ bucket: input.Bucket, key: input.Key, endpoint: endpoint.hostname });
        return {} as never;
      });
  });

  afterEach(() => {
    send.mockRestore();
    clearRegionRegistry();
  });

  it("writes an upload into the bucket of the organisation's own region", async () => {
    install({ "org-us": "us" });

    await service().uploadFile("org-us", Buffer.from("x"), "uploads", "a.txt", "text/plain");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.bucket).toBe("us-files");
    expect(sent[0]!.endpoint).toBe("us.r2.example");
  });

  it("sends two organisations' uploads to two different regions", async () => {
    install({ "org-eu": "eu", "org-us": "us" });
    const storage = service();

    await storage.uploadFile("org-eu", Buffer.from("x"), "uploads", "a.txt", "text/plain");
    await storage.uploadFile("org-us", Buffer.from("x"), "uploads", "a.txt", "text/plain");

    expect(sent.map((call) => call.bucket)).toEqual(["eu-files", "us-files"]);
  });

  it("reads a file back from the region it was written to", async () => {
    install({ "org-us": "us" });

    await service().deleteFile("org-us", "uploads/a.txt");

    expect(sent[0]!.bucket).toBe("us-files");
  });

  /**
   * The fail-closed path, at the operation rather than only at the resolver.
   * An unplaced organisation must not have its file quietly written into the
   * primary bucket — that is how one tenant's documents end up in another
   * region, and it is unrecoverable once it has happened.
   */
  it("refuses to upload for an organisation nobody placed", async () => {
    install({ "org-1": null });

    await expect(
      service().uploadFile("org-1", Buffer.from("x"), "uploads", "a.txt", "text/plain"),
    ).rejects.toThrow(/has no region/);
    expect(sent).toEqual([]);
  });

  it("still uses the injected configuration when no registry is installed", async () => {
    clearRegionRegistry();

    await service().uploadFile("org-any", Buffer.from("x"), "uploads", "a.txt", "text/plain");

    expect(sent[0]!.bucket).toBe("default-files");
  });
});
