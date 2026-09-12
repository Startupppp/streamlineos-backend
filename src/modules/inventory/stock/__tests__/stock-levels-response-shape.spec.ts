import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { CostVisibilityService } from "../../stock-engine/cost-visibility";
import { InvStockService } from "../inv-stock.service";

/**
 * `GET /inventory/stock`, field by field.
 *
 * The endpoint returned the driver's own column names for its whole life --
 * `on_hand` where the client reads `onHand`, no join at all where it reads a
 * product and a location -- so the table showed `NaN` in every quantity column
 * and a dash for every name, in every tenant. Nothing failed: `tsc` cannot check
 * `apiClient.get<T>()`, no test asserted a single field of the payload, and the
 * repo's response-shape drift gate skips this endpoint entirely.
 *
 * So the shape is pinned here, key by key and type by type, against
 * `RawStockLevel` in `frontend/hooks/api/inventory/stock-levels.ts`. A quantity
 * asserted as a string is not pedantry: these are Postgres `numeric` columns,
 * the driver hands them over as strings, the hook's type says string and calls
 * `Number()` -- and `Number(undefined)` is exactly the `NaN` that was on screen.
 */

const ORG = "org-1";
const USER = "user-1";

/** One row as the join hands it over: flat groups, per-field nulls. */
function joinRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    onHand: "120.0000",
    committed: "20.0000",
    onOrder: "5.0000",
    available: "100.0000",
    blockedQty: "0.0000",
    qualityHoldQty: "0.0000",
    averageCost: "42.5000",
    productVariant: {
      id: 31,
      name: "Blue / L",
      sku: "TSHIRT-BL-L",
      productId: 12,
      productName: "Cotton T-Shirt",
      productSku: "TSHIRT",
      reorderPoint: "25.0000",
    },
    location: {
      id: 88,
      name: "Aisle 4 Bin 2",
      code: "A4-B2",
      warehouseId: 3,
      warehouseName: "Bengaluru DC",
    },
    ...overrides,
  };
}

interface Harness {
  db: Db;
  projections: Record<string, unknown>[];
}

/**
 * A db double that answers the two queries `listStockLevels` runs and keeps the
 * projection object it was handed, so the declared shape can be asserted rather
 * than inferred from whatever the double chose to return.
 */
function makeDb(rows: unknown[], total = rows.length): Harness {
  const projections: Record<string, unknown>[] = [];

  const select = jest.fn().mockImplementation((projection: Record<string, unknown>) => {
    projections.push(projection);
    const isCount = Object.keys(projection).length === 1 && "count" in projection;
    const result: unknown[] = isCount ? [{ count: total }] : rows;
    const chain: Record<string, unknown> = {};
    for (const step of ["leftJoin", "where", "orderBy", "limit"]) chain[step] = jest.fn().mockReturnValue(chain);
    chain.offset = jest.fn().mockResolvedValue(result);
    chain.then = (
      onFulfilled: ((value: unknown) => unknown) | null | undefined,
      onRejected?: ((reason: unknown) => unknown) | null | undefined,
    ) => Promise.resolve(result).then(onFulfilled ?? undefined, onRejected ?? undefined);
    return { from: jest.fn().mockReturnValue(chain) };
  });

  return { db: { select } as unknown as Db, projections };
}

const cache = {
  cached: jest.fn().mockImplementation(async (_k: string, fn: () => unknown) => fn()),
  cachedVersioned: jest.fn().mockImplementation(async (_ns: string, _h: string, fn: () => unknown) => fn()),
  invalidate: jest.fn(),
  invalidateNamespace: jest.fn(),
};

const warehouseScope = {
  resolve: jest.fn().mockResolvedValue(null),
  scopeKey: jest.fn().mockReturnValue("all"),
  locationPredicate: jest.fn(),
  warehousePredicate: jest.fn(),
  warehouseIdList: jest.fn().mockReturnValue(null),
  forUser: jest.fn(),
};

async function serviceWith(db: Db, canSeeCost: boolean): Promise<InvStockService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      InvStockService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: cache },
      { provide: WarehouseScopeService, useValue: warehouseScope },
      { provide: CostVisibilityService, useValue: { canSeeCost: jest.fn().mockResolvedValue(canSeeCost) } },
    ],
  }).compile();
  return moduleRef.get(InvStockService);
}

/** Every key appearing anywhere in a payload, at any depth. */
function everyKey(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (value === null || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) everyKey(item, found);
    return found;
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    found.add(key);
    everyKey(inner, found);
  }
  return found;
}

beforeEach(() => {
  cache.cachedVersioned.mockClear();
});

describe("GET /inventory/stock — the response shape the hook parses", () => {
  it("declares exactly the fields RawStockLevel reads, and no others", async () => {
    const { db, projections } = makeDb([joinRow()]);
    const service = await serviceWith(db, true);
    await service.listStockLevels(ORG, USER, { page: 1, limit: 20 });

    const page = projections[0];
    expect(page).toBeDefined();
    expect(Object.keys(page!).sort()).toEqual([
      "available",
      "averageCost",
      "blockedQty",
      "committed",
      "id",
      "location",
      "onHand",
      "onOrder",
      "productVariant",
      "qualityHoldQty",
    ]);
  });

  it("maps every field of a row, with the identities the table renders", async () => {
    const { db } = makeDb([joinRow()], 41);
    const service = await serviceWith(db, true);

    const result = await service.listStockLevels(ORG, USER, { page: 2, limit: 20 });

    expect(result.items).toEqual([
      {
        id: 7,
        onHand: "120.0000",
        committed: "20.0000",
        onOrder: "5.0000",
        available: "100.0000",
        blockedQty: "0.0000",
        qualityHoldQty: "0.0000",
        averageCost: "42.5000",
        productVariant: {
          id: 31,
          name: "Blue / L",
          sku: "TSHIRT-BL-L",
          product: { id: 12, name: "Cotton T-Shirt", sku: "TSHIRT", reorderPoint: "25.0000" },
        },
        location: {
          id: 88,
          name: "Aisle 4 Bin 2",
          code: "A4-B2",
          warehouse: { id: 3, name: "Bengaluru DC" },
        },
      },
    ]);
    expect(result).toMatchObject({ total: 41, page: 2, limit: 20, totalPages: 3 });
  });

  it("sends every quantity as a string, because the hook types them as strings and calls Number()", async () => {
    const { db } = makeDb([joinRow()]);
    const service = await serviceWith(db, true);

    const [row] = (await service.listStockLevels(ORG, USER, { page: 1, limit: 20 })).items;

    expect(row).toBeDefined();
    for (const field of ["onHand", "committed", "onOrder", "available", "blockedQty", "qualityHoldQty"] as const) {
      expect(typeof row![field]).toBe("string");
      expect(Number(row![field])).not.toBeNaN();
    }
    expect(typeof row!.productVariant?.product?.reorderPoint).toBe("string");
  });

  it("reports an absent variant or location as null rather than a husk of nulls", async () => {
    const { db } = makeDb([
      joinRow({
        productVariant: { id: null, name: null, sku: null, productId: null, productName: null, productSku: null, reorderPoint: null },
        location: { id: null, name: null, code: null, warehouseId: null, warehouseName: null },
      }),
    ]);
    const service = await serviceWith(db, true);

    const [row] = (await service.listStockLevels(ORG, USER, { page: 1, limit: 20 })).items;

    expect(row!.productVariant).toBeNull();
    expect(row!.location).toBeNull();
  });

  it("keeps a variant whose product row is gone, naming the variant instead of a husk", async () => {
    const { db } = makeDb([
      joinRow({
        productVariant: { id: 31, name: "Blue / L", sku: "TSHIRT-BL-L", productId: null, productName: null, productSku: null, reorderPoint: null },
        location: { id: 88, name: "Aisle 4 Bin 2", code: "A4-B2", warehouseId: null, warehouseName: null },
      }),
    ]);
    const service = await serviceWith(db, true);

    const [row] = (await service.listStockLevels(ORG, USER, { page: 1, limit: 20 })).items;

    expect(row!.productVariant).toEqual({ id: 31, name: "Blue / L", sku: "TSHIRT-BL-L", product: null });
    expect(row!.location).toEqual({ id: 88, name: "Aisle 4 Bin 2", code: "A4-B2", warehouse: null });
  });

  it("discriminates the cache key by cost visibility and by response shape", async () => {
    const { db } = makeDb([joinRow()]);
    await (await serviceWith(db, false)).listStockLevels(ORG, USER, { page: 1, limit: 20 });
    const withoutCost = String(cache.cachedVersioned.mock.calls[0]?.[1]);

    cache.cachedVersioned.mockClear();
    await (await serviceWith(makeDb([joinRow()]).db, true)).listStockLevels(ORG, USER, { page: 1, limit: 20 });
    const withCost = String(cache.cachedVersioned.mock.calls[0]?.[1]);

    expect(withoutCost).not.toEqual(withCost);
    /*
     * The shape discriminator. The row shape changed under a live cache whose
     * version is per-org, and there is no boot hook that could bump every
     * tenant's -- so a stale entry of the OLD shape has to be unreachable by
     * key, not merely evicted eventually. Both keys carry it.
     */
    expect(withoutCost.startsWith("s2:")).toBe(true);
    expect(withCost.startsWith("s2:")).toBe(true);
  });
});

/**
 * The load-bearing one.
 *
 * `stripCostFields` matches field NAMES. The fix renamed `average_cost` to
 * `averageCost`, and a rename is exactly how a strip list is silently disarmed:
 * the payload keeps compiling, the screen keeps rendering, and unit cost --
 * supplier pricing, frequently NDA-bound -- is simply in the body of every
 * warehouse operator's response. Nothing else in either repo would notice.
 */
describe("GET /inventory/stock — cost is absent for a caller who may not see it", () => {
  const COST_BEARING = [
    "averageCost", "average_cost",
    "unitCost", "unit_cost",
    "costPrice", "cost_price",
    "standardCost", "standard_cost",
    "landedCost", "landed_cost",
    "totalValue", "total_value",
  ];

  it("strips averageCost under its new camelCase name", async () => {
    const { db } = makeDb([joinRow()]);
    const service = await serviceWith(db, false);

    const result = await service.listStockLevels(ORG, USER, { page: 1, limit: 20 });

    const keys = everyKey(result.items);
    expect([...keys].filter((key) => COST_BEARING.includes(key))).toEqual([]);
    expect(JSON.stringify(result.items)).not.toContain("42.5000");
  });

  it("still returns the rest of the row, so the strip is not just an empty payload", async () => {
    const { db } = makeDb([joinRow()]);
    const service = await serviceWith(db, false);

    const [row] = (await service.listStockLevels(ORG, USER, { page: 1, limit: 20 })).items;

    expect(row).toMatchObject({
      id: 7,
      onHand: "120.0000",
      available: "100.0000",
      productVariant: { sku: "TSHIRT-BL-L", product: { name: "Cotton T-Shirt" } },
      location: { code: "A4-B2", warehouse: { name: "Bengaluru DC" } },
    });
    expect("averageCost" in row!).toBe(false);
  });

  /*
   * The control. Without it the strip test above passes just as happily against
   * a service that never projected a cost field at all, which would make the
   * whole pair vacuous the day somebody drops the column from the projection.
   */
  it("returns averageCost to a caller who holds the valuation key", async () => {
    const { db } = makeDb([joinRow()]);
    const service = await serviceWith(db, true);

    const [row] = (await service.listStockLevels(ORG, USER, { page: 1, limit: 20 })).items;

    expect(row!.averageCost).toBe("42.5000");
  });
});
