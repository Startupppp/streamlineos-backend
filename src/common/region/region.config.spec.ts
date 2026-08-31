import { isKnownRegion, resolveRegionTopology } from "./region.config";

const base = { DATABASE_URL: "postgres://flat/main" } satisfies NodeJS.ProcessEnv;

describe("resolveRegionTopology", () => {
  it("needs no configuration for a single-region deployment", () => {
    const topology = resolveRegionTopology({ ...base });

    expect(topology.primary).toBe("primary");
    expect(Object.keys(topology.regions)).toEqual(["primary"]);
    expect(topology.regions.primary?.databaseUrl).toBe("postgres://flat/main");
  });

  it("lets the primary inherit the existing flat storage variables", () => {
    const topology = resolveRegionTopology({
      ...base,
      R2_BUCKET_NAME: "files",
      R2_ENDPOINT: "https://r2.example",
      NEXT_PUBLIC_R2_PUBLIC_URL: "https://cdn.example",
    });

    expect(topology.regions.primary?.storage).toMatchObject({
      bucket: "files",
      endpoint: "https://r2.example",
      publicUrl: "https://cdn.example",
      region: "auto",
    });
  });

  it("prefers an explicit per-region variable over the flat one", () => {
    const topology = resolveRegionTopology({
      ...base,
      REGION_PRIMARY_APP_DATABASE_URL: "postgres://explicit/main",
    });

    expect(topology.regions.primary?.databaseUrl).toBe("postgres://explicit/main");
  });

  it("prefers the RLS-enforced application role over the owner URL", () => {
    const topology = resolveRegionTopology({
      DATABASE_URL: "postgres://owner/main",
      APP_DATABASE_URL: "postgres://app/main",
    });

    expect(topology.regions.primary?.databaseUrl).toBe("postgres://app/main");
  });

  it("configures several regions from REGION_KEYS", () => {
    const topology = resolveRegionTopology({
      ...base,
      PRIMARY_REGION: "eu",
      REGION_KEYS: "eu,us,in",
      REGION_EU_APP_DATABASE_URL: "postgres://eu/main",
      REGION_US_APP_DATABASE_URL: "postgres://us/main",
      REGION_IN_APP_DATABASE_URL: "postgres://in/main",
    });

    expect(topology.primary).toBe("eu");
    expect(Object.keys(topology.regions).sort()).toEqual(["eu", "in", "us"]);
    expect(topology.regions.us?.databaseUrl).toBe("postgres://us/main");
  });

  it("never lets a secondary region inherit the flat variables", () => {
    // Two regions silently sharing one database is the worst possible outcome
    // of a typo, so a secondary must be configured explicitly.
    expect(() =>
      resolveRegionTopology({
        ...base,
        PRIMARY_REGION: "eu",
        REGION_KEYS: "eu,us",
        REGION_EU_APP_DATABASE_URL: "postgres://eu/main",
      }),
    ).toThrow(/region "us" has no database/);
  });

  it("always includes the primary even if REGION_KEYS forgets it", () => {
    const topology = resolveRegionTopology({
      ...base,
      PRIMARY_REGION: "eu",
      REGION_KEYS: "us",
      REGION_EU_APP_DATABASE_URL: "postgres://eu/main",
      REGION_US_APP_DATABASE_URL: "postgres://us/main",
    });

    expect(Object.keys(topology.regions).sort()).toEqual(["eu", "us"]);
  });

  it("rejects a region key that could not appear in an environment variable", () => {
    expect(() => resolveRegionTopology({ ...base, PRIMARY_REGION: "EU West!" })).toThrow(
      /PRIMARY_REGION/,
    );
  });

  it("refuses to start with no database at all", () => {
    expect(() => resolveRegionTopology({})).toThrow(/has no database/);
  });

  it("maps a dashed key onto an underscored variable name", () => {
    const topology = resolveRegionTopology({
      ...base,
      PRIMARY_REGION: "eu-west",
      REGION_EU_WEST_APP_DATABASE_URL: "postgres://eu-west/main",
    });

    expect(topology.regions["eu-west"]?.databaseUrl).toBe("postgres://eu-west/main");
  });

  it("keeps dedicated cache credentials attached to their cell", () => {
    const topology = resolveRegionTopology({
      ...base,
      REGION_KEYS: "primary,cell-2",
      REGION_CELL_2_APP_DATABASE_URL: "postgres://cell-2/main",
      REGION_CELL_2_UPSTASH_REDIS_REST_URL: "https://cell-2.upstash.io",
      REGION_CELL_2_UPSTASH_REDIS_REST_TOKEN: "cell-2-token",
      REGION_CELL_2_CACHE_KEY_PREFIX: "cell-2",
    });

    expect(topology.regions["cell-2"]?.cell.cache).toEqual({
      upstashUrl: "https://cell-2.upstash.io",
      upstashToken: "cell-2-token",
      keyPrefix: "cell-2",
    });
  });

  it("rejects a partially configured dedicated cache", () => {
    expect(() =>
      resolveRegionTopology({
        ...base,
        REGION_KEYS: "primary,cell-2",
        REGION_CELL_2_APP_DATABASE_URL: "postgres://cell-2/main",
        REGION_CELL_2_UPSTASH_REDIS_REST_URL: "https://cell-2.upstash.io",
      }),
    ).toThrow(/must configure both/);
  });
});

describe("isKnownRegion", () => {
  const topology = resolveRegionTopology({ ...base });

  it("recognises a configured region", () => {
    expect(isKnownRegion(topology, "primary")).toBe(true);
  });

  it("rejects anything else, including absence", () => {
    expect(isKnownRegion(topology, "us")).toBe(false);
    expect(isKnownRegion(topology, null)).toBe(false);
    expect(isKnownRegion(topology, undefined)).toBe(false);
  });

  it("is not fooled by inherited object properties", () => {
    expect(isKnownRegion(topology, "constructor")).toBe(false);
    expect(isKnownRegion(topology, "toString")).toBe(false);
  });
});
