import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { InvValuationService } from "./valuation/inv-valuation.service";
import { InvTraceabilityService } from "./traceability/inv-traceability.service";
import { TraceabilityChainService } from "./traceability/traceability-chain.service";
import { InventoryWebhookEmitter } from "./webhooks/webhook-emitter.service";
import { WebhooksService } from "./webhooks/webhooks.service";
import { CacheService } from "../../common/cache/cache.service";
import { InventoryAuditService } from "./stock-engine/inventory-audit.service";
import { WarehouseScopeService } from "./stock-engine/warehouse-scope.service";

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
