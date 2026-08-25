import type { Db } from "../../../db/drizzle.types";
import { resolveRegionTopology } from "../../region/region.config";
import {
  RegionRegistry,
  clearRegionRegistry,
  setRegionRegistry,
  type RegionBinding,
} from "../../region/region-registry";
import { withTenant } from "../with-tenant";

const topology = resolveRegionTopology({
  PRIMARY_REGION: "eu",
  REGION_KEYS: "eu,us",
  REGION_EU_APP_DATABASE_URL: "postgres://eu/main",
  REGION_US_APP_DATABASE_URL: "postgres://us/main",
});

/** A db that records the region it belongs to whenever a transaction opens on it. */
function recordingDb(region: string, opened: string[]): Db {
  return {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      opened.push(region);
      return fn({ execute: async () => [] });
    },
  } as unknown as Db;
}

function install(placement: Record<string, string | null>): { opened: string[] } {
  const opened: string[] = [];
  const bindings = new Map<string, RegionBinding>(
    Object.values(topology.regions).map((definition) => [
      definition.key,
      { definition, db: recordingDb(definition.key, opened) },
    ]),
  );

  setRegionRegistry(
    new RegionRegistry(topology, bindings, async (orgId) =>
      Object.hasOwn(placement, orgId) ? placement[orgId] : null,
    ),
  );

  return { opened };
}

describe("withTenant region resolution", () => {
  afterEach(() => clearRegionRegistry());

  it("opens the transaction on the organisation's own region", async () => {
    const { opened } = install({ "org-us": "us" });

    await withTenant(recordingDb("caller-supplied", opened), { orgId: "org-us", audience: "INTERNAL" }, async () => "ok");

    expect(opened).toEqual(["us"]);
  });

  it("ignores the connection the caller passed, so a stale handle cannot leak across regions", async () => {
    const { opened } = install({ "org-eu": "eu" });

    // The interceptor and the cron sweep both hand in the primary db. If that
    // were honoured, every tenant would be served from the primary region.
    await withTenant(recordingDb("caller-supplied", opened), { orgId: "org-eu", audience: "INTERNAL" }, async () => "ok");

    expect(opened).toEqual(["eu"]);
    expect(opened).not.toContain("caller-supplied");
  });

  it("cannot serve one organisation from another organisation's region", async () => {
    const { opened } = install({ "org-eu": "eu", "org-us": "us" });

    await withTenant(recordingDb("x", opened), { orgId: "org-eu", audience: "INTERNAL" }, async () => "ok");
    await withTenant(recordingDb("x", opened), { orgId: "org-us", audience: "INTERNAL" }, async () => "ok");

    expect(opened).toEqual(["eu", "us"]);
  });

  it("refuses to open anything for an unplaced organisation", async () => {
    const { opened } = install({ "org-1": null });

    await expect(
      withTenant(recordingDb("x", opened), { orgId: "org-1", audience: "INTERNAL" }, async () => "ok"),
    ).rejects.toThrow(/has no region/);

    expect(opened).toEqual([]);
  });

  it("refuses an organisation placed in a region this deployment does not serve", async () => {
    const { opened } = install({ "org-1": "ap" });

    await expect(
      withTenant(recordingDb("x", opened), { orgId: "org-1", audience: "INTERNAL" }, async () => "ok"),
    ).rejects.toThrow(/does not serve/);

    expect(opened).toEqual([]);
  });

  it("still rejects an empty orgId before it reaches resolution", async () => {
    const { opened } = install({});

    await expect(
      withTenant(recordingDb("x", opened), { orgId: "", audience: "INTERNAL" }, async () => "ok"),
    ).rejects.toThrow(/non-empty/);

    expect(opened).toEqual([]);
  });

  it("uses the given connection when no registry is configured, which is the unit-test path", async () => {
    clearRegionRegistry();
    const opened: string[] = [];

    await withTenant(recordingDb("caller-supplied", opened), { orgId: "org-1", audience: "INTERNAL" }, async () => "ok");

    expect(opened).toEqual(["caller-supplied"]);
  });

  it("sets the tenant GUC on the regional connection, not the caller's", async () => {
    const opened: string[] = [];
    const executed: string[] = [];

    const bindings = new Map<string, RegionBinding>(
      Object.values(topology.regions).map((definition) => [
        definition.key,
        {
          definition,
          db: {
            transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
              opened.push(definition.key);
              return fn({
                execute: async () => {
                  executed.push(definition.key);
                  return [];
                },
              });
            },
          } as unknown as Db,
        },
      ]),
    );

    setRegionRegistry(
      new RegionRegistry(topology, bindings, async () => "us"),
    );

    await withTenant(recordingDb("caller-supplied", opened), { orgId: "org-1", audience: "INTERNAL" }, async () => "ok");

    expect(opened).toEqual(["us"]);
    expect(executed).toEqual(["us"]);
  });
});
