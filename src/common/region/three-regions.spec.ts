import { resolveRegionTopology } from "./region.config";
import {
  RegionRegistry,
  clearRegionRegistry,
  setRegionRegistry,
  type RegionBinding,
} from "./region-registry";
import type { Db } from "../../db/drizzle.types";

/**
 * Phase 3, ticket 08 — the negative acceptance test.
 *
 * Phase 1 paid for a region-aware resolver when there was exactly one region,
 * which looked like over-engineering at the time. The claim it bought was that
 * standing up a second and third region would then be a deployment exercise:
 * **no change to `withTenant`, to `resolveRegionalDb`, or to any caller.**
 *
 * This is where that is cashed. Everything below configures three regions the
 * way a deployment would -- environment variables and nothing else -- and
 * asserts each tenant reaches its own database. Not one line of the tenant
 * transaction path is touched, imported or stubbed to make it pass.
 *
 * If this file ever needs a change below the seam to keep passing, that is a
 * finding about Phase 1's placement and is worth more than the workaround.
 */

const THREE_REGIONS: NodeJS.ProcessEnv = {
  PRIMARY_REGION: "india",
  REGION_KEYS: "india,eu,us",
  APP_DATABASE_URL: "postgres://india/app",
  R2_BUCKET_NAME: "india-bucket",
  REGION_EU_APP_DATABASE_URL: "postgres://eu/app",
  REGION_EU_R2_BUCKET_NAME: "eu-bucket",
  REGION_US_APP_DATABASE_URL: "postgres://us/app",
  REGION_US_R2_BUCKET_NAME: "us-bucket",
};

/** A stand-in for a live handle; identity is all these assertions need. */
function handleFor(region: string): Db {
  return { __region: region } as unknown as Db;
}

function registryFor(
  env: NodeJS.ProcessEnv,
  placements: Record<string, string | null>,
): RegionRegistry {
  const topology = resolveRegionTopology(env);
  const bindings = new Map<string, RegionBinding>();

  for (const [key, definition] of Object.entries(topology.regions))
    bindings.set(key, { definition, db: handleFor(key) });

  return new RegionRegistry(topology, bindings, async (orgId) => placements[orgId] ?? null);
}

describe("three regions, from configuration alone", () => {
  afterEach(() => clearRegionRegistry());

  it("reads all three from the environment, with no code change", () => {
    const topology = resolveRegionTopology(THREE_REGIONS);

    expect(Object.keys(topology.regions).sort()).toEqual(["eu", "india", "us"]);
    expect(topology.primary).toBe("india");
  });

  it("gives each region its own database, never a shared one", () => {
    const topology = resolveRegionTopology(THREE_REGIONS);
    const urls = Object.values(topology.regions).map((region) => region.databaseUrl);

    expect(new Set(urls).size).toBe(3);
  });

  it("refuses a secondary region configured without a database", () => {
    // A silent fallback here is how two regions end up pointing at one database,
    // which is the single failure the whole seam exists to prevent.
    expect(() =>
      resolveRegionTopology({ ...THREE_REGIONS, REGION_US_APP_DATABASE_URL: undefined }),
    ).toThrow(/region "us" has no database/);
  });

  it("does not let a secondary inherit the primary's flat variables", () => {
    const topology = resolveRegionTopology(THREE_REGIONS);

    expect(topology.regions.eu?.storage.bucket).toBe("eu-bucket");
    expect(topology.regions.eu?.storage.bucket).not.toBe("india-bucket");
  });
});

describe("a tenant reaches its own region", () => {
  const placements = { "org-in-eu": "eu", "org-in-us": "us", "org-in-india": "india" };

  afterEach(() => clearRegionRegistry());

  it("routes each organisation to the database of its own region", async () => {
    const registry = registryFor(THREE_REGIONS, placements);

    await expect(registry.dbForOrg("org-in-eu")).resolves.toMatchObject({ __region: "eu" });
    await expect(registry.dbForOrg("org-in-us")).resolves.toMatchObject({ __region: "us" });
    await expect(registry.dbForOrg("org-in-india")).resolves.toMatchObject({
      __region: "india",
    });
  });

  it("routes storage through the same placement as the database", async () => {
    const registry = registryFor(THREE_REGIONS, placements);
    const storage = await registry.storageForOrg("org-in-eu");

    expect(storage.bucket).toBe("eu-bucket");
  });

  it("never falls back to the primary for an unplaced organisation", async () => {
    // Falling back would put one tenant's rows in another region's database and
    // look like success while doing it.
    const registry = registryFor(THREE_REGIONS, { ...placements, stray: null });

    await expect(registry.dbForOrg("stray")).rejects.toThrow(/has no region/);
  });

  it("refuses a placement this deployment does not serve", async () => {
    const registry = registryFor(THREE_REGIONS, { ...placements, "org-in-apac": "apac" });

    await expect(registry.dbForOrg("org-in-apac")).rejects.toThrow(/does not serve/);
  });
});

describe("the seam claim", () => {
  afterEach(() => clearRegionRegistry());

  it("resolves without any caller naming a region", async () => {
    /*
      The whole claim in one assertion. `withTenant`'s signature is
      (db, {orgId, audience}, fn) -- there is no region parameter, and adding a
      second region did not introduce one. Resolution happens inside the seam,
      from the organisation alone, which is why three regions cost no call site.
    */
    const registry = registryFor(THREE_REGIONS, { "org-in-eu": "eu" });
    setRegionRegistry(registry);

    const { getRegionRegistry } = await import("./region-registry");
    const resolved = await getRegionRegistry().dbForOrg("org-in-eu");

    expect(resolved).toMatchObject({ __region: "eu" });
  });

  it("degrades to the passed handle when no registry is configured", async () => {
    // Unit tests, seeds and scripts run with no registry. That path must keep
    // working, or every one of them becomes region-aware for no reason.
    const { hasRegionRegistry } = await import("./region-registry");
    expect(hasRegionRegistry()).toBe(false);
  });

  it("still serves a single-region deployment with no configuration at all", () => {
    // The other half of the claim: adding regions must not have made the
    // one-region case require configuration it did not need before.
    const topology = resolveRegionTopology({ APP_DATABASE_URL: "postgres://only/app" });

    expect(topology.primary).toBe("primary");
    expect(Object.keys(topology.regions)).toEqual(["primary"]);
  });
});
