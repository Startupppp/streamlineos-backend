import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService } from "../../common/cache/cache.service";
import { WarehouseScopeService } from "./stock-engine/warehouse-scope.service";
import { INVENTORY_ISOLATION_STUBS } from "./__tests__/isolation-stubs";
import {
  makeIsolationDb,
  sqlValues,
  cacheStub,
  warehouseScopeStub,
} from "./__tests__/isolation-harness";
import { DockService } from "./dock/dock.service";
import { KitService } from "./kitting/kit.service";
import { ShelfLifeRulesService } from "./settings/shelf-life-rules.service";
import { WarehouseAssignmentsService } from "./warehouses/warehouse-assignments.service";
import { InventoryPeriodService } from "./valuation/inventory-period.service";
import { InspectionPlansService } from "./quality/inspection-plans.service";
import { AllocationOverrideReportService } from "./traceability/allocation-override-report.service";
import { InvAuditEventsService } from "./audit/inv-audit-events.service";
import { InventoryAccountingBridge } from "./stock-engine/accounting-bridge";

/**
 * Cross-tenant isolation for inventory services that had no negative test.
 *
 * ## What these assert, and why it is the predicate rather than the rows
 *
 * The database double answers the SAME rows to every read regardless of the org
 * asked for. That is deliberate: a double that returned [] for the wrong org
 * would make every service look isolated, including one that never mentions
 * org_id at all — the test would be measuring the double. So the assertion is
 * on the `where` clause the service actually built: the ATTACKER's org id must
 * be bound into it, and it is read out of the nested SQL tree by value rather
 * than by stringifying, because an id that merely appears in the SQL text tells
 * you nothing about which column it was bound to.
 *
 * Each service gets both directions — the attacker's scoping AND a control for
 * the owning org — because a service that hardcoded a constant, or bound the
 * wrong variable, would satisfy a single-org test.
 */

const OWNER = "org-owner";
const ATTACKER = "org-attacker";
const USER = "user-1";

/** A row belonging to the VICTIM, handed back no matter who asks. */
const VICTIM_ROW = { id: 1, orgId: OWNER, code: "OWNED-1" };

/** The same victim row, shaped for the relational read InspectionPlansService maps. */
const PLAN_ROW = { ...VICTIM_ROW, versions: [], productVariant: null, product: null, category: null };

/**
 * These services split between `db.select().where(...)` and the relational
 * `db.query.x.findMany({ where })`. Reading both is not laziness: asserting only
 * the style a service happens to use today would silently stop asserting
 * anything the day it is rewritten into the other one.
 */
function boundValues(selectWhere: jest.Mock, findMany: jest.Mock): unknown[] {
  return [
    ...selectWhere.mock.calls.flatMap((c) => sqlValues(c[0])),
    ...findMany.mock.calls.flatMap((c) => sqlValues(c[0])),
  ];
}

async function build<T>(cls: new (...args: never[]) => T, rows: unknown[], extra: unknown[] = []) {
  const harness = makeIsolationDb(rows);
  const moduleRef = await Test.createTestingModule({
    providers: [
      ...INVENTORY_ISOLATION_STUBS,
      cls,
      { provide: DRIZZLE, useValue: harness.db },
      { provide: CacheService, useValue: cacheStub() },
      { provide: WarehouseScopeService, useValue: warehouseScopeStub() },
      ...(extra as never[]),
    ],
  }).compile();
  return { svc: moduleRef.get(cls), ...harness };
}

describe("DockService — cross-tenant isolation", () => {
  it("scopes listDoors to the caller's org (isolation — deny)", async () => {
    const { svc, selectWhere } = await build(DockService, [VICTIM_ROW]);
    await svc.listDoors(ATTACKER, USER);
    const bound = sqlValues(selectWhere.mock.calls[0]?.[0]);
    expect(bound).toContain(ATTACKER);
    expect(bound).not.toContain(OWNER);
  });

  it("scopes listDoors to the owning org (isolation — control)", async () => {
    const { svc, selectWhere } = await build(DockService, [VICTIM_ROW]);
    await svc.listDoors(OWNER, USER);
    expect(sqlValues(selectWhere.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("KitService — cross-tenant isolation", () => {
  it("scopes getBom to the caller's org (isolation — deny)", async () => {
    const { svc, selectWhere } = await build(KitService, [VICTIM_ROW]);
    await svc.getBom(ATTACKER, 1);
    const bound = sqlValues(selectWhere.mock.calls[0]?.[0]);
    expect(bound).toContain(ATTACKER);
    expect(bound).not.toContain(OWNER);
  });

  it("scopes getBom to the owning org (isolation — control)", async () => {
    const { svc, selectWhere } = await build(KitService, [VICTIM_ROW]);
    await svc.getBom(OWNER, 1);
    expect(sqlValues(selectWhere.mock.calls[0]?.[0])).toContain(OWNER);
  });
});

describe("ShelfLifeRulesService — cross-tenant isolation", () => {
  it("scopes the rule list to the caller's org (isolation — deny)", async () => {
    const { svc, selectWhere, findMany } = await build(ShelfLifeRulesService, [VICTIM_ROW]);
    await svc.list(ATTACKER);
    const bound = [
      ...sqlValues(selectWhere.mock.calls[0]?.[0]),
      ...sqlValues(findMany.mock.calls[0]?.[0]),
    ];
    expect(bound).toContain(ATTACKER);
    expect(bound).not.toContain(OWNER);
  });
});

describe("WarehouseAssignmentsService — cross-tenant isolation", () => {
  it("scopes listAssignedUsers to the caller's org (isolation — deny)", async () => {
    const { svc, selectWhere, findMany } = await build(WarehouseAssignmentsService, [VICTIM_ROW]);
    await svc.listAssignedUsers(ATTACKER, 1, { page: 1, limit: 20 } as never);
    const bound = boundValues(selectWhere, findMany);
    expect(bound).toContain(ATTACKER);
    expect(bound).not.toContain(OWNER);
  });
});

describe("InventoryPeriodService — cross-tenant isolation", () => {
  it("scopes listPeriods to the caller's org (isolation — deny)", async () => {
    /**
     * `listPeriods` returns early when the accounting bridge reports no default
     * book, so the shared stub's `null` would make this pass without a query
     * ever being built — a green test measuring nothing. Given a book so the
     * scoping is actually exercised.
     */
    const { svc, selectWhere, findMany } = await build(InventoryPeriodService, [VICTIM_ROW], [
      {
        provide: InventoryAccountingBridge,
        useValue: {
          defaultBookId: jest.fn().mockResolvedValue("book-attacker"),
          hasPeriods: jest.fn().mockResolvedValue(true),
          hasJournals: jest.fn().mockResolvedValue(true),
        },
      },
    ]);
    await svc.listPeriods(ATTACKER);
    const bound = boundValues(selectWhere, findMany);
    expect(bound).toContain(ATTACKER);
    expect(bound).not.toContain(OWNER);
  });
});

describe("InspectionPlansService — cross-tenant isolation", () => {
  it("scopes the plan list to the caller's org (isolation — deny)", async () => {
    const { svc, selectWhere, findMany } = await build(InspectionPlansService, [PLAN_ROW]);
    await svc.list(ATTACKER, { page: 1, limit: 20 } as never);
    const bound = boundValues(selectWhere, findMany);
    expect(bound).toContain(ATTACKER);
    expect(bound).not.toContain(OWNER);
  });

  it("scopes the plan list to the owning org (isolation — control)", async () => {
    const { svc, selectWhere, findMany } = await build(InspectionPlansService, [PLAN_ROW]);
    await svc.list(OWNER, { page: 1, limit: 20 } as never);
    expect(boundValues(selectWhere, findMany)).toContain(OWNER);
  });
});

describe("AllocationOverrideReportService — cross-tenant isolation", () => {
  it("scopes the override report to the caller's org (isolation — deny)", async () => {
    const { svc, selectWhere, findMany } = await build(AllocationOverrideReportService, [VICTIM_ROW]);
    await svc.list(ATTACKER, { page: 1, limit: 20 } as never);
    const bound = boundValues(selectWhere, findMany);
    expect(bound).toContain(ATTACKER);
    expect(bound).not.toContain(OWNER);
  });
});

describe("InvAuditEventsService — cross-tenant isolation", () => {
  it("scopes the audit event list to the caller's org (isolation — deny)", async () => {
    const { svc, selectWhere, findMany } = await build(InvAuditEventsService, [VICTIM_ROW]);
    await svc.list(ATTACKER, { page: 1, limit: 20 } as never);
    const bound = boundValues(selectWhere, findMany);
    expect(bound).toContain(ATTACKER);
    expect(bound).not.toContain(OWNER);
  });

  it("scopes the audit event list to the owning org (isolation — control)", async () => {
    const { svc, selectWhere, findMany } = await build(InvAuditEventsService, [VICTIM_ROW]);
    await svc.list(OWNER, { page: 1, limit: 20 } as never);
    expect(boundValues(selectWhere, findMany)).toContain(OWNER);
  });
});
