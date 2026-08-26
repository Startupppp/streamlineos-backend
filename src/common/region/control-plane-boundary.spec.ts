import { resolveRegionTopology } from "./region.config";
import { RegionRegistry, type RegionBinding } from "./region-registry";
import type { Db } from "../../db/drizzle.types";

/**
 * Phase 3, ticket 10 — where the control plane ends and a region begins.
 *
 * Two kinds of read exist and they must not be confused:
 *
 *   **Control plane.** Which organisations exist, and where each one is placed.
 *   Read from the primary, because placement cannot itself be region-scoped --
 *   you have to know the region before you can reach it.
 *
 *   **Tenant data.** Everything an organisation owns. Read from that
 *   organisation's own region, resolved from its placement.
 *
 * Confusing the two in either direction is a real failure. Reading placement
 * regionally cannot work. Reading tenant data from the primary silently serves
 * one region's rows to another -- and looks like success while doing it.
 *
 * The boundary is enforced structurally: `RegionRegistry` takes the lookup as a
 * function it cannot region-scope, and hands out per-region handles for
 * everything else. This pins that arrangement so a later change cannot quietly
 * collapse it.
 */

const TOPOLOGY: NodeJS.ProcessEnv = {
  PRIMARY_REGION: "india",
  REGION_KEYS: "india,eu",
  APP_DATABASE_URL: "postgres://india/app",
  R2_BUCKET_NAME: "india-bucket",
  REGION_EU_APP_DATABASE_URL: "postgres://eu/app",
  REGION_EU_R2_BUCKET_NAME: "eu-bucket",
};

function handleFor(region: string): Db {
  return { __region: region } as unknown as Db;
}

interface Wiring {
  registry: RegionRegistry;
  /** Which handle each placement lookup was served from. */
  lookups: string[];
}

function wire(placements: Record<string, string | null>): Wiring {
  const topology = resolveRegionTopology(TOPOLOGY);
  const bindings = new Map<string, RegionBinding>();
  for (const [key, definition] of Object.entries(topology.regions))
    bindings.set(key, { definition, db: handleFor(key) });

  const lookups: string[] = [];
  const registry = new RegionRegistry(topology, bindings, async (orgId) => {
    // A real lookup runs against the primary handle; recording the call is how
    // this test observes that placement never went looking in a region.
    lookups.push(orgId);
    return placements[orgId] ?? null;
  });

  return { registry, lookups };
}

describe("the control-plane boundary", () => {
  it("resolves placement before it reaches any region", async () => {
    const { registry, lookups } = wire({ "org-eu": "eu" });
    await registry.dbForOrg("org-eu");

    // Placement is asked for exactly once, and it is asked before a handle is
    // chosen -- it cannot be otherwise, because the handle is chosen from it.
    expect(lookups).toEqual(["org-eu"]);
  });

  it("serves tenant data from the organisation's own region, never the primary", async () => {
    const { registry } = wire({ "org-eu": "eu" });
    const db = await registry.dbForOrg("org-eu");

    expect(db).toMatchObject({ __region: "eu" });
    expect(db).not.toMatchObject({ __region: "india" });
  });

  it("caches placement rather than re-reading the control plane per query", async () => {
    // Region is effectively immutable per organisation, and a control-plane read
    // on every tenant query would put the primary in the path of every request
    // in every region -- which is the thing regions exist to avoid.
    const { registry, lookups } = wire({ "org-eu": "eu" });

    await registry.dbForOrg("org-eu");
    await registry.dbForOrg("org-eu");
    await registry.dbForOrg("org-eu");

    expect(lookups).toHaveLength(1);
  });

  it("re-reads after a placement is forgotten, so a move is not served stale", async () => {
    const { registry, lookups } = wire({ "org-eu": "eu" });

    await registry.dbForOrg("org-eu");
    registry.forget("org-eu");
    await registry.dbForOrg("org-eu");

    expect(lookups).toHaveLength(2);
  });

  it("never serves a handle for an organisation whose placement failed", async () => {
    // The failure mode this whole seam exists to prevent: a fallback here writes
    // one tenant's rows into another region's database.
    const { registry } = wire({ unplaced: null });

    await expect(registry.dbForOrg("unplaced")).rejects.toThrow();
    await expect(registry.storageForOrg("unplaced")).rejects.toThrow();
  });

  it("keeps each region's storage with its own region's database", async () => {
    const { registry } = wire({ "org-eu": "eu", "org-india": "india" });

    const eu = await registry.storageForOrg("org-eu");
    const india = await registry.storageForOrg("org-india");

    expect(eu.bucket).toBe("eu-bucket");
    expect(india.bucket).toBe("india-bucket");
  });

  it("exposes exactly the configured regions, so a caller cannot invent one", () => {
    const { registry } = wire({});

    expect([...registry.keys].sort()).toEqual(["eu", "india"]);
    expect(() => registry.bindingFor("apac")).toThrow(/no connection configured/);
  });
});
