import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { InvProductCrudService } from "./products/inv-product-crud.service";
import { InvProductCatalogService } from "./products/inv-product-catalog.service";
import { InvVendorsService } from "./vendors/inv-vendors.service";
import { InvWarehousesService } from "./warehouses/inv-warehouses.service";
import { CacheService } from "../../common/cache/cache.service";
import { InventoryAuditService } from "./stock-engine/inventory-audit.service";
import { CostVisibilityService } from "./stock-engine/cost-visibility";
import { WarehouseScopeService } from "./stock-engine/warehouse-scope.service";
import { INVENTORY_ISOLATION_STUBS } from "./__tests__/isolation-stubs";

const USER = "user-1";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeQueryDb(rows: unknown[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
  const handler = { findMany, findFirst };

  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain.orderBy = jest.fn().mockReturnValue(chain);
    chain.limit = jest.fn().mockReturnValue(chain);
    chain.offset = jest.fn().mockResolvedValue(rows);
    chain.where = jest.fn().mockReturnValue(chain);
    chain.innerJoin = jest.fn().mockReturnValue(chain);
    chain.leftJoin = jest.fn().mockReturnValue(chain);
    chain.then = (
      onFulfilled: ((value: unknown) => unknown) | null | undefined,
      onRejected?: ((reason: unknown) => unknown) | null | undefined,
    ) => Promise.resolve(rows).then(onFulfilled ?? undefined, onRejected ?? undefined);
    return chain;
  }

  const rootChain = makeChain();
  const selectWhere = rootChain.where as jest.Mock;
  const selectFrom = jest.fn().mockReturnValue(rootChain);

  const db = {
    select: jest.fn().mockReturnValue({ from: selectFrom }),
    query: new Proxy({} as Record<string, typeof handler>, { get: () => handler }),
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
  } as unknown as Db;
  return { db, findMany, findFirst, selectWhere };
}

const mockCache = {
  cached: jest.fn().mockImplementation(async (_k: string, fn: () => unknown) => fn()),
  cachedVersioned: jest.fn().mockImplementation(async (_ns: string, _h: string, fn: () => unknown) => fn()),
  cachedVersionedForOrg: jest.fn().mockImplementation(async (_o: string, _ns: string, _k: string, fn: () => unknown) => fn()),
  invalidate: jest.fn(),
  invalidateNamespace: jest.fn(),
};

describe("InvProductCrudService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";
  const PRODUCT = { id: 1, orgId: OWNER, name: "Widget" };

  it("returns empty for a foreign org (isolation — deny)", async () => {
    const { db, findMany } = makeQueryDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvProductCrudService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: mockCache },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
        { provide: CostVisibilityService, useValue: { canSeeCost: jest.fn().mockResolvedValue(false) } },
      ],
    }).compile().then((m) => m.get(InvProductCrudService));

    const result = await svc.listProducts(ATTACKER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const firstArg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(firstArg?.where)).toContain(ATTACKER);
  });

  it("returns products for the owning org (control — same-tenant access)", async () => {
    const { db } = makeQueryDb([PRODUCT]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvProductCrudService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: mockCache },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
        { provide: CostVisibilityService, useValue: { canSeeCost: jest.fn().mockResolvedValue(false) } },
      ],
    }).compile().then((m) => m.get(InvProductCrudService));

    const result = await svc.listProducts(OWNER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("InvProductCatalogService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns null when variant belongs to a different org (isolation — deny)", async () => {
    const { db, findFirst } = makeQueryDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvProductCatalogService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile().then((m) => m.get(InvProductCatalogService));

    const product = await (db as unknown as { query: { invProducts: { findFirst: jest.Mock } } }).query.invProducts.findFirst({ where: {} });
    expect(product).toBeNull();
    expect(findFirst).toHaveBeenCalled();
  });

  it("scopes category list to the owning org (isolation — control)", async () => {
    const CAT = { id: 10, orgId: OWNER, name: "Electronics" };
    const { db, findMany } = makeQueryDb([CAT]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvProductCatalogService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile().then((m) => m.get(InvProductCatalogService));

    const result = await svc.listCategories(OWNER);
    expect(result).toHaveLength(1);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(OWNER);
  });
});

describe("InvVendorsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";
  const VENDOR = { id: 5, orgId: OWNER, name: "Acme Supplies" };

  it("returns empty vendor list for a foreign org (isolation — deny)", async () => {
    const { db } = makeQueryDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvVendorsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile().then((m) => m.get(InvVendorsService));

    const result = await svc.listVendors(ATTACKER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
  });

  it("returns vendors for the owning org (isolation — control)", async () => {
    const { db } = makeQueryDb([VENDOR]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvVendorsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile().then((m) => m.get(InvVendorsService));

    const result = await svc.listVendors(OWNER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("InvWarehousesService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";
  const WH = { id: 1, orgId: OWNER, name: "Main Warehouse", isActive: true };

  it("returns empty warehouses for a foreign org (isolation — deny)", async () => {
    const { db, selectWhere } = makeQueryDb([]);
    const scope = { resolve: jest.fn().mockResolvedValue(null), warehousePredicate: jest.fn().mockReturnValue({ queryChunks: [] }) };
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvWarehousesService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: mockCache },
        { provide: WarehouseScopeService, useValue: scope },
      ],
    }).compile().then((m) => m.get(InvWarehousesService));

    const result = await svc.listWarehouses(ATTACKER, "user-1");
    expect(result).toHaveLength(0);
    expect(selectWhere).toHaveBeenCalled();
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns warehouses for the owning org (isolation — control)", async () => {
    const { db } = makeQueryDb([WH]);
    const scope = { resolve: jest.fn().mockResolvedValue(null), warehousePredicate: jest.fn().mockReturnValue({ queryChunks: [] }) };
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvWarehousesService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: mockCache },
        { provide: WarehouseScopeService, useValue: scope },
      ],
    }).compile().then((m) => m.get(InvWarehousesService));

    const result = await svc.listWarehouses(OWNER, "user-1");
    expect(result).toHaveLength(1);
  });
});
