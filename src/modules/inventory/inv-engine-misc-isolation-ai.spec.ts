import { Test } from "@nestjs/testing";
import { sql } from "drizzle-orm";
import { NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { InvAiService } from "./ai/inv-ai.service";
import { InvAiExplainService } from "./ai/inv-ai-explain.service";
import { InvBarcodeService } from "./barcode/inv-barcode.service";
import { ExportService } from "./import-export/export.service";
import { ImportService } from "./import-export/import.service";
import { StockEngineService } from "./stock-engine/stock-engine.service";
import { CacheService } from "../../common/cache/cache.service";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { AiConfirmationService } from "../ai/confirmation/ai-confirmation.service";
import { InvReplenishmentService } from "./replenishment/inv-replenishment.service";
import { InvVendorsService } from "./vendors/inv-vendors.service";
import { INVENTORY_ISOLATION_STUBS } from "./__tests__/isolation-stubs";

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

describe("InvAiService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty AI insights for a foreign org (isolation — deny)", async () => {
    const { db, findMany } = makeDb([]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvAiService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
      ],
    }).compile().then((m) => m.get(InvAiService));

    const result = await svc.listInsights({ orgId: ATTACKER, userId: "user-1" } as never, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(0);
    const arg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("returns AI insights for the owning org (isolation — control)", async () => {
    const INSIGHT = { id: 1, orgId: OWNER, insightType: "LOW_STOCK", status: "ACTIVE" };
    const { db } = makeDb([INSIGHT]);
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvAiService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
      ],
    }).compile().then((m) => m.get(InvAiService));

    const result = await svc.listInsights({ orgId: OWNER, userId: "user-1" } as never, { page: 1, limit: 20 });
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
        ...INVENTORY_ISOLATION_STUBS,
        InvAiExplainService,
        { provide: DRIZZLE, useValue: db },
        { provide: AiGatewayService, useValue: { invokeText: jest.fn(), invokeTextWithUsage: jest.fn() } },
        { provide: AiConfirmationService, useValue: { confirm: jest.fn() } },
        { provide: InvReplenishmentService, useValue: { listRules: jest.fn(), getSuggestions: jest.fn() } },
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
    const gateway = { invokeText: jest.fn().mockResolvedValue({ ok: true, data: "low stock" }), invokeTextWithUsage: jest.fn() };
    const svc = await Test.createTestingModule({
      providers: [
        ...INVENTORY_ISOLATION_STUBS,
        InvAiExplainService,
        { provide: DRIZZLE, useValue: db },
        { provide: AiGatewayService, useValue: gateway },
        { provide: AiConfirmationService, useValue: { confirm: jest.fn() } },
        { provide: InvReplenishmentService, useValue: { listRules: jest.fn().mockResolvedValue({ items: [] }), getSuggestions: jest.fn() } },
        { provide: InvVendorsService, useValue: { listVendors: jest.fn().mockResolvedValue({ items: [] }) } },
      ],
    }).compile().then((m) => m.get(InvAiExplainService));

    await svc.explainInsight(OWNER, "user-owner", 99).catch(() => undefined);
  });
});

/**
 * Unrestricted: these pin the *tenant* boundary, and a warehouse scope that
 * filtered as well would let a lookup return nothing for the right reason and
 * still pass.
 */
const UNRESTRICTED_WAREHOUSE_SCOPE = {
  resolve: async () => null,
  warehousePredicate: () => sql`TRUE`,
};

describe("InvBarcodeService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";

  it("returns empty lookup for a foreign org (isolation — deny)", async () => {
    const { db, findFirst } = makeDb([]);
    const svc = new InvBarcodeService(db, { assertDispensable: jest.fn() } as never, UNRESTRICTED_WAREHOUSE_SCOPE as never);

    const result = await svc.lookup(ATTACKER, "user-attacker", "BARCODE-123");
    expect(result.type).toBe("not_found");
    expect(findFirst).toHaveBeenCalled();
    const arg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(arg?.where)).toContain(ATTACKER);
  });

  it("finds product for the owning org (isolation — control)", async () => {
    const PROD = { id: 1, orgId: OWNER, name: "Widget", sku: "W-001", status: "ACTIVE" };
    const { db } = makeDb([PROD]);
    const svc = new InvBarcodeService(db, { assertDispensable: jest.fn() } as never, UNRESTRICTED_WAREHOUSE_SCOPE as never);

    const result = await svc.lookup(OWNER, "user-owner", "BARCODE-123");
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
        ...INVENTORY_ISOLATION_STUBS,
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
        ...INVENTORY_ISOLATION_STUBS,
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
        ...INVENTORY_ISOLATION_STUBS,
        ImportService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
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
        ...INVENTORY_ISOLATION_STUBS,
        ImportService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: StockEngineService, useValue: { execute: jest.fn() } },
      ],
    }).compile().then((m) => m.get(ImportService));

    const result = await svc.list(OWNER, { page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
  });
});
