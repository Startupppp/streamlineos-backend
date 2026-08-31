import type { Db } from "../../db/drizzle.types";
import {
  FENCE_LEASE_MS,
  FENCE_RENEW_WINDOW_MS,
  orgPlacementLookup,
} from "./placement-lookup";
import { resolveRegionTopology } from "./region.config";

const topology = resolveRegionTopology({
  PRIMARY_REGION: "eu",
  REGION_EU_APP_DATABASE_URL: "postgres://eu/main",
});

interface Row {
  region: string;
  cellId: string;
  databaseShard: string;
  objectStorageRegion: string;
  searchCluster: string;
  placementVersion: number;
  writeFenceToken: string;
  leaseExpiresAt: Date;
  status: string;
  legacyRegion: string | null;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    region: "eu",
    cellId: "legacy-1",
    databaseShard: "primary",
    objectStorageRegion: "eu",
    searchCluster: "primary",
    placementVersion: 3,
    writeFenceToken: "fence-a",
    leaseExpiresAt: new Date(Date.now() + FENCE_LEASE_MS),
    status: "ACTIVE",
    legacyRegion: "eu",
    ...overrides,
  };
}

function selectChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

function makeDb(found: Row | null, renewedTo: Date | null) {
  const updates: { where: unknown }[] = [];
  const updateChain = {
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockImplementation((w: unknown) => {
        updates.push({ where: w });
        return {
          returning: jest
            .fn()
            .mockResolvedValue(renewedTo ? [{ leaseExpiresAt: renewedTo }] : []),
        };
      }),
    }),
  };

  const db = {
    select: jest.fn().mockReturnValue(selectChain(found ? [found] : [])),
    update: jest.fn().mockReturnValue(updateChain),
  } as unknown as Db;

  return { db, updates, updateChain };
}

describe("the write-fence lease", () => {
  it("is left alone while it is far from expiring", async () => {
    const { db, updates } = makeDb(row(), null);

    const placement = await orgPlacementLookup(db, topology)("org-1");

    expect(updates).toHaveLength(0);
    expect(placement?.writeFenceToken).toBe("fence-a");
  });

  it("is renewed once it enters the renewal window", async () => {
    const renewedTo = new Date(Date.now() + FENCE_LEASE_MS);
    const dueSoon = new Date(Date.now() + FENCE_RENEW_WINDOW_MS - 60_000);
    const { db, updates } = makeDb(row({ leaseExpiresAt: dueSoon }), renewedTo);

    const placement = await orgPlacementLookup(db, topology)("org-1");

    expect(updates).toHaveLength(1);
    expect(placement?.leaseExpiresAt).toBe(renewedTo.getTime());
  });

  it("is not renewed for a placement this deployment does not own the cell of", async () => {
    const dueSoon = new Date(Date.now() + FENCE_RENEW_WINDOW_MS - 60_000);
    const { db, updates } = makeDb(
      row({ leaseExpiresAt: dueSoon, cellId: "cell-b" }),
      new Date(),
    );

    await orgPlacementLookup(db, topology)("org-1");

    expect(updates).toHaveLength(0);
  });

  it("is not renewed while the placement is not ACTIVE, so a relocation is not revived", async () => {
    const dueSoon = new Date(Date.now() + FENCE_RENEW_WINDOW_MS - 60_000);
    const { db, updates } = makeDb(
      row({ leaseExpiresAt: dueSoon, status: "MOVING" }),
      new Date(),
    );

    await orgPlacementLookup(db, topology)("org-1");

    expect(updates).toHaveLength(0);
  });

  it("keeps the old expiry when the renewal matches nothing, rather than inventing one", async () => {
    const dueSoon = new Date(Date.now() + FENCE_RENEW_WINDOW_MS - 60_000);
    const { db } = makeDb(row({ leaseExpiresAt: dueSoon }), null);

    const placement = await orgPlacementLookup(db, topology)("org-1");

    expect(placement?.leaseExpiresAt).toBe(dueSoon.getTime());
  });

  it("returns null for an organisation with no placement row", async () => {
    const { db } = makeDb(null, null);

    await expect(orgPlacementLookup(db, topology)("ghost")).resolves.toBeNull();
  });

  it("renews strictly less often than the lease lasts", () => {
    expect(FENCE_RENEW_WINDOW_MS).toBeLessThan(FENCE_LEASE_MS);
  });
});
