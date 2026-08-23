import type { Db } from "../../db/drizzle.types";
import type { MediaCompressionService } from "../../common/media/media-compression.service";
import { resolveRegionTopology } from "../../common/region/region.config";
import {
  RegionRegistry,
  clearRegionRegistry,
  setRegionRegistry,
  type RegionBinding,
} from "../../common/region/region-registry";
import { StorageService } from "./storage.service";

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
  return new StorageService({} as MediaCompressionService);
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

  it("falls back to the environment when no registry is configured", () => {
    clearRegionRegistry();
    const previous = process.env.R2_BUCKET_NAME;
    process.env.R2_BUCKET_NAME = "legacy-bucket";

    try {
      expect(service().isConfigured()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.R2_BUCKET_NAME;
      else process.env.R2_BUCKET_NAME = previous;
    }
  });
});
