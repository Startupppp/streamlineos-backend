import fs from "node:fs";
import path from "node:path";
import { resolveRegionTopology } from "./region.config";
import {
  RegionRegistry,
  clearRegionRegistry,
  setRegionRegistry,
  type RegionBinding,
} from "./region-registry";
import { withTenant } from "../tenant/with-tenant";
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
 * way a deployment would -- environment variables and nothing else -- and then
 * drives the **real** `withTenant` across them.
 *
 * The first version of this file did not do that. It asserted against
 * `RegionRegistry` directly and left the claim about `withTenant` in a comment,
 * which meant it passed with `resolveRegionalDb` reduced to `return db` -- every
 * tenant served from the primary, which is the single failure the seam exists to
 * prevent. A guard that cannot fail is not evidence. Both breaks below were run
 * against these tests and both are now caught.
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

/**
 * A stand-in for a live handle that records every transaction opened on it.
 *
 * Identity alone was enough while these tests only asked the registry which
 * handle it would hand back; driving `withTenant` needs a handle that can
 * actually be opened, and recording which one was opened is the assertion.
 */
function handleFor(region: string, opened: string[]): Db {
  return {
    __region: region,
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      opened.push(region);
      return fn({ execute: async () => [] });
    },
  } as unknown as Db;
}

function registryFor(
  env: NodeJS.ProcessEnv,
  placements: Record<string, string | null>,
  opened: string[] = [],
): RegionRegistry {
  const topology = resolveRegionTopology(env);
  const bindings = new Map<string, RegionBinding>();

  for (const [key, definition] of Object.entries(topology.regions))
    bindings.set(key, { definition, db: handleFor(key, opened) });

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

describe("the seam claim, driven through withTenant", () => {
  const placements = { "org-in-eu": "eu", "org-in-us": "us", "org-in-india": "india" };

  afterEach(() => clearRegionRegistry());

  it("serves three tenants from three databases, with no caller naming a region", async () => {
    /*
      The whole claim in one assertion, and the one that fails if the seam is
      cut. `withTenant`'s signature is (db, {orgId, audience}, fn): no caller
      below says "eu". Resolution happens inside the seam, from the organisation
      alone, which is why three regions cost no call site.

      Reducing `resolveRegionalDb` to `return db` makes this fail with
      ["caller", "caller", "caller"] -- every tenant served from one database.
    */
    const opened: string[] = [];
    setRegionRegistry(registryFor(THREE_REGIONS, placements, opened));
    const caller = handleFor("caller", opened);

    await withTenant(caller, { orgId: "org-in-eu", audience: "INTERNAL" }, async () => "ok");
    await withTenant(caller, { orgId: "org-in-us", audience: "INTERNAL" }, async () => "ok");
    await withTenant(caller, { orgId: "org-in-india", audience: "INTERNAL" }, async () => "ok");

    expect(opened).toEqual(["eu", "us", "india"]);
  });

  it("ignores the handle the caller passed, so a stale one cannot leak across regions", async () => {
    // The interceptor and the cron sweep both hand in the primary's connection.
    // Honouring it would serve all three regions from the primary.
    const opened: string[] = [];
    setRegionRegistry(registryFor(THREE_REGIONS, placements, opened));

    await withTenant(
      handleFor("caller", opened),
      { orgId: "org-in-eu", audience: "INTERNAL" },
      async () => "ok",
    );

    expect(opened).not.toContain("caller");
  });

  it("opens nothing at all for an organisation placed in an unserved region", async () => {
    const opened: string[] = [];
    setRegionRegistry(registryFor(THREE_REGIONS, { "org-in-apac": "apac" }, opened));

    await expect(
      withTenant(
        handleFor("caller", opened),
        { orgId: "org-in-apac", audience: "INTERNAL" },
        async () => "ok",
      ),
    ).rejects.toThrow(/does not serve/);

    expect(opened).toEqual([]);
  });

  it("degrades to the passed handle when no registry is configured", async () => {
    // Unit tests, seeds and scripts run with no registry. That path must keep
    // working, or every one of them becomes region-aware for no reason.
    const opened: string[] = [];
    clearRegionRegistry();

    await withTenant(
      handleFor("caller", opened),
      { orgId: "org-1", audience: "INTERNAL" },
      async () => "ok",
    );

    expect(opened).toEqual(["caller"]);
  });

  it("still serves a single-region deployment with no configuration at all", () => {
    // The other half of the claim: adding regions must not have made the
    // one-region case require configuration it did not need before.
    const topology = resolveRegionTopology({ APP_DATABASE_URL: "postgres://only/app" });

    expect(topology.primary).toBe("primary");
    expect(Object.keys(topology.regions)).toEqual(["primary"]);
  });
});

describe("the seam claim, as a signature", () => {
  /**
   * The half no runtime assertion can reach.
   *
   * "Standing up region two requires no change to any caller" is a claim about
   * `withTenant`'s *type*, and ts-jest runs with `isolatedModules: true` -- it
   * transpiles and never type-checks, so adding a required `region` to the
   * context passes every test in this repo. `tsc --noEmit` does catch it (31
   * errors across 14 files, measured), but a typecheck failing somewhere else
   * is not this ticket's evidence. So the signature is read here.
   */
  const source = fs.readFileSync(
    path.join(__dirname, "..", "tenant", "with-tenant.ts"),
    "utf8",
  );

  it("reads a real file, so a silent miss is not a pass", () => {
    expect(source).toContain("export async function withTenant");
  });

  it("takes an organisation and an audience, and no region", () => {
    const parameters = /export async function withTenant<T>\(([\s\S]*?)\): Promise<T>/.exec(
      source,
    )?.[1];

    expect(parameters).toBeDefined();
    expect(parameters).toContain("orgId");
    // `withNewOrgInRegion` is the one operation permitted to state a region, and
    // it is a different function for exactly that reason. If `withTenant` grows
    // a region, every one of its callers has to learn one.
    expect(parameters).not.toMatch(/\bregion\b/i);
  });
});
