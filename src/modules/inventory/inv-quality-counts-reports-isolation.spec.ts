import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { HoldsService } from "./quality/quality-holds.service";
import { InspectionsService } from "./quality/quality-inspections.service";
import { RecallsService } from "./quality/quality-recalls.service";
import { InvCycleCountsService } from "./counts/inv-cycle-counts.service";
import { InvPhysicalAuditsService } from "./counts/inv-physical-audits.service";
import { InvReportsService } from "./reports/inv-reports.service";
import { InvReportsExtendedService } from "./reports/inv-reports-extended.service";
import { CacheService } from "../../common/cache/cache.service";
import { WarehouseScopeService } from "./stock-engine/warehouse-scope.service";
import { StockEngineService } from "./stock-engine/stock-engine.service";
import { StockEngineBatchService } from "./stock-engine/stock-engine-batch.service";
import { NumberSequenceService } from "./stock-engine/number-sequence.service";
import { InventoryAuditService } from "./stock-engine/inventory-audit.service";
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

function makeDb(rows: unknown[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
  const handler = { findMany, findFirst };
  const selectWhere = jest.fn().mockResolvedValue(rows);
  const selectFrom = jest.fn().mockReturnValue({ where: selectWhere, orderBy: jest.fn().mockResolvedValue(rows), innerJoin: jest.fn().mockReturnThis() });
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

describe("HoldsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty quality holds for a foreign org (isolation — deny)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        HoldsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: WarehouseScopeService, useValue: warehouseScope },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
      ],
    }).compile().then((m) => m.get(HoldsService));

    const result = await svc.list(ATTACKER, "user-1", { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("returns quality holds for the owning org (isolation — control)", async () => {
    const HOLD = { id: 1, orgId: OWNER, status: "ACTIVE" };
    const { db } = makeDb([HOLD]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        HoldsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: WarehouseScopeService, useValue: warehouseScope },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
      ],
    }).compile().then((m) => m.get(HoldsService));

    const result = await svc.list(OWNER, "user-1", { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("InspectionsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty inspections for a foreign org (isolation — deny)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InspectionsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
      ],
    }).compile().then((m) => m.get(InspectionsService));

    const result = await svc.list(ATTACKER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("returns inspections for the owning org (isolation — control)", async () => {
    const INS = { id: 1, orgId: OWNER, number: "QI-0001" };
    const { db } = makeDb([INS]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InspectionsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
      ],
    }).compile().then((m) => m.get(InspectionsService));

    const result = await svc.list(OWNER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("RecallsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty recalls for a foreign org (isolation — deny)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        RecallsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineBatchService, useValue: { executeMany: jest.fn().mockResolvedValue([]) } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
      ],
    }).compile().then((m) => m.get(RecallsService));

    const result = await svc.list(ATTACKER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("returns recalls for the owning org (isolation — control)", async () => {
    const RCL = { id: 1, orgId: OWNER, number: "RCL-0001" };
    const { db } = makeDb([RCL]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        RecallsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineBatchService, useValue: { executeMany: jest.fn().mockResolvedValue([]) } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
        { provide: InventoryAuditService, useValue: { insert: jest.fn() } },
      ],
    }).compile().then((m) => m.get(RecallsService));

    const result = await svc.list(OWNER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("InvCycleCountsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty cycle counts for a foreign org (isolation — deny)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvCycleCountsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: WarehouseScopeService, useValue: warehouseScope },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
      ],
    }).compile().then((m) => m.get(InvCycleCountsService));

    const result = await svc.listCycleCounts(ATTACKER, "user-1", { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("returns cycle counts for the owning org (isolation — control)", async () => {
    const CC = { id: 1, orgId: OWNER, number: "CC-0001" };
    const { db } = makeDb([CC]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvCycleCountsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: WarehouseScopeService, useValue: warehouseScope },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
      ],
    }).compile().then((m) => m.get(InvCycleCountsService));

    const result = await svc.listCycleCounts(OWNER, "user-1", { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("InvPhysicalAuditsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty physical audits for a foreign org (isolation — deny)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvPhysicalAuditsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: WarehouseScopeService, useValue: warehouseScope },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
      ],
    }).compile().then((m) => m.get(InvPhysicalAuditsService));

    const result = await svc.listAudits(ATTACKER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("returns physical audits for the owning org (isolation — control)", async () => {
    const PA = { id: 1, orgId: OWNER, number: "PA-0001" };
    const { db } = makeDb([PA]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvPhysicalAuditsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: WarehouseScopeService, useValue: warehouseScope },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
        { provide: NumberSequenceService, useValue: { next: jest.fn() } },
      ],
    }).compile().then((m) => m.get(InvPhysicalAuditsService));

    const result = await svc.listAudits(OWNER, USER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});

describe("InvReportsService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes dashboard query to the org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvReportsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: WarehouseScopeService, useValue: warehouseScope },
        { provide: InvReportsExtendedService, useValue: { getDashboardExtras: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile().then((m) => m.get(InvReportsService));

    const result = await svc.getDashboard(ATTACKER, "user-1");
    expect(result).toBeDefined();
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("returns dashboard for the owning org (isolation — control)", async () => {
    const { db } = makeDb([{ count: 5 }]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvReportsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: WarehouseScopeService, useValue: warehouseScope },
        { provide: InvReportsExtendedService, useValue: { getDashboardExtras: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile().then((m) => m.get(InvReportsService));

    const result = await svc.getDashboard(OWNER, "user-1");
    expect(result).toBeDefined();
  });
});

describe("InvReportsExtendedService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("scopes extended dashboard query to the org (isolation — deny)", async () => {
    const { db, selectWhere } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvReportsExtendedService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: WarehouseScopeService, useValue: warehouseScope },
      ],
    }).compile().then((m) => m.get(InvReportsExtendedService));

    await svc.getDashboardExtras(ATTACKER, "user-1");
    const whereArg = selectWhere.mock.calls[0]?.[0] as unknown;
    expect(sqlValues(whereArg)).toContain(ATTACKER);
  });

  it("runs extended dashboard for the owning org (isolation — control)", async () => {
    const { db } = makeDb([{ count: 3 }]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvReportsExtendedService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: WarehouseScopeService, useValue: warehouseScope },
      ],
    }).compile().then((m) => m.get(InvReportsExtendedService));

    const result = await svc.getDashboardExtras(OWNER, "user-1");
    expect(result).toBeDefined();
  });
});
