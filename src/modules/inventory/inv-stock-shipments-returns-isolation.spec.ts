import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { InvStockService } from "./stock/inv-stock.service";
import { InvStockAdjustmentsService } from "./stock/inv-stock-adjustments.service";
import { InvStockTransfersService } from "./stock/inv-stock-transfers.service";
import { InvStockReservationsService } from "./stock/inv-stock-reservations.service";
import { ShipmentsService } from "./shipments/shipments.service";
import { LoadsService } from "./shipments/loads.service";
import { PackagesService } from "./shipments/packages.service";
import { CarriersService } from "./shipments/carriers.service";
import { CustomerReturnsService } from "./returns/customer-returns.service";
import { VendorReturnsService } from "./returns/vendor-returns.service";
import { CacheService } from "../../common/cache/cache.service";
import { WarehouseScopeService } from "./stock-engine/warehouse-scope.service";
import { StockEngineService } from "./stock-engine/stock-engine.service";
import { InventorySettingsService } from "./stock-engine/inventory-settings.service";
import { NumberSequenceService } from "./stock-engine/number-sequence.service";
import { InventoryAuditService } from "./stock-engine/inventory-audit.service";
import { CostVisibilityService } from "./stock-engine/cost-visibility";
import { ReservationService } from "./stock-engine/reservation.service";
import { INVENTORY_ISOLATION_STUBS } from "./__tests__/isolation-stubs";

/**
 * The three methods `InvStockTransfersService` actually calls on
 * `ReservationService` — createReservationInTx (reserve), consumeReservationsBatch
 * (complete) and releaseReservationInTx (cancel).
 *
 * It used to name `releaseReservation`, which does not exist on the real class,
 * and omitted `consumeReservationsBatch`, which does. Neither showed up as a
 * failure because these tests only exercise the LIST paths, so the reserve /
 * consume / release branches are never reached — a stub can name anything at all
 * as long as nobody calls it. The moment one of those tests grew to cover a
 * cancel, it would have died on `releaseReservationInTx is not a function` and
 * looked like a bug in the service rather than in its double.
 *
 * Keep this list matching the real surface, not the calls a given test happens
 * to make. `check:mock-surface` compares the two and fails on a name the real
 * class does not have.
 */
const RESERVATION_STUB = {
  createReservationInTx: jest.fn(),
  consumeReservationsBatch: jest.fn(),
  releaseReservationInTx: jest.fn(),
};


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

function makeDb(rows: unknown[] = []) {
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
    execute: jest.fn().mockResolvedValue(rows),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]), returning: jest.fn().mockResolvedValue([]) }) }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]), onConflictDoNothing: jest.fn().mockResolvedValue([]) }) }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  } as unknown as Db;
  return { db, findMany, findFirst, selectWhere };
}

const cache = {
  cached: jest.fn().mockImplementation(async (_k: string, fn: () => unknown) => fn()),
  cachedVersioned: jest.fn().mockImplementation(async (_ns: string, _h: string, fn: () => unknown) => fn()),
  invalidate: jest.fn(),
  invalidateNamespace: jest.fn(),
};

const warehouseScope = {
  forUser: jest.fn().mockResolvedValue({
    key: "all",
    isEmpty: false,
    unrestricted: true,
    warehouse: () => ({ queryChunks: [] }),
    location: () => ({ queryChunks: [] }),
    anyOf: () => ({ queryChunks: [] }),
  }),
  scopeKey: jest.fn().mockReturnValue("all"),
  resolve: jest.fn().mockResolvedValue(null),
  locationPredicate: jest.fn().mockReturnValue({ queryChunks: [] }),
  warehousePredicate: jest.fn().mockReturnValue({ queryChunks: [] }),
  warehouseIdList: jest.fn().mockReturnValue(null),
};

describe("InvStockService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes stock level query to the org (isolation — deny for foreign org)", async () => {
    const { db } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvStockService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: WarehouseScopeService, useValue: warehouseScope },
        { provide: CostVisibilityService, useValue: { canSeeCost: jest.fn().mockResolvedValue(false) } },
      ],
    }).compile().then((m) => m.get(InvStockService));

    const result = await svc.listStockLevels(ATTACKER, "user-1", { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
  });

  it("returns stock levels for the owning org (isolation — control)", async () => {
    /*
     * The joined row `listStockLevels` now projects. It used to be the driver's
     * raw `{ on_hand, org_id }` -- the snake_case payload that reached the
     * browser as `NaN` in every quantity column and a dash for every name.
     */
    const ROW = {
      id: 1,
      onHand: "100",
      committed: "0",
      onOrder: "0",
      available: "100",
      blockedQty: "0",
      qualityHoldQty: "0",
      averageCost: null,
      productVariant: { id: 5, name: "V", sku: "SKU-1", productId: 9, productName: "P", productSku: "P-1", reorderPoint: "0" },
      location: { id: 3, name: "Bin", code: "B-1", warehouseId: 2, warehouseName: "WH" },
    };
    const { db } = makeDb([ROW]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvStockService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: WarehouseScopeService, useValue: warehouseScope },
        { provide: CostVisibilityService, useValue: { canSeeCost: jest.fn().mockResolvedValue(false) } },
      ],
    }).compile().then((m) => m.get(InvStockService));

    const result = await svc.listStockLevels(OWNER, "user-1", { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("InvStockAdjustmentsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty adjustments for a foreign org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvStockAdjustmentsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: InventorySettingsService, useValue: { get: jest.fn().mockResolvedValue({}) } },
        { provide: WarehouseScopeService, useValue: warehouseScope },
      ],
    }).compile().then((m) => m.get(InvStockAdjustmentsService));

    const result = await svc.listAdjustments(ATTACKER, { page: 1, limit: 20 }, "all", "user-1");
    expect(result.items).toHaveLength(0);
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns adjustments for the owning org (isolation — control)", async () => {
    const ADJ = { id: 1, orgId: OWNER, number: "ADJ-0001" };
    const { db } = makeDb([ADJ]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvStockAdjustmentsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: InventorySettingsService, useValue: { get: jest.fn().mockResolvedValue({}) } },
        { provide: WarehouseScopeService, useValue: warehouseScope },
      ],
    }).compile().then((m) => m.get(InvStockAdjustmentsService));

    const result = await svc.listAdjustments(OWNER, { page: 1, limit: 20 }, "all", "user-1");
    expect(result.items).toHaveLength(1);
  });
});

describe("InvStockTransfersService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty transfers for a foreign org (isolation — deny)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvStockTransfersService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: ReservationService, useValue: RESERVATION_STUB },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: WarehouseScopeService, useValue: warehouseScope },
      ],
    }).compile().then((m) => m.get(InvStockTransfersService));

    const result = await svc.listTransfers(ATTACKER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("returns transfers for the owning org (isolation — control)", async () => {
    const TRF = { id: 1, orgId: OWNER, number: "TRF-0001" };
    const { db } = makeDb([TRF]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvStockTransfersService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: ReservationService, useValue: RESERVATION_STUB },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: WarehouseScopeService, useValue: warehouseScope },
      ],
    }).compile().then((m) => m.get(InvStockTransfersService));

    const result = await svc.listTransfers(OWNER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("InvStockReservationsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes reservation listing to the org (isolation — deny)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvStockReservationsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: ReservationService, useValue: RESERVATION_STUB },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
      ],
    }).compile().then((m) => m.get(InvStockReservationsService));

    const result = await svc.listReservations(ATTACKER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("returns reservations for the owning org (isolation — control)", async () => {
    const RES = { id: 1, orgId: OWNER, productVariant: { id: 1, sku: "SKU-1", name: "Var" } };
    const { db } = makeDb([RES]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvStockReservationsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: ReservationService, useValue: RESERVATION_STUB },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
      ],
    }).compile().then((m) => m.get(InvStockReservationsService));

    const result = await svc.listReservations(OWNER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("ShipmentsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty shipments for a foreign org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        ShipmentsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
        { provide: InventorySettingsService, useValue: { get: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile().then((m) => m.get(ShipmentsService));

    const result = await svc.list(ATTACKER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    expect(selectWhere).toHaveBeenCalled();
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns shipments for the owning org (isolation — control)", async () => {
    const SHP = { id: 1, orgId: OWNER, shipmentNumber: "SHP-0001" };
    const { db } = makeDb([SHP]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        ShipmentsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
        { provide: InventorySettingsService, useValue: { get: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile().then((m) => m.get(ShipmentsService));

    const result = await svc.list(OWNER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("LoadsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes load list to the org (isolation — deny for foreign org)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        LoadsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
      ],
    }).compile().then((m) => m.get(LoadsService));

    const result = await svc.list(ATTACKER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns loads for the owning org (isolation — control)", async () => {
    const LOAD = { id: 1, orgId: OWNER, loadNumber: "LOAD-0001" };
    const { db } = makeDb([LOAD]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        LoadsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
      ],
    }).compile().then((m) => m.get(LoadsService));

    const result = await svc.list(OWNER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("PackagesService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty packages for a foreign org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        PackagesService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
      ],
    }).compile().then((m) => m.get(PackagesService));

    const result = await svc.list(ATTACKER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns packages for the owning org (isolation — control)", async () => {
    const PKG = { id: 1, orgId: OWNER, packageNumber: "PKG-0001" };
    const { db } = makeDb([PKG]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        PackagesService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
      ],
    }).compile().then((m) => m.get(PackagesService));

    const result = await svc.list(OWNER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("CarriersService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes carrier list to the org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        CarriersService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
      ],
    }).compile().then((m) => m.get(CarriersService));

    const result = await svc.list(ATTACKER);
    expect(result).toHaveLength(0);
    expect(selectWhere).toHaveBeenCalled();
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns carriers for the owning org (isolation — control)", async () => {
    const CARRIER = { id: 1, orgId: OWNER, name: "FedEx" };
    const { db } = makeDb([CARRIER]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        CarriersService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
      ],
    }).compile().then((m) => m.get(CarriersService));

    const result = await svc.list(OWNER);
    expect(result).toHaveLength(1);
  });
});

describe("CustomerReturnsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty customer returns for a foreign org (isolation — deny)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        CustomerReturnsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
      ],
    }).compile().then((m) => m.get(CustomerReturnsService));

    const result = await svc.list(ATTACKER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("returns customer returns for the owning org (isolation — control)", async () => {
    const CRET = { id: 1, orgId: OWNER, returnNumber: "CRET-0001" };
    const { db } = makeDb([CRET]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        CustomerReturnsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
      ],
    }).compile().then((m) => m.get(CustomerReturnsService));

    const result = await svc.list(OWNER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("VendorReturnsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty vendor returns for a foreign org (isolation — deny)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        VendorReturnsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
      ],
    }).compile().then((m) => m.get(VendorReturnsService));

    const result = await svc.list(ATTACKER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("returns vendor returns for the owning org (isolation — control)", async () => {
    const VRET = { id: 1, orgId: OWNER, returnNumber: "VRET-0001" };
    const { db } = makeDb([VRET]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        VendorReturnsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
      ],
    }).compile().then((m) => m.get(VendorReturnsService));

    const result = await svc.list(OWNER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});
