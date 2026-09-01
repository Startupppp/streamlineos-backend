import { S3Client } from "@aws-sdk/client-s3";
import { resolveRegionTopology } from "../../common/region/region.config";
import {
  RegionRegistry,
  clearRegionRegistry,
  setRegionRegistry,
  type RegionBinding,
} from "../../common/region/region-registry";
import type { Db } from "../../db/drizzle.types";
import type { MediaCompressionService } from "../../common/media/media-compression.service";
import { StorageService, type StorageConfig } from "./storage.service";
import { StoragePurgeService } from "./storage-purge.service";

const topology = resolveRegionTopology({
  PRIMARY_REGION: "eu",
  REGION_KEYS: "eu,us",
  REGION_EU_APP_DATABASE_URL: "postgres://eu/main",
  REGION_EU_R2_BUCKET_NAME: "eu-files",
  REGION_EU_R2_ENDPOINT: "https://eu.r2.example",
  REGION_EU_R2_ACCESS_KEY_ID: "eu-key",
  REGION_EU_R2_SECRET_ACCESS_KEY: "eu-secret",
  REGION_US_APP_DATABASE_URL: "postgres://us/main",
  REGION_US_R2_BUCKET_NAME: "us-files",
  REGION_US_R2_ENDPOINT: "https://us.r2.example",
  REGION_US_R2_ACCESS_KEY_ID: "us-key",
  REGION_US_R2_SECRET_ACCESS_KEY: "us-secret",
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

function service(): StoragePurgeService {
  const config: StorageConfig = {
    R2_REGION: "auto",
    R2_BUCKET_NAME: "default-files",
    R2_ACCESS_KEY_ID: "test-key",
    R2_SECRET_ACCESS_KEY: "test-secret",
    R2_ENDPOINT: "https://default.r2.example",
    NEXT_PUBLIC_R2_PUBLIC_URL: "https://files.example",
  };
  const storageSvc = new StorageService({} as MediaCompressionService, config);
  return new StoragePurgeService(storageSvc);
}

type SentCall = {
  commandName: string;
  bucket: string;
  prefix?: string;
  keys?: string[];
};

function mockS3(
  listPages: Array<Array<{ Key: string }>>,
  deleteErrors: Array<{ Key: string; Message: string }> = [],
): {
  calls: SentCall[];
  spy: jest.SpyInstance;
} {
  const calls: SentCall[] = [];
  let listCallCount = 0;

  const spy = jest
    .spyOn(S3Client.prototype, "send")
    .mockImplementation(async (cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      const input = (cmd as { input: Record<string, unknown> }).input;
      const bucket = String(input["Bucket"] ?? "");

      if (name === "ListObjectsV2Command") {
        const page = listPages[listCallCount] ?? [];
        const isTruncated = listCallCount < listPages.length - 1;
        calls.push({ commandName: name, bucket, prefix: String(input["Prefix"] ?? "") });
        listCallCount += 1;
        return {
          Contents: page,
          IsTruncated: isTruncated,
          NextContinuationToken: isTruncated ? `token-${listCallCount}` : undefined,
        };
      }

      if (name === "DeleteObjectsCommand") {
        const del = input["Delete"] as { Objects: Array<{ Key: string }> };
        const keys = del.Objects.map((o) => o.Key);
        calls.push({ commandName: name, bucket, keys });
        const errors = deleteErrors.filter((e) => keys.includes(e.Key));
        const deleted = keys
          .filter((k) => !errors.some((e) => e.Key === k))
          .map((k) => ({ Key: k }));
        return { Deleted: deleted, Errors: errors };
      }

      return {};
    });

  return { calls, spy };
}

describe("StoragePurgeService.purgeOrgPrefix — pagination", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    clearRegionRegistry();
  });

  it("drains multiple ListObjectsV2 pages before deleting — returns all keys", async () => {
    install({ "org-eu": "eu" });

    const page1 = [{ Key: "a/file1.pdf" }, { Key: "a/file2.pdf" }];
    const page2 = [{ Key: "a/file3.pdf" }];
    const { calls } = mockS3([page1, page2]);

    const result = await service().purgeOrgPrefix("org-eu");

    const listCalls = calls.filter((c) => c.commandName === "ListObjectsV2Command");
    const deleteCalls = calls.filter((c) => c.commandName === "DeleteObjectsCommand");

    expect(listCalls).toHaveLength(2);
    expect(deleteCalls).toHaveLength(1);
    expect(result.deleted).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
  });

  it("(bite proof) pagination: first page does not end the listing when IsTruncated is true", async () => {
    install({ "org-eu": "eu" });

    const page1 = [{ Key: "a/file1.pdf" }];
    const page2 = [{ Key: "a/file2.pdf" }];
    const { calls } = mockS3([page1, page2]);

    const result = await service().purgeOrgPrefix("org-eu");

    const listCalls = calls.filter((c) => c.commandName === "ListObjectsV2Command");
    expect(listCalls.length).toBeGreaterThan(1);
    expect(result.deleted).toHaveLength(2);
  });
});

describe("StoragePurgeService.purgeOrgPrefix — partial failure", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    clearRegionRegistry();
  });

  it("(bite proof) a key that the provider marks as error appears in failed[], not deleted[]", async () => {
    install({ "org-eu": "eu" });

    const keys = [{ Key: "a/ok.pdf" }, { Key: "a/bad.pdf" }];
    mockS3([keys], [{ Key: "a/bad.pdf", Message: "AccessDenied" }]);

    const result = await service().purgeOrgPrefix("org-eu");

    expect(result.deleted).toContain("a/ok.pdf");
    expect(result.deleted).not.toContain("a/bad.pdf");
    expect(result.failed.map((f) => f.key)).toContain("a/bad.pdf");
    expect(result.failed[0]?.reason).toBe("AccessDenied");
  });

  it("a batch-level exception puts every key in that batch into failed[]", async () => {
    install({ "org-eu": "eu" });

    const { spy } = mockS3([[{ Key: "a/file.pdf" }]]);
    spy.mockImplementation(async (cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === "ListObjectsV2Command") return { Contents: [{ Key: "a/file.pdf" }], IsTruncated: false };
      throw new Error("ServiceUnavailable");
    });

    const result = await service().purgeOrgPrefix("org-eu");

    expect(result.deleted).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toBe("ServiceUnavailable");
  });
});

describe("StoragePurgeService.purgeOrgPrefix — idempotency", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    clearRegionRegistry();
  });

  it("second run after successful purge returns empty deleted (listing is now empty)", async () => {
    install({ "org-eu": "eu" });

    mockS3([]);

    const result = await service().purgeOrgPrefix("org-eu");

    expect(result.deleted).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it("second run after partial failure re-attempts only the remaining objects", async () => {
    install({ "org-eu": "eu" });

    const { spy } = mockS3([]);
    let callCount = 0;
    spy.mockImplementation(async (cmd: unknown) => {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      callCount += 1;

      if (name === "ListObjectsV2Command") {
        if (callCount === 1)
          return { Contents: [{ Key: "a/file.pdf" }, { Key: "a/bad.pdf" }], IsTruncated: false };
        return { Contents: [{ Key: "a/bad.pdf" }], IsTruncated: false };
      }
      if (name === "DeleteObjectsCommand") {
        const input = (cmd as { input: { Delete: { Objects: Array<{ Key: string }> } } }).input;
        const keys = input.Delete.Objects.map((o) => o.Key);
        if (keys.includes("a/bad.pdf") && callCount < 4) {
          return { Deleted: keys.filter((k) => k !== "a/bad.pdf").map((k) => ({ Key: k })), Errors: [{ Key: "a/bad.pdf", Message: "Throttled" }] };
        }
        return { Deleted: keys.map((k) => ({ Key: k })), Errors: [] };
      }
      return {};
    });

    const first = await service().purgeOrgPrefix("org-eu");
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0]?.key).toBe("a/bad.pdf");

    const second = await service().purgeOrgPrefix("org-eu");
    expect(second.deleted).toContain("a/bad.pdf");
    expect(second.failed).toHaveLength(0);
  });
});

describe("StoragePurgeService.purgeOrgPrefix — placement isolation", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    clearRegionRegistry();
  });

  it("(bite proof) purging org-eu never sends commands to the us-files bucket", async () => {
    install({ "org-eu": "eu", "org-us": "us" });

    const { calls } = mockS3([[]]);

    await service().purgeOrgPrefix("org-eu");

    for (const call of calls) {
      expect(call.bucket).toBe("eu-files");
      expect(call.bucket).not.toBe("us-files");
    }
  });

  it("purging org-us operates only in the us-files bucket", async () => {
    install({ "org-eu": "eu", "org-us": "us" });

    const { calls } = mockS3([[]]);

    await service().purgeOrgPrefix("org-us");

    for (const call of calls) {
      expect(call.bucket).toBe("us-files");
      expect(call.bucket).not.toBe("eu-files");
    }
  });

  it("refuses to purge an unplaced organisation — no fallback to primary bucket", async () => {
    install({ "org-eu": "eu" });

    mockS3([[]]);

    await expect(service().purgeOrgPrefix("org-unknown")).rejects.toThrow(/has no region/);
  });
});
