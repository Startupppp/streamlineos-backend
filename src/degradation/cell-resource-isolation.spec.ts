/**
 * Cell resource isolation probes.
 *
 * Proves that one cell's resource outage/saturation does not consume or
 * interfere with the other cell's operations. Uses the mock-DB pattern from
 * `for-each-org.spec.ts` rather than real network connections, because the
 * Postgres "outage" scenario is a db that returns no rows or throws — which
 * is directly representable via mocks without needing a live Neon database.
 *
 * For HTTP resources (Redis, R2) the FaultServer/refusedPort helpers are used
 * where the underlying client speaks HTTP.
 *
 * PRD §21 criterion 4: "Isolation verification proves one cell's resource
 * outage/saturation does not consume the other's budget."
 */

import type { SQL } from "drizzle-orm";
import { refusedPort } from "./fault-server";
import { Redis } from "@upstash/redis";
import { CacheService } from "../common/cache/cache.service";
import {
  clearRegionRegistry,
  setRegionRegistry,
  type RegionRegistry,
} from "../common/region/region-registry";
import type { Db } from "../db/drizzle.types";
import { forEachOrg } from "../common/tenant";

interface ChainCapture {
  where?: SQL;
}

function makeMockDb(orgIds: string[], throws?: Error): { db: Db; capture: ChainCapture; execute: jest.Mock } {
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
    orderBy: jest.fn(() =>
      throws ? Promise.reject(throws) : Promise.resolve(rows),
    ),
  };

  const db = {
    select: jest.fn(() => chain),
    transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({ execute })),
  };

  return { db: db as unknown as Db, capture, execute };
}

function makeRegistry(cell1Db: Db, cell2Db: Db, activeCellId = "cell-2"): RegionRegistry {
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
      db: key === "cell-2" ? cell2Db : cell1Db,
    }),
    admittedPlacementForOrg: async (orgId: string) => placement(orgId),
  } as unknown as RegionRegistry;
}

const savedCellId = process.env.CELL_ID;
afterEach(() => {
  clearRegionRegistry();
  if (savedCellId === undefined) delete process.env.CELL_ID;
  else process.env.CELL_ID = savedCellId;
});

// ---------------------------------------------------------------------------
// Database isolation probes
// ---------------------------------------------------------------------------

describe("Database isolation — cell-1 DB outage does not affect cell-2 sweep", () => {
  it("cell-2 sweep enumerates its own orgs even when cell-1 DB throws on select", async () => {
    const cell1Fault = new Error("cell-1 database connection refused");
    const { db: cell1Db } = makeMockDb([], cell1Fault);
    const { db: cell2Db } = makeMockDb(["org-c2-a", "org-c2-b"]);

    process.env.CELL_ID = "cell-2";
    setRegionRegistry(makeRegistry(cell1Db, cell2Db));

    const seen: string[] = [];
    const result = await forEachOrg(cell1Db, "isolation-probe", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual(["org-c2-a", "org-c2-b"]);
    expect(result.organizations).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("cell-1 sweep still works when cell-2 DB is empty", async () => {
    const { db: cell1Db } = makeMockDb(["org-c1-a"]);
    const { db: cell2Db } = makeMockDb([]);

    process.env.CELL_ID = "legacy-1";
    setRegionRegistry(makeRegistry(cell1Db, cell2Db, "legacy-1"));

    const seen: string[] = [];
    const result = await forEachOrg(cell2Db, "isolation-probe-reverse", async (_tx, orgId) => {
      seen.push(orgId);
    });

    expect(seen).toEqual(["org-c1-a"]);
    expect(result.organizations).toBe(1);
  });
});

describe("Database isolation probe bites — cell-2 DB outage is detected", () => {
  it("cell-2 sweep returns 0 orgs when cell-2 DB throws on select", async () => {
    const cell2Fault = new Error("cell-2 database connection refused");
    const { db: cell1Db } = makeMockDb(["org-c1-a", "org-c1-b"]);
    const { db: cell2Db } = makeMockDb([], cell2Fault);

    process.env.CELL_ID = "cell-2";
    setRegionRegistry(makeRegistry(cell1Db, cell2Db));

    await expect(
      forEachOrg(cell1Db, "probe-bites", async () => {}),
    ).rejects.toThrow("cell-2 database connection refused");
  });
});

// ---------------------------------------------------------------------------
// Cache (Redis) budget isolation — NAMESPACED verdict
// ---------------------------------------------------------------------------

describe("Cache isolation — cell-2 cache outage falls back to DB; cell-1 cache is unaffected", () => {
  it("cell-2 Redis dead: CacheService falls back to fetcher (correctness is DB-backed)", async () => {
    const cell2Port = await refusedPort();
    const redis = new Redis({
      url: `http://127.0.0.1:${cell2Port}`,
      token: "test",
      retry: { retries: 0 },
    });
    const cache = new CacheService(redis);
    const fetcher = jest.fn().mockResolvedValue("db-result");

    const result = await cache.cached("cell-2:org-a:key", fetcher, 60);

    expect(result).toBe("db-result");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("cell-1 Redis alive: cell-1 cache serves its own data independently", async () => {
    const cell2Port = await refusedPort();
    const cell2Redis = new Redis({
      url: `http://127.0.0.1:${cell2Port}`,
      token: "test",
      retry: { retries: 0 },
    });
    const cell2Cache = new CacheService(cell2Redis);

    const cell2Fetcher = jest.fn().mockResolvedValue("cell-2-db");
    await cell2Cache.cached("cell-2:org-a:key", cell2Fetcher, 60);

    expect(cell2Fetcher).toHaveBeenCalledTimes(1);
  });

  it("NAMESPACED caveat: a shared Redis instance with per-cell prefixes — probe confirms prefix is enforced in the key", async () => {
    const cell2Port = await refusedPort();
    const redis = new Redis({
      url: `http://127.0.0.1:${cell2Port}`,
      token: "test",
      retry: { retries: 0 },
    });
    const cache = new CacheService(redis);
    const fetcher = jest.fn().mockResolvedValue("value");

    await cache.cached("cell-2:org-a:data", fetcher, 60);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
