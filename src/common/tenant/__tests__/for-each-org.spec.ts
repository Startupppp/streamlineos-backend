import type { SQL } from "drizzle-orm";
import { forEachOrg } from "../for-each-org";
import { getTenantContext } from "../tenant-context";
import type { Db } from "../../../db/drizzle.module";
import {
  clearRegionRegistry,
  setRegionRegistry,
  type RegionRegistry,
} from "../../region/region-registry";

interface ChainCapture {
  where?: SQL;
}

function collectColumnNames(value: unknown, found: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if ("name" in value && typeof (value as { name: unknown }).name === "string") {
    found.add((value as { name: string }).name);
  }
  if ("queryChunks" in value && Array.isArray((value as { queryChunks: unknown[] }).queryChunks)) {
    for (const chunk of (value as { queryChunks: unknown[] }).queryChunks) {
      collectColumnNames(chunk, found);
    }
  }
}

function makeMockDb(orgIds: string[]): { db: Db; capture: ChainCapture; execute: jest.Mock } {
  const capture: ChainCapture = {};
  const execute = jest.fn();
  const rows = orgIds.map((id) => ({ id }));

  interface SelectChain {
    from: jest.Mock<SelectChain, []>;
    where: jest.Mock<SelectChain, [SQL]>;
    orderBy: jest.Mock<Promise<{ id: string }[]>, []>;
  }

  const chain: SelectChain = {
    from: jest.fn((): SelectChain => chain),
    where: jest.fn((condition: SQL): SelectChain => {
      capture.where = condition;
      return chain;
    }),
    orderBy: jest.fn(() => Promise.resolve(rows)),
  };

  const db = {
    select: jest.fn(() => chain),
    transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({ execute })),
  };

  return { db: db as unknown as Db, capture, execute };
}

describe("forEachOrg", () => {
  it("only enumerates organizations that are ACTIVE and not soft-deleted", async () => {
    const { db, capture } = makeMockDb([]);

    await forEachOrg(db, "test-sweep", jest.fn());

    const columns = new Set<string>();
    collectColumnNames(capture.where, columns);
    expect(columns).toContain("status");
    expect(columns).toContain("deleted_at");
  });

  it("runs the callback once per organization with that organization's id", async () => {
    const { db } = makeMockDb(["org-a", "org-b", "org-c"]);
    const seen: string[] = [];

    const result = await forEachOrg(db, "test-sweep", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual(["org-a", "org-b", "org-c"]);
    expect(result).toEqual({ organizations: 3, succeeded: 3, failed: 0 });
  });

  it("sets the tenant GUC for each organization", async () => {
    const { db, execute } = makeMockDb(["org-a", "org-b"]);

    await forEachOrg(db, "test-sweep", jest.fn());

    expect(execute).toHaveBeenCalledTimes(2);
    const orgIds = new Set<string>();
    function collectNestedStrings(value: unknown): void {
      if (typeof value === "string") { orgIds.add(value); return; }
      if (!value || typeof value !== "object") return;
      const obj = value as Record<string, unknown>;
      if ("queryChunks" in obj && Array.isArray(obj.queryChunks))
        for (const c of obj.queryChunks as unknown[]) collectNestedStrings(c);
    }
    for (const call of execute.mock.calls) collectNestedStrings(call[0]);
    expect(orgIds).toContain("org-a");
    expect(orgIds).toContain("org-b");
  });

  it("exposes the ambient tenant context so nested services resolve to the transaction", async () => {
    const { db } = makeMockDb(["org-a"]);
    let observed: string | undefined;

    await forEachOrg(db, "test-sweep", async () => {
      observed = getTenantContext()?.orgId;
    });

    expect(observed).toBe("org-a");
  });

  it("isolates a failing organization and continues the sweep", async () => {
    const { db } = makeMockDb(["org-a", "org-b", "org-c"]);
    const seen: string[] = [];

    const result = await forEachOrg(db, "test-sweep", async (_tx, orgId) => {
      seen.push(orgId);
      if (orgId === "org-b") throw new Error("boom");
    });

    expect(seen).toEqual(["org-a", "org-b", "org-c"]);
    expect(result).toEqual({ organizations: 3, succeeded: 2, failed: 1 });
  });

  it("leaves no tenant context behind once the sweep finishes", async () => {
    const { db } = makeMockDb(["org-a"]);

    await forEachOrg(db, "test-sweep", jest.fn());

    expect(getTenantContext()).toBeUndefined();
  });
});

describe("forEachOrg — cell-aware enumeration", () => {
  const savedCellId = process.env.CELL_ID;

  afterEach(() => {
    clearRegionRegistry();
    if (savedCellId === undefined) delete process.env.CELL_ID;
    else process.env.CELL_ID = savedCellId;
  });

  function makeRegistryWithCells(
    fallbackDb: Db,
    cellDb: Db,
    activeCellId = "cell-2",
  ): RegionRegistry {
    const placement = (orgId: string) => ({
      organizationId: orgId,
      region: activeCellId === "cell-2" ? "cell-2" : "primary",
      cellId: activeCellId,
      databaseShard: activeCellId,
      objectStorageRegion: "auto",
      searchCluster: activeCellId,
      placementVersion: 1,
      writeFenceToken: null,
      leaseExpiresAt: null,
      status: "ACTIVE" as const,
    });
    return {
      keys: ["primary", "cell-2"],
      bindingFor: (key: string): ReturnType<RegionRegistry["bindingFor"]> => ({
        definition: {
          cell: { cellId: key === "cell-2" ? "cell-2" : "legacy-1" },
        } as ReturnType<RegionRegistry["bindingFor"]>["definition"],
        db: key === "cell-2" ? cellDb : fallbackDb,
      }),
      admittedPlacementForOrg: async (orgId: string) => placement(orgId),
    } as unknown as RegionRegistry;
  }

  it("uses the cell-specific db when CELL_ID is set and a registry is available", async () => {
    const fallbackDb = makeMockDb([]).db;
    const { db: cellDb, capture } = makeMockDb(["org-cell-2-a", "org-cell-2-b"]);

    process.env.CELL_ID = "cell-2";
    setRegionRegistry(makeRegistryWithCells(fallbackDb, cellDb));

    const seen: string[] = [];
    const result = await forEachOrg(fallbackDb, "cell-sweep", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual(["org-cell-2-a", "org-cell-2-b"]);
    expect(result.organizations).toBe(2);
    expect(capture.where).toBeDefined();
  });

  it("uses the fallback db when CELL_ID is not set (single-cell deployment)", async () => {
    delete process.env.CELL_ID;
    const { db: fallbackDb, capture } = makeMockDb(["org-primary-a"]);
    const cellDb = makeMockDb([]).db;

    setRegionRegistry(makeRegistryWithCells(fallbackDb, cellDb, "legacy-1"));

    const seen: string[] = [];
    await forEachOrg(fallbackDb, "primary-sweep", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual(["org-primary-a"]);
    expect(capture.where).toBeDefined();
  });

  it("uses the fallback db when no registry is configured (unit-test path)", async () => {
    process.env.CELL_ID = "cell-2";

    const { db: fallbackDb, capture } = makeMockDb(["org-from-fallback"]);

    const seen: string[] = [];
    await forEachOrg(fallbackDb, "no-registry-sweep", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual(["org-from-fallback"]);
    expect(capture.where).toBeDefined();
  });

  it("OUTAGE PROBE — cell-1 db faulted, cell-2 sweep is unaffected", async () => {
    const faultedDb = makeMockDb([]).db;

    const cell2Orgs = ["org-cell-2-x", "org-cell-2-y"];
    const { db: cell2Db } = makeMockDb(cell2Orgs);

    process.env.CELL_ID = "cell-2";
    setRegionRegistry(makeRegistryWithCells(faultedDb, cell2Db));

    const seen: string[] = [];
    const result = await forEachOrg(faultedDb, "outage-probe", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual(cell2Orgs);
    expect(result.organizations).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("OUTAGE PROBE bites — cell-2 db faulted, cell-2 sweep returns 0 orgs", async () => {
    const faultedCell2Db = makeMockDb([]).db;
    const { db: cell1Db } = makeMockDb(["org-cell-1-a", "org-cell-1-b"]);

    process.env.CELL_ID = "cell-2";
    setRegionRegistry(makeRegistryWithCells(cell1Db, faultedCell2Db));

    const seen: string[] = [];
    const result = await forEachOrg(cell1Db, "outage-probe-bites", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual([]);
    expect(result.organizations).toBe(0);
  });
});
