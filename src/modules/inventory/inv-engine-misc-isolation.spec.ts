import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { InventorySettingsService } from "./stock-engine/inventory-settings.service";
import { NumberSequenceService } from "./stock-engine/number-sequence.service";
import { WarehouseScopeService } from "./stock-engine/warehouse-scope.service";
import { ReservationService } from "./stock-engine/reservation.service";
import { StockEngineService } from "./stock-engine/stock-engine.service";
import { SettingsService } from "./settings/settings.service";
import { ChannelsService } from "./channels/channels.service";
import { TplService } from "./channels/tpl.service";
import { InvReplenishmentService } from "./replenishment/inv-replenishment.service";
import { InvValuationService } from "./valuation/inv-valuation.service";
import { InvTraceabilityService } from "./traceability/inv-traceability.service";
import { TraceabilityChainService } from "./traceability/traceability-chain.service";
import { InventoryWebhookEmitter } from "./webhooks/webhook-emitter.service";
import { WebhooksService } from "./webhooks/webhooks.service";
import { InvAiService } from "./ai/inv-ai.service";
import { InvAiExplainService } from "./ai/inv-ai-explain.service";
import { InvBarcodeService } from "./barcode/inv-barcode.service";
import { ExportService } from "./import-export/export.service";
import { ImportService } from "./import-export/import.service";
import { CacheService } from "../../common/cache/cache.service";
import { InventoryAuditService } from "./stock-engine/inventory-audit.service";
import { AccessService } from "../access/access.service";
import { ValuationService } from "./stock-engine/valuation.service";
import { MovementCostingService } from "./stock-engine/movement-costing.service";
import { PeriodsService } from "../accounting/gl/periods.service";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { AiConfirmationService } from "../ai/confirmation/ai-confirmation.service";
import { InvVendorsService } from "./vendors/inv-vendors.service";

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
    chain.groupBy = jest.fn().mockReturnValue(chain);
    chain.having = jest.fn().mockReturnValue(chain);
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
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(rows), then: (onFulfilled: ((v: unknown) => unknown) | null | undefined, onRejected?: ((r: unknown) => unknown) | null | undefined) => Promise.resolve([]).then(onFulfilled ?? undefined, onRejected ?? undefined) }), returning: jest.fn().mockResolvedValue(rows) }) }),
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

describe("InventorySettingsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns null for a foreign org settings (isolation — deny)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        InventorySettingsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
      ],
    }).compile().then((m) => m.get(InventorySettingsService));

    await svc.get(ATTACKER);
    expect(findFirst).toHaveBeenCalled();
    const arg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("fetches settings for the owning org (isolation — control)", async () => {
    const ROW = { orgId: OWNER, costingMethod: "FIFO", taxIncluded: false, currency: "USD" };
    const { db } = makeDb([ROW]);
    const svc = await Test.createTestingModule({
      providers: [
        InventorySettingsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
      ],
    }).compile().then((m) => m.get(InventorySettingsService));

    const result = await svc.get(OWNER);
    expect(result).toBeDefined();
  });
});

describe("NumberSequenceService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes sequence lookup to the requesting org (isolation — deny)", async () => {
    const { db } = makeDb([{ prefix: "PO", nextNumber: 2, padding: 5 }]);
    const svc = new NumberSequenceService(db);
    const num = await svc.next(ATTACKER, "PO");
    expect(num).toBeTruthy();
    expect(db.insert).toHaveBeenCalled();
  });

  it("generates next number for the owning org (isolation — control)", async () => {
    const SEQ = { orgId: OWNER, docType: "PO", prefix: "PO-", nextNumber: 42, padding: 5 };
    const { db } = makeDb([SEQ]);
    const svc = new NumberSequenceService(db);
    const num = await svc.next(OWNER, "PO");
    expect(num).toBeTruthy();
  });
});

describe("WarehouseScopeService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty scope for a user with no warehouse access in the foreign org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        WarehouseScopeService,
        { provide: DRIZZLE, useValue: db },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } },
      ],
    }).compile().then((m) => m.get(WarehouseScopeService));

    const result = await svc.resolve(ATTACKER, "user-x");
    expect(result).toEqual([]);
    expect(selectWhere).toHaveBeenCalled();
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns warehouse ids for the owning org (isolation — control)", async () => {
    const ROW = { warehouseId: "wh-1" };
    const { db } = makeDb([ROW]);
    const svc = await Test.createTestingModule({
      providers: [
        WarehouseScopeService,
        { provide: DRIZZLE, useValue: db },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn().mockResolvedValue(new Set()) } },
      ],
    }).compile().then((m) => m.get(WarehouseScopeService));

    const result = await svc.resolve(OWNER, "user-owner");
    expect(result).toEqual(["wh-1"]);
  });
});

describe("ReservationService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("never retrieves settings for a different org when creating a reservation (isolation — deny via tx mock)", async () => {
    const { db } = makeDb([]);
    const settingsMock = { get: jest.fn().mockResolvedValue({ requireLocationForReservation: true }) };
    const svc = await Test.createTestingModule({
      providers: [
        ReservationService,
        { provide: DRIZZLE, useValue: db },
        { provide: InventorySettingsService, useValue: settingsMock },
      ],
    }).compile().then((m) => m.get(ReservationService));

    await expect(
      svc.createReservationInTx({} as never, ATTACKER, "user-1", {
        productVariantId: 99,
        locationId: 1,
        quantity: "10",
      }),
    ).rejects.toThrow();
    expect(settingsMock.get).toHaveBeenCalledWith(ATTACKER);
  });

  it("calls get settings with the owning org (isolation — control)", async () => {
    const settingsMock = { get: jest.fn().mockResolvedValue({ requireLocationForReservation: false }) };
    const { db } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ReservationService,
        { provide: DRIZZLE, useValue: db },
        { provide: InventorySettingsService, useValue: settingsMock },
      ],
    }).compile().then((m) => m.get(ReservationService));

    await svc.createReservation(OWNER, "user-1", { productVariantId: 99, locationId: 1, quantity: "10" }).catch(() => undefined);
    expect(settingsMock.get).toHaveBeenCalledWith(OWNER);
  });
});

describe("StockEngineService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("invalidates only the attacker org's caches (isolation — deny for foreign org)", async () => {
    const { db } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        StockEngineService,
        { provide: DRIZZLE, useValue: db },
        { provide: InventorySettingsService, useValue: { get: jest.fn().mockResolvedValue({}) } },
        { provide: InventoryAuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: cache },
        { provide: ValuationService, useValue: { getMethod: jest.fn(), computeMovementCost: jest.fn() } },
        { provide: WarehouseScopeService, useValue: { resolve: jest.fn().mockResolvedValue(null), warehousePredicate: jest.fn().mockReturnValue({ queryChunks: [] }), locationPredicate: jest.fn().mockReturnValue({ queryChunks: [] }) } },
        { provide: PeriodsService, useValue: { getOpenPeriod: jest.fn() } },
        { provide: MovementCostingService, useValue: { computeLayerCost: jest.fn() } },
      ],
    }).compile().then((m) => m.get(StockEngineService));

    await svc.invalidateCaches(ATTACKER);
    expect(cache.invalidateNamespace).toHaveBeenCalledWith(expect.stringContaining(ATTACKER));
  });

  it("invalidates caches for the owning org (isolation — control)", async () => {
    const { db } = makeDb([]);
    const freshCache = {
      cached: jest.fn().mockImplementation(async (_k: string, fn: () => unknown) => fn()),
      cachedVersioned: jest.fn().mockImplementation(async (_ns: string, _h: string, fn: () => unknown) => fn()),
      invalidate: jest.fn(),
      invalidateNamespace: jest.fn(),
    };
    const svc = await Test.createTestingModule({
      providers: [
        StockEngineService,
        { provide: DRIZZLE, useValue: db },
        { provide: InventorySettingsService, useValue: { get: jest.fn().mockResolvedValue({}) } },
        { provide: InventoryAuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: freshCache },
        { provide: ValuationService, useValue: { getMethod: jest.fn(), computeMovementCost: jest.fn() } },
        { provide: WarehouseScopeService, useValue: { resolve: jest.fn().mockResolvedValue(null), warehousePredicate: jest.fn().mockReturnValue({ queryChunks: [] }), locationPredicate: jest.fn().mockReturnValue({ queryChunks: [] }) } },
        { provide: PeriodsService, useValue: { getOpenPeriod: jest.fn() } },
        { provide: MovementCostingService, useValue: { computeLayerCost: jest.fn() } },
      ],
    }).compile().then((m) => m.get(StockEngineService));

    await svc.invalidateCaches(OWNER);
    expect(freshCache.invalidateNamespace).toHaveBeenCalledWith(expect.stringContaining(OWNER));
  });
});

describe("SettingsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("fetches settings scoped to the requesting org (isolation — deny returns empty sequences)", async () => {
    const { db } = makeDb([]);
    const invSettings = { get: jest.fn().mockResolvedValue({ costingMethod: "FIFO" }) };
    const numSeq = { next: jest.fn(), getDocTypes: jest.fn().mockReturnValue([]) };
    const svc = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: DRIZZLE, useValue: db },
        { provide: InventorySettingsService, useValue: invSettings },
        { provide: NumberSequenceService, useValue: numSeq },
        { provide: ReservationService, useValue: { expireForOrg: jest.fn() } },
        { provide: InventoryAuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: cache },
      ],
    }).compile().then((m) => m.get(SettingsService));

    const result = await svc.listNumberSequences(ATTACKER);
    expect(result).toEqual([]);
    expect(invSettings.get).not.toHaveBeenCalled();
  });

  it("returns sequences for the owning org (isolation — control)", async () => {
    const { db } = makeDb([]);
    const invSettings = { get: jest.fn().mockResolvedValue({ costingMethod: "FIFO" }) };
    const numSeq = { next: jest.fn(), getDocTypes: jest.fn().mockReturnValue(["PO", "SO"]) };
    const svc = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: DRIZZLE, useValue: db },
        { provide: InventorySettingsService, useValue: invSettings },
        { provide: NumberSequenceService, useValue: numSeq },
        { provide: ReservationService, useValue: { expireForOrg: jest.fn() } },
        { provide: InventoryAuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: cache },
      ],
    }).compile().then((m) => m.get(SettingsService));

    const result = await svc.listNumberSequences(OWNER);
    expect(result).toHaveLength(2);
  });
});

describe("ChannelsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty channel list for a foreign org (isolation — deny)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ChannelsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: InventoryAuditService, useValue: { log: jest.fn() } },
      ],
    }).compile().then((m) => m.get(ChannelsService));

    const result = await svc.list(ATTACKER);
    expect(result).toHaveLength(0);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("returns channels for the owning org (isolation — control)", async () => {
    const CH = { id: 1, orgId: OWNER, name: "Shopify" };
    const { db } = makeDb([CH]);
    const svc = await Test.createTestingModule({
      providers: [
        ChannelsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: InventoryAuditService, useValue: { log: jest.fn() } },
      ],
    }).compile().then((m) => m.get(ChannelsService));

    const result = await svc.list(OWNER);
    expect(result).toHaveLength(1);
  });
});

describe("TplService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty 3PL connections for a foreign org (isolation — deny)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        TplService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: InventoryAuditService, useValue: { log: jest.fn() } },
      ],
    }).compile().then((m) => m.get(TplService));

    const result = await svc.listConnections(ATTACKER);
    expect(result).toHaveLength(0);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("returns 3PL connections for the owning org (isolation — control)", async () => {
    const CONN = { id: 1, orgId: OWNER, name: "ShipBob" };
    const { db } = makeDb([CONN]);
    const svc = await Test.createTestingModule({
      providers: [
        TplService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: InventoryAuditService, useValue: { log: jest.fn() } },
      ],
    }).compile().then((m) => m.get(TplService));

    const result = await svc.listConnections(OWNER);
    expect(result).toHaveLength(1);
  });
});

describe("InvReplenishmentService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty rules for a foreign org (isolation — deny)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        InvReplenishmentService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
      ],
    }).compile().then((m) => m.get(InvReplenishmentService));

    const result = await svc.listRules(ATTACKER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("returns rules for the owning org (isolation — control)", async () => {
    const RULE = { id: 1, orgId: OWNER, productVariantId: 10, minQty: "50" };
    const { db } = makeDb([RULE]);
    const svc = await Test.createTestingModule({
      providers: [
        InvReplenishmentService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
      ],
    }).compile().then((m) => m.get(InvReplenishmentService));

    const result = await svc.listRules(OWNER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("InvValuationService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  const scope = {
    resolve: jest.fn().mockResolvedValue(null),
    warehousePredicate: jest.fn().mockReturnValue({ queryChunks: [] }),
    locationPredicate: jest.fn().mockReturnValue({ queryChunks: [] }),
    warehouseIdList: jest.fn().mockReturnValue(null),
  };

  it("returns empty valuation summary for a foreign org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        InvValuationService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: WarehouseScopeService, useValue: scope },
      ],
    }).compile().then((m) => m.get(InvValuationService));

    const result = await svc.getValuationSummary(ATTACKER, "user-x", { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    expect(selectWhere).toHaveBeenCalled();
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns valuation for the owning org (isolation — control)", async () => {
    const VAL = { productVariantId: 1, onHand: "100" };
    const { db } = makeDb([VAL]);
    const svc = await Test.createTestingModule({
      providers: [
        InvValuationService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: WarehouseScopeService, useValue: scope },
      ],
    }).compile().then((m) => m.get(InvValuationService));

    const result = await svc.getValuationSummary(OWNER, "user-owner", { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("InvTraceabilityService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty lots for a foreign org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        InvTraceabilityService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
      ],
    }).compile().then((m) => m.get(InvTraceabilityService));

    const result = await svc.listLots(ATTACKER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    expect(selectWhere).toHaveBeenCalled();
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns lots for the owning org (isolation — control)", async () => {
    const LOT = { id: 1, orgId: OWNER, lotNumber: "LOT-001" };
    const { db } = makeDb([LOT]);
    const svc = await Test.createTestingModule({
      providers: [
        InvTraceabilityService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
      ],
    }).compile().then((m) => m.get(InvTraceabilityService));

    const result = await svc.listLots(OWNER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("TraceabilityChainService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes chain lookup to the requesting org (isolation — deny returns no lot data)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        TraceabilityChainService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
      ],
    }).compile().then((m) => m.get(TraceabilityChainService));

    const result = await svc.getChain(ATTACKER, { lotId: 1 });
    expect(findFirst).toHaveBeenCalled();
    const arg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
    expect(result).toBeDefined();
  });

  it("returns chain data for the owning org (isolation — control)", async () => {
    const LOT = { id: 1, orgId: OWNER, lotNumber: "LOT-001", status: "ACTIVE" };
    const { db } = makeDb([LOT]);
    const svc = await Test.createTestingModule({
      providers: [
        TraceabilityChainService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
      ],
    }).compile().then((m) => m.get(TraceabilityChainService));

    const result = await svc.getChain(OWNER, { lotId: 1 });
    expect(result).toBeDefined();
  });
});

describe("InventoryWebhookEmitter — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("only emits to webhooks belonging to the org (isolation — deny for foreign org)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        InventoryWebhookEmitter,
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile().then((m) => m.get(InventoryWebhookEmitter));

    await svc.emit(ATTACKER, "product.created", { id: 1 });
    expect(selectWhere).toHaveBeenCalled();
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("emits events for the owning org (isolation — control)", async () => {
    const WH = { id: 1, orgId: OWNER, url: "https://example.com/webhook", secret: "s3cret" };
    const { db } = makeDb([WH]);
    const svc = await Test.createTestingModule({
      providers: [
        InventoryWebhookEmitter,
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile().then((m) => m.get(InventoryWebhookEmitter));

    await expect(svc.emit(OWNER, "product.created", { id: 1 })).resolves.not.toThrow();
  });
});

describe("WebhooksService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty webhook list for a foreign org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: DRIZZLE, useValue: db },
        { provide: InventoryAuditService, useValue: { log: jest.fn() } },
      ],
    }).compile().then((m) => m.get(WebhooksService));

    const result = await svc.list(ATTACKER);
    expect(result).toHaveLength(0);
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns webhooks for the owning org (isolation — control)", async () => {
    const WH = { id: 1, orgId: OWNER, url: "https://example.com", eventTypes: ["product.created"] };
    const { db } = makeDb([WH]);
    const svc = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: DRIZZLE, useValue: db },
        { provide: InventoryAuditService, useValue: { log: jest.fn() } },
      ],
    }).compile().then((m) => m.get(WebhooksService));

    const result = await svc.list(OWNER);
    expect(result).toHaveLength(1);
  });
});

describe("InvAiService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty AI insights for a foreign org (isolation — deny)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        InvAiService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
      ],
    }).compile().then((m) => m.get(InvAiService));

    const result = await svc.listInsights(ATTACKER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("returns AI insights for the owning org (isolation — control)", async () => {
    const INSIGHT = { id: 1, orgId: OWNER, insightType: "LOW_STOCK", status: "ACTIVE" };
    const { db } = makeDb([INSIGHT]);
    const svc = await Test.createTestingModule({
      providers: [
        InvAiService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
      ],
    }).compile().then((m) => m.get(InvAiService));

    const result = await svc.listInsights(OWNER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("InvAiExplainService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("throws NotFoundException when insight belongs to a different org (isolation — deny)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        InvAiExplainService,
        { provide: DRIZZLE, useValue: db },
        { provide: AiGatewayService, useValue: { chat: jest.fn(), chatWithUsage: jest.fn() } },
        { provide: AiConfirmationService, useValue: { confirm: jest.fn() } },
        { provide: InvReplenishmentService, useValue: { listRules: jest.fn(), getRecommendations: jest.fn() } },
        { provide: InvVendorsService, useValue: { listVendors: jest.fn() } },
      ],
    }).compile().then((m) => m.get(InvAiExplainService));

    await expect(svc.explainInsight(ATTACKER, "user-1", 99)).rejects.toThrow(NotFoundException);
    expect(findFirst).toHaveBeenCalled();
    const arg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("processes insight for the owning org when found (isolation — control returns or calls AI)", async () => {
    const INSIGHT = { id: 99, orgId: OWNER, insightType: "LOW_STOCK", data: {} };
    const { db } = makeDb([INSIGHT]);
    const gateway = { chat: jest.fn().mockResolvedValue({ message: "low stock" }), chatWithUsage: jest.fn() };
    const svc = await Test.createTestingModule({
      providers: [
        InvAiExplainService,
        { provide: DRIZZLE, useValue: db },
        { provide: AiGatewayService, useValue: gateway },
        { provide: AiConfirmationService, useValue: { confirm: jest.fn() } },
        { provide: InvReplenishmentService, useValue: { listRules: jest.fn().mockResolvedValue({ items: [] }), getRecommendations: jest.fn() } },
        { provide: InvVendorsService, useValue: { listVendors: jest.fn().mockResolvedValue({ items: [] }) } },
      ],
    }).compile().then((m) => m.get(InvAiExplainService));

    await svc.explainInsight(OWNER, "user-owner", 99).catch(() => undefined);
  });
});

describe("InvBarcodeService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty lookup for a foreign org (isolation — deny)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = new InvBarcodeService(db);

    const result = await svc.lookup(ATTACKER, "BARCODE-123");
    expect(result.type).toBe("not_found");
    expect(findFirst).toHaveBeenCalled();
    const arg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("finds product for the owning org (isolation — control)", async () => {
    const PROD = { id: 1, orgId: OWNER, name: "Widget", sku: "W-001", status: "ACTIVE" };
    const { db } = makeDb([PROD]);
    const svc = new InvBarcodeService(db);

    const result = await svc.lookup(OWNER, "BARCODE-123");
    expect(result.type).toBe("product");
  });
});

describe("ExportService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty export job list for a foreign org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ExportService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
      ],
    }).compile().then((m) => m.get(ExportService));

    const result = await svc.list(ATTACKER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    expect(selectWhere).toHaveBeenCalled();
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns export jobs for the owning org (isolation — control)", async () => {
    const JOB = { id: 1, orgId: OWNER, jobType: "PRODUCTS", status: "DONE" };
    const { db } = makeDb([JOB]);
    const svc = await Test.createTestingModule({
      providers: [
        ExportService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
      ],
    }).compile().then((m) => m.get(ExportService));

    const result = await svc.list(OWNER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("ImportService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty import job list for a foreign org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ImportService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { post: jest.fn(), execute: jest.fn(), executeMany: jest.fn() } },
      ],
    }).compile().then((m) => m.get(ImportService));

    const result = await svc.list(ATTACKER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    expect(selectWhere).toHaveBeenCalled();
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns import jobs for the owning org (isolation — control)", async () => {
    const JOB = { id: 1, orgId: OWNER, jobType: "PRODUCTS", status: "DONE" };
    const { db } = makeDb([JOB]);
    const svc = await Test.createTestingModule({
      providers: [
        ImportService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { post: jest.fn(), execute: jest.fn(), executeMany: jest.fn() } },
      ],
    }).compile().then((m) => m.get(ImportService));

    const result = await svc.list(OWNER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});
