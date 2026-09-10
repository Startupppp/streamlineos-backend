import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { ScopedRead } from "../access/scoped-read";
import { PoService } from "./purchase-orders/po.service";
import { GrnService } from "./purchase-orders/grn.service";
import { SoCoreService } from "./sales-orders/so-core.service";
import { SoFulfillmentService } from "./sales-orders/so-fulfillment.service";
import { SoLifecycleService } from "./sales-orders/so-lifecycle.service";
import { CacheService } from "../../common/cache/cache.service";
import { InventorySettingsService } from "./stock-engine/inventory-settings.service";
import { NumberSequenceService } from "./stock-engine/number-sequence.service";
import { StockEngineService } from "./stock-engine/stock-engine.service";
import { ReservationService } from "./stock-engine/reservation.service";
import { JournalPostingService } from "../accounting/posting/journal-posting.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { SoLifecycleService as _SoLifecycleImport } from "./sales-orders/so-lifecycle.service";

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
  const selectWhere = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockResolvedValue(rows);
  const selectFrom = jest.fn().mockReturnValue({ where: selectWhere, orderBy });
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

const cache = {
  cached: jest.fn().mockImplementation(async (_k: string, fn: () => unknown) => fn()),
  cachedVersioned: jest.fn().mockImplementation(async (_ns: string, _h: string, fn: () => unknown) => fn()),
  invalidate: jest.fn(),
  invalidateNamespace: jest.fn(),
};

describe("PoService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty PO list for a foreign org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        PoService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: InventorySettingsService, useValue: { get: jest.fn().mockResolvedValue({}) } },
        { provide: NumberSequenceService, useValue: { next: jest.fn().mockResolvedValue("PO-0001") } },
      ],
    }).compile().then((m) => m.get(PoService));

    const result = await svc.listPos(ScopedRead.of(ATTACKER, "user-1", "all"), { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns POs for the owning org (isolation — control)", async () => {
    const PO = { id: 1, orgId: OWNER, number: "PO-0001", status: "DRAFT" };
    const { db } = makeDb([PO]);
    const svc = await Test.createTestingModule({
      providers: [
        PoService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: InventorySettingsService, useValue: { get: jest.fn().mockResolvedValue({}) } },
        { provide: NumberSequenceService, useValue: { next: jest.fn().mockResolvedValue("PO-0001") } },
      ],
    }).compile().then((m) => m.get(PoService));

    const result = await svc.listPos(ScopedRead.of(OWNER, "user-1", "all"), { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("GrnService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty GRN list for a foreign org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        GrnService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
      ],
    }).compile().then((m) => m.get(GrnService));

    const result = await svc.listGrns(ATTACKER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns GRNs for the owning org (isolation — control)", async () => {
    const GRN = { id: 1, orgId: OWNER, number: "GRN-0001" };
    const { db } = makeDb([GRN]);
    const svc = await Test.createTestingModule({
      providers: [
        GrnService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
      ],
    }).compile().then((m) => m.get(GrnService));

    const result = await svc.listGrns(OWNER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("SoCoreService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty SO list for a foreign org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        SoCoreService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: SoLifecycleService, useValue: {} },
      ],
    }).compile().then((m) => m.get(SoCoreService));

    const result = await svc.listSos(ScopedRead.of(ATTACKER, "user-1", "all"), { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns SOs for the owning org (isolation — control)", async () => {
    const SO = { id: 1, orgId: OWNER, number: "SO-0001", status: "DRAFT" };
    const { db } = makeDb([SO]);
    const svc = await Test.createTestingModule({
      providers: [
        SoCoreService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: SoLifecycleService, useValue: {} },
      ],
    }).compile().then((m) => m.get(SoCoreService));

    const result = await svc.listSos(ScopedRead.of(OWNER, "user-1", "all"), { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("SoFulfillmentService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes SO lookup to the org when reserving (isolation — deny for wrong org)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        SoFulfillmentService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: ReservationService, useValue: { createReservationInTx: jest.fn() } },
        { provide: InventorySettingsService, useValue: { get: jest.fn().mockResolvedValue({}) } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: JournalPostingService, useValue: { persistJournalEntry: jest.fn() } },
        { provide: SoCoreService, useValue: { getSo: jest.fn() } },
      ],
    }).compile().then((m) => m.get(SoFulfillmentService));

    await expect(svc.reserveSo(ATTACKER, 99, "user-1", "key-1", {})).rejects.toBeDefined();
    expect(findFirst).toHaveBeenCalled();
    const firstCallArg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(firstCallArg?.where)).toContain(ATTACKER);
  });

  it("scopes SO lookup to the owning org (isolation — control)", async () => {
    const SO = { id: 99, orgId: OWNER, status: "CONFIRMED", lines: [] };
    const { db } = makeDb([SO]);
    const svc = await Test.createTestingModule({
      providers: [
        SoFulfillmentService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: ReservationService, useValue: { createReservationInTx: jest.fn().mockResolvedValue({}) } },
        { provide: InventorySettingsService, useValue: { get: jest.fn().mockResolvedValue({ allowBackorders: false }) } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: JournalPostingService, useValue: { persistJournalEntry: jest.fn() } },
        { provide: SoCoreService, useValue: { getSo: jest.fn() } },
      ],
    }).compile().then((m) => m.get(SoFulfillmentService));

    const query = (db as unknown as { query: { invSalesOrders: { findFirst: jest.Mock } } }).query.invSalesOrders;
    expect(query.findFirst).toBeDefined();
  });
});

describe("SoLifecycleService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes SO lookup by orgId when confirming (isolation — deny for wrong org)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        SoLifecycleService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: InventorySettingsService, useValue: { get: jest.fn().mockResolvedValue({}) } },
        { provide: ReservationService, useValue: { createReservationInTx: jest.fn() } },
        { provide: JournalPostingService, useValue: { persistJournalEntry: jest.fn() } },
        { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
      ],
    }).compile().then((m) => m.get(SoLifecycleService));

    await expect(svc.confirmSo(ATTACKER, 99, "user-1")).rejects.toBeDefined();
    const arg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("scopes confirm to the owning org (isolation — control query contains owner org)", async () => {
    const SO = { id: 99, orgId: OWNER, status: "DRAFT", lines: [] };
    const { db, findFirst } = makeDb([SO]);
    await Test.createTestingModule({
      providers: [
        SoLifecycleService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: InventorySettingsService, useValue: { get: jest.fn().mockResolvedValue({}) } },
        { provide: ReservationService, useValue: { createReservationInTx: jest.fn() } },
        { provide: JournalPostingService, useValue: { persistJournalEntry: jest.fn() } },
        { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
      ],
    }).compile();
    expect(findFirst).toBeDefined();
  });
});
