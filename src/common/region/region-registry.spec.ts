import type { Db } from "../../db/drizzle.types";
import { resolveRegionTopology, type RegionTopology } from "./region.config";
import {
  RegionRegistry,
  clearRegionRegistry,
  getRegionRegistry,
  hasRegionRegistry,
  setRegionRegistry,
  type RegionBinding,
} from "./region-registry";

const twoRegions: RegionTopology = resolveRegionTopology({
  PRIMARY_REGION: "eu",
  REGION_KEYS: "eu,us",
  REGION_EU_APP_DATABASE_URL: "postgres://eu/main",
  REGION_US_APP_DATABASE_URL: "postgres://us/main",
});

function bindingsFor(topology: RegionTopology): Map<string, RegionBinding> {
  return new Map(
    Object.values(topology.regions).map((definition) => [
      definition.key,
      { definition, db: { __region: definition.key } as unknown as Db },
    ]),
  );
}

function registryWith(
  placement: Record<string, string | null>,
  options: { now?: () => number } = {},
): { registry: RegionRegistry; lookups: string[] } {
  const lookups: string[] = [];
  const registry = new RegionRegistry(
    twoRegions,
    bindingsFor(twoRegions),
    async (orgId) => {
      lookups.push(orgId);
      return Object.hasOwn(placement, orgId) ? placement[orgId] : null;
    },
    options.now,
  );
  return { registry, lookups };
}

describe("RegionRegistry", () => {
  it("resolves an organisation to the region it was placed in", async () => {
    const { registry } = registryWith({ "org-1": "us" });
    await expect(registry.regionForOrg("org-1")).resolves.toBe("us");
  });

  it("hands back the connection belonging to that region, not the primary", async () => {
    const { registry } = registryWith({ "org-1": "us" });
    const db = (await registry.dbForOrg("org-1")) as unknown as { __region: string };
    expect(db.__region).toBe("us");
  });

  it("refuses an organisation nobody has placed, rather than assuming the primary", async () => {
    const { registry } = registryWith({ "org-1": null });
    await expect(registry.regionForOrg("org-1")).rejects.toThrow(/has no region/);
  });

  it("refuses an organisation this deployment does not serve", async () => {
    const { registry } = registryWith({ "org-1": "ap" });
    await expect(registry.regionForOrg("org-1")).rejects.toThrow(
      /placed in "ap", which this deployment does not serve/,
    );
  });

  it("names what it does serve, so the error is actionable", async () => {
    const { registry } = registryWith({ "org-1": "ap" });
    await expect(registry.regionForOrg("org-1")).rejects.toThrow(/Configured: eu, us/);
  });

  it("refuses an unknown organisation outright", async () => {
    const { registry } = registryWith({});
    await expect(registry.regionForOrg("ghost")).rejects.toThrow(/has no region/);
  });

  it("rejects an empty orgId instead of resolving something arbitrary", async () => {
    const { registry } = registryWith({});
    await expect(registry.regionForOrg("")).rejects.toThrow(/non-empty/);
  });

  it("never returns a fallback connection for a failed resolution", async () => {
    const { registry } = registryWith({ "org-1": null });
    await expect(registry.dbForOrg("org-1")).rejects.toThrow();
  });

  it("cannot hand one organisation the connection of another region", async () => {
    const { registry } = registryWith({ "org-eu": "eu", "org-us": "us" });

    const eu = (await registry.dbForOrg("org-eu")) as unknown as { __region: string };
    const us = (await registry.dbForOrg("org-us")) as unknown as { __region: string };

    expect(eu.__region).toBe("eu");
    expect(us.__region).toBe("us");
    expect(eu).not.toBe(us);
  });

  it("resolves storage through the same placement as the database", async () => {
    const { registry } = registryWith({ "org-1": "us" });
    const storage = await registry.storageForOrg("org-1");
    expect(storage).toBe(twoRegions.regions.us?.storage);
  });

  it("caches a placement, because region is immutable until a migration moves it", async () => {
    const { registry, lookups } = registryWith({ "org-1": "eu" });

    await registry.regionForOrg("org-1");
    await registry.regionForOrg("org-1");

    expect(lookups).toEqual(["org-1"]);
  });

  it("re-reads once the cache expires", async () => {
    let clock = 0;
    const { registry, lookups } = registryWith({ "org-1": "eu" }, { now: () => clock });

    await registry.regionForOrg("org-1");
    clock += 11 * 60 * 1000;
    await registry.regionForOrg("org-1");

    expect(lookups).toEqual(["org-1", "org-1"]);
  });

  it("re-reads immediately once an organisation is forgotten", async () => {
    const { registry, lookups } = registryWith({ "org-1": "eu" });

    await registry.regionForOrg("org-1");
    registry.forget("org-1");
    await registry.regionForOrg("org-1");

    expect(lookups).toHaveLength(2);
  });

  it("does not cache a failed resolution as if it succeeded", async () => {
    const { registry, lookups } = registryWith({ "org-1": null });

    await expect(registry.regionForOrg("org-1")).rejects.toThrow();
    await expect(registry.regionForOrg("org-1")).rejects.toThrow();

    expect(lookups).toHaveLength(2);
  });

  it("refuses a region with no connection configured", () => {
    const registry = new RegionRegistry(twoRegions, new Map(), async () => "eu");
    expect(() => registry.bindingFor("eu")).toThrow(/no connection configured/);
  });
});

describe("the module-level registry", () => {
  afterEach(() => clearRegionRegistry());

  it("refuses to resolve before it is configured, rather than guessing", () => {
    clearRegionRegistry();
    expect(hasRegionRegistry()).toBe(false);
    expect(() => getRegionRegistry()).toThrow(/registry not configured/);
  });

  it("serves the registry once configured", () => {
    const { registry } = registryWith({ "org-1": "eu" });
    setRegionRegistry(registry);

    expect(hasRegionRegistry()).toBe(true);
    expect(getRegionRegistry()).toBe(registry);
  });
});
